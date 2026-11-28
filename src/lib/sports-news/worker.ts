import "server-only";

import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getSupabaseEnv } from "@/lib/env";
import { AGENT_ACTOR_HEADER } from "@/lib/supabase/server";
import { getPublisher } from "@/lib/publishing/registry";
import { PublisherSecret } from "@/lib/publishing/types";
import type { Database, Json } from "@/types/database";
import { AutomationOffError, assertAutomationNotOff, readAutomationMode } from "./automation-mode";
import { getTemporaryAutoWindow, sendTemporarySportsPost } from "./auto-delivery";
import { AUTO_PUBLISH_MAX_PER_RUN } from "./temporary-auto-publish";
import { assessSportsNews, writeSportsDraft } from "./editor";
import { loadEventHistory } from "./event-history";
import { buildEventIdentity, buildEventPayload, classifyEvent, manualReviewReason, type EventDecision, type EventIdentity, type KnownEvent, type ManualReviewReason } from "./event-identity";
import { collectSportsNews } from "./feeds";
import { sportsFeeds } from "./sources";
import { dubaiDate, publishedToday, sportsArticleIsCurrent } from "./publication-day";
import { requireRssImage } from "./image-gate";
import { readSportsPhoto } from "./photo-snapshot";
import { findSportsPostPhoto } from "./licensed-photo";
import { findSourceSportsPhoto } from "./source-photo";
import { readReviewNoticeConfig, sendReviewNotices } from "./review-notices";
import { inspectTelegramSetup } from "./telegram-setup";
import { footballPriority, scoreSportsNews, selectSportsNews, SPORTS_NEWS_DRAFT_CALL_BUDGET, SPORTS_NEWS_OUTPUT_PER_SCAN, SPORTS_SCORING_RUBRIC } from "./scoring";

const configSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  email: z.email(),
  password: z.string().min(1),
  threshold: z.coerce.number().min(0).max(10),
  telegramDestinationId: z.uuid().optional(),
  tokens: z.record(z.uuid(), z.string().trim().min(1).regex(/^[!-~]+$/))
    .refine((tokens) => Object.keys(tokens).length <= 12),
});

type Config = z.infer<typeof configSchema>;
type Client = SupabaseClient<Database>;

export function readSportsNewsConfig(): Config {
  return configSchema.parse({
    workspaceId: process.env.SPORTS_NEWS_WORKSPACE_ID,
    projectId: process.env.SPORTS_NEWS_PROJECT_ID,
    email: process.env.SPORTS_NEWS_WORKER_EMAIL,
    password: process.env.SPORTS_NEWS_WORKER_PASSWORD,
    telegramDestinationId: process.env.SPORTS_NEWS_TELEGRAM_DESTINATION_ID?.trim() || undefined,
    threshold: process.env.SPORTS_NEWS_MIN_SCORE?.trim() || "8",
    tokens: JSON.parse(process.env.SPORTS_NEWS_SOCIAL_TOKENS || "{}"),
  });
}

function headlineKey(title: string): string {
  const normalized = title.toLocaleLowerCase("vi").normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/** The claim RPC hands out at most this many rows per call (see claim_social_deliveries). */
export const DELIVERY_CLAIM_BATCH = 6;
/** Delivery-only runs: bounded rounds and wall-clock so one request can never run away. */
export const DELIVERY_MAX_ROUNDS = 5;
export const DELIVERY_TIME_BUDGET_MS = 100_000;
/** Post-approval dispatch runs inside the server action's function (after()), so it gets a much smaller budget. */
export const DISPATCH_TIME_BUDGET_MS = 40_000;

async function sendApproved(client: Client, config: Config, tokens: Config["tokens"]) {
  const destinations = Object.keys(tokens);
  if (!destinations.length) return { claimed: 0, delivered: 0, deliveryFailures: 0, staleSkipped: 0 };
  const { data, error } = await client.rpc("claim_social_deliveries", {
    p_workspace_id: config.workspaceId,
    p_destinations: destinations,
  });
  if (error) throw new Error("sports_news_claim_failed");

  const results = await Promise.allSettled(data.map(async (delivery) => {
    const article = await client.from("sports_news_items").select("assessment")
      .eq("workspace_id", config.workspaceId).eq("post_id", delivery.post_id).maybeSingle();
    if (article.error) throw new Error("sports_news_assessment_read_failed");
    const adapter = getPublisher(delivery.kind);
    // FN11-B: an RSS sports post (it has a sports_news_items row) is never delivered without a valid image.
    // Manual non-RSS content (no row) keeps its existing workflow. Applies to approved, retried and legacy queued rows.
    const isRss = article.data !== null;
    const gate = isRss ? await requireRssImage(client, delivery.post_id, delivery.post_version) : null;
    const stale = article.data !== null && !sportsArticleIsCurrent(article.data.assessment);
    let outcome: { ok: true; externalId: string | null } | { ok: false; code: string };
    if (stale) outcome = { ok: false, code: "stale_article" };
    else if (gate && !gate.ok) outcome = { ok: false, code: gate.code };
    else {
      const image = gate?.ok ? gate.image : await readSportsPhoto(client, delivery.post_id, delivery.post_version).catch(() => null);
      outcome = await adapter.publish(adapter.render({
        postId: delivery.post_id, postVersion: delivery.post_version, title: delivery.title, body: delivery.body,
        ...(image ? { image } : {}),
      }), {
        credentials: new PublisherSecret(tokens[delivery.destination_id]),
        targetRef: delivery.target_ref,
        idempotencyKey: delivery.idempotency_key,
      });
    }
    const completion = await client.rpc("finish_social_delivery", {
      p_workspace_id: config.workspaceId,
      p_id: delivery.id,
      p_external_id: outcome.ok ? outcome.externalId : null,
      p_error_code: outcome.ok ? null : outcome.code,
    });
    if (completion.error || !completion.data) throw new Error("sports_news_finish_failed");
    return stale ? "stale" : outcome.ok;
  }));

  const delivered = results.filter((result) => result.status === "fulfilled" && result.value === true).length;
  const staleSkipped = results.filter((result) => result.status === "fulfilled" && result.value === "stale").length;
  return { claimed: data.length, delivered, staleSkipped, deliveryFailures: results.length - delivered - staleSkipped };
}

/** Resolves the destination tokens for this worker (env tokens + the configured Telegram destination). */
async function resolveTokens(client: Client, config: Config, notices: ReturnType<typeof readReviewNoticeConfig>) {
  const tokens = { ...config.tokens };
  if (config.telegramDestinationId && !tokens[config.telegramDestinationId]) {
    const { data, error } = await client.from("publishing_destinations").select("id")
      .eq("workspace_id", config.workspaceId).eq("id", config.telegramDestinationId)
      .eq("kind", "telegram").eq("status", "active").maybeSingle();
    if (error || !data || !notices) throw new Error("sports_news_telegram_destination_unavailable");
    tokens[data.id] = notices.botToken;
  }
  return tokens;
}

/**
 * Delivery-only run: sends already-approved deliveries (exact approved version,
 * claimed atomically by claim_social_deliveries with FOR UPDATE SKIP LOCKED, so
 * concurrent runs never claim the same row). It never reads RSS, never calls the
 * LLM, never drafts, and never creates or approves anything. While a temporary
 * auto-publish window owns the Telegram destination that destination is left to
 * it, exactly as in the full run. Bounded by DELIVERY_MAX_ROUNDS and a time budget.
 */
/**
 * FN10: best-effort retention of the Auto Post operation history (hidden rows older than 30 days). Runs on every
 * scheduler tick BEFORE the Off check, so cleanup is independent of the Auto Post mode. Scoped to the worker's
 * workspace/project by the database; touches no publishing/delivery data; no external or AI calls. Never fails a run.
 */
async function purgeAutomationHistory(client: Awaited<ReturnType<typeof connectWorker>>, config: Config) {
  try {
    await client.rpc("purge_sports_automation_history", { p_workspace_id: config.workspaceId, p_project_id: config.projectId });
  } catch {
    // retention is housekeeping only
  }
}

export async function runSportsDelivery(
  config: Config, now: () => number = Date.now, timeBudgetMs: number = DELIVERY_TIME_BUDGET_MS,
) {
  const notices = readReviewNoticeConfig();
  const client = await connectWorker(config);
  await purgeAutomationHistory(client, config);
  // FN08: Off stops delivery before any claim or external call.
  if (await readAutomationMode(client, config.workspaceId, config.projectId) === "off") {
    return { rounds: 0, claimed: 0, delivered: 0, deliveryFailures: 0, staleSkipped: 0, truncated: false, autoPublishActive: false, mode: "off" as const, skipped: "automation_off" as const };
  }
  const tokens = await resolveTokens(client, config, notices);
  const telegramId = config.telegramDestinationId;
  const autoTarget = telegramId && tokens[telegramId]
    ? { workspaceId: config.workspaceId, projectId: config.projectId, destinationId: telegramId } : null;
  const autoWindow = autoTarget ? await getTemporaryAutoWindow(client, autoTarget) : null;
  const approvedTokens = { ...tokens };
  if (autoWindow && autoTarget) delete approvedTokens[autoTarget.destinationId];

  const total = { rounds: 0, claimed: 0, delivered: 0, deliveryFailures: 0, staleSkipped: 0, truncated: false };
  const started = now();
  for (;;) {
    if (total.rounds >= DELIVERY_MAX_ROUNDS || now() - started >= timeBudgetMs) {
      total.truncated = true;
      break;
    }
    const round = await sendApproved(client, config, approvedTokens);
    total.rounds += 1;
    total.claimed += round.claimed;
    total.delivered += round.delivered;
    total.deliveryFailures += round.deliveryFailures;
    total.staleSkipped += round.staleSkipped;
    if (round.claimed < DELIVERY_CLAIM_BATCH) break;
  }
  return { ...total, autoPublishActive: autoWindow !== null, mode: "on" as const, skipped: null };
}

async function connectWorker(config: Config) {
  const env = getSupabaseEnv();
  const client = createClient<Database>(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { [AGENT_ACTOR_HEADER]: "agent" },
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    },
  });
  const { error } = await client.auth.signInWithPassword({ email: config.email, password: config.password });
  if (error) throw new Error("sports_news_worker_auth_failed");

  return client;
}

export async function checkSportsNewsSetup(config: Config, channelUsername?: string) {
  const client = await connectWorker(config);
  const notices = readReviewNoticeConfig();
  const { data, error } = await client.from("content_projects").select("id")
    .eq("workspace_id", config.workspaceId).eq("id", config.projectId).is("archived_at", null).maybeSingle();
  if (error || !data) throw new Error("sports_news_project_unavailable");
  return {
    workerReady: true,
    telegram: notices ? await inspectTelegramSetup(notices.botToken, notices.chatId, channelUsername) : null,
  };
}

export async function runSportsNews(config: Config, testDate?: string) {
  const notices = readReviewNoticeConfig();
  const client = await connectWorker(config);
  await purgeAutomationHistory(client, config);
  // FN08: Off stops RSS, AI, image processing, review notices and delivery before any external call.
  if (await readAutomationMode(client, config.workspaceId, config.projectId) === "off") {
    return { mode: "off" as const, skipped: "automation_off" as const, claimed: 0, delivered: 0, deliveryFailures: 0, staleSkipped: 0, autoPublishActive: false, autoPublishUntil: null, autoPublished: 0, autoPublishFailures: 0, semanticDuplicates: 0, followUps: 0, eventEvidenceFailures: 0, feedsUnavailable: [] as string[], assessed: 0, drafted: 0, itemFailures: 0 };
  }
  // FN09 scan gate (DB-side, row-locked): a tick before the configured interval, a concurrent tick or an
  // unconfigured project does no RSS/AI/image work. Approved deliveries still flow via the delivery-only run.
  // Manual test runs (testDate) never touch the cadence.
  let postsPerScan = SPORTS_NEWS_OUTPUT_PER_SCAN;
  if (!testDate) {
    const gate = await client.rpc("begin_sports_scan", { p_workspace_id: config.workspaceId, p_project_id: config.projectId });
    if (gate.error || !gate.data?.[0]) throw new Error("sports_news_scan_gate_failed");
    if (!gate.data[0].due) {
      const deliveryOnly = await runSportsDelivery(config);
      return { autoPublishUntil: null, autoPublished: 0, autoPublishFailures: 0, semanticDuplicates: 0, followUps: 0, eventEvidenceFailures: 0, feedsUnavailable: [] as string[], assessed: 0, drafted: 0, itemFailures: 0, ...deliveryOnly, mode: deliveryOnly.mode, skipped: "scan_not_due" as const };
    }
    postsPerScan = gate.data[0].posts_per_scan;
  }
  const scoringResult = await client.from("sports_news_scoring_configs")
    .select("version,threshold,reach_weight,importance_weight,freshness_weight,engagement_weight,fallback_mode")
    .eq("workspace_id", config.workspaceId).eq("project_id", config.projectId).maybeSingle();
  if (scoringResult.error) throw new Error("sports_news_scoring_config_failed");
  const scoring = scoringResult.data;
  const threshold = scoring?.threshold ?? config.threshold;
  const weights = scoring ? {
    reach: scoring.reach_weight / 100,
    eventImportance: scoring.importance_weight / 100,
    freshness: scoring.freshness_weight / 100,
    engagement: scoring.engagement_weight / 100,
  } : SPORTS_SCORING_RUBRIC.weights;
  const tokens = { ...config.tokens };
  if (config.telegramDestinationId && !tokens[config.telegramDestinationId]) {
    const { data, error } = await client.from("publishing_destinations").select("id")
      .eq("workspace_id", config.workspaceId).eq("id", config.telegramDestinationId)
      .eq("kind", "telegram").eq("status", "active").maybeSingle();
    if (error || !data || !notices) throw new Error("sports_news_telegram_destination_unavailable");
    tokens[data.id] = notices.botToken;
  }
  const destinations = testDate
    ? Object.keys(tokens).filter((id) => id === config.telegramDestinationId)
    : Object.keys(tokens);
  if (testDate && destinations.length !== 1) throw new Error("sports_news_test_destination_required");
  const telegramId = config.telegramDestinationId;
  const autoTarget = !testDate && telegramId && tokens[telegramId]
    ? { workspaceId: config.workspaceId, projectId: config.projectId, destinationId: telegramId } : null;
  const autoWindow = autoTarget ? await getTemporaryAutoWindow(client, autoTarget) : null;
  const approvedTokens = { ...tokens };
  if (autoWindow && autoTarget) delete approvedTokens[autoTarget.destinationId];
  const delivery = await sendApproved(client, config, testDate ? {} : approvedTokens);
  const alert = () => sendReviewNotices(client, config.workspaceId, config.projectId, notices);
  const now = Date.now();
  // FN09 scan outcome: a collection that throws or finds EVERY feed unavailable is a transient failure (the DB gate then
  // allows a bounded retry on a later scheduler tick); a successful scan with no matching articles is not a failure.
  // The outcome is recorded before any AI/delivery work, so a retry can never repeat AI calls or deliveries.
  const reportScan = async (ok: boolean) => { if (!testDate) await client.rpc("finish_sports_scan", { p_workspace_id: config.workspaceId, p_project_id: config.projectId, p_ok: ok }); };
  let feed: Awaited<ReturnType<typeof collectSportsNews>>;
  try { feed = await collectSportsNews(now); } catch (error) { await reportScan(false).catch(() => undefined); throw error; }
  const { unavailableSources } = feed;
  const scanFailed = unavailableSources.length >= sportsFeeds.length;
  await reportScan(!scanFailed);
  const articles = feed.articles.filter((item) => testDate
    ? item.publishedAt <= now && dubaiDate(item.publishedAt) === testDate
    : publishedToday(item.publishedAt, now));
  const report = { mode: "on" as "on" | "stopped", skipped: null as "automation_off" | null, ...delivery, autoPublishActive: autoWindow !== null, autoPublishUntil: autoWindow?.ends_at ?? null, persistentAuto: autoWindow?.persistent ?? false, autoPublished: 0, autoPublishFailures: 0, semanticDuplicates: 0, followUps: 0, eventEvidenceFailures: 0, feedsUnavailable: unavailableSources, scanFailed, assessed: 0, drafted: 0, itemFailures: 0 };
  if (!articles.length) return { ...report, ...await alert() };

  const seen = await client
    .from("sports_news_items")
    .select("source_url, headline_key, event_identity, post_id, assessment, created_at")
    .eq("workspace_id", config.workspaceId)
    .eq("project_id", config.projectId)
    .gte("created_at", new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(800);
  if (seen.error) throw new Error("sports_news_history_failed");
  const urls = new Set(seen.data.map((item) => item.source_url));
  const headlines = new Set(seen.data.map((item) => item.headline_key));
  // Only events that became an actual, non-archived, non-rejected post may suppress a later report.
  // Low-score, failed, unselected or merely discovered items never do.
  const history = await loadEventHistory(client, config.workspaceId, seen.data);
  const knownEvents: KnownEvent[] = history.blocking;
  const skippedEvents: { url: string; key: string; identity: EventIdentity; verdict: EventDecision }[] = [];
  const prioritized = articles.map((item) => ({ item, priority: footballPriority(item.title, [item.summary, item.categories].filter(Boolean).join(" ")) }))
    .sort((a, b) => a.priority - b.priority || b.item.publishedAt - a.item.publishedAt);
  const candidates: { item: (typeof articles)[number]; key: string; priority: number; identity: EventIdentity; verdict: EventDecision; reconsidered: boolean }[] = [];
  for (const { item, priority } of prioritized) {
    const key = headlineKey(item.title);
    if (urls.has(item.url) || headlines.has(key)) continue;
    // Semantic check (FN05): same real-world event as an already accepted post is skipped with evidence;
    // a meaningful follow-up (result after preview, firmer status, changed score) continues as a linked
    // candidate. Candidates of this run never block each other here: that is decided after scoring.
    const identity = buildEventIdentity(item);
    const verdict = classifyEvent(identity, knownEvents);
    if (verdict.decision === "duplicate") {
      if (skippedEvents.length < 30) skippedEvents.push({ url: item.url, key, identity, verdict });
      report.semanticDuplicates += 1;
      continue;
    }
    if (verdict.decision === "follow_up") report.followUps += 1;
    urls.add(item.url);
    headlines.add(key);
    // A post of this event that was archived/rejected without ever being sent no longer blocks, but a report
    // of the same event is then reconsidered by a human only (never through the auto-publish window).
    const reconsidered = identity.subjectKind !== "unresolved" && classifyEvent(identity, history.reconsidered).decision !== "new";
    candidates.push({ item, key, priority, identity, verdict, reconsidered });
    if (candidates.length === (testDate ? 16 : 20)) break;
  }

  // Safe checkpoint: nothing has been sent to the AI yet. A late Off switch ends the run without any AI call.
  try { await assertAutomationNotOff(client, config.workspaceId, config.projectId); } catch (error) {
    if (error instanceof AutomationOffError) return { ...report, mode: "stopped" as const, skipped: "automation_off" as const };
    throw error;
  }
  const assessments = await Promise.allSettled(candidates.map(async ({ item, key, priority, identity, verdict, reconsidered }) => {
    const assessment = await assessSportsNews(item);
    return { item, key, priority, identity, verdict, reconsidered, assessment, ...scoreSportsNews(assessment, item.publishedAt, now, weights) };
  }));
  const assessed = assessments.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  report.assessed = assessed.length;
  report.itemFailures = assessments.length - assessed.length;
  // Same-run duplicates: the highest-scoring report of an event leads; weaker rewrites of it never take a slot
  // and can never suppress a stronger one (ranking happens AFTER scoring). A weaker report is only an alternate:
  // it is persisted as a skip only once its event really became a post, so a failed or unselected lead never
  // costs the event its alternates (they stay eligible for the bounded same-run fallback and for the next run).
  type Scored = (typeof assessed)[number];
  const accepted: KnownEvent[] = [];
  const leads: Scored[] = [];
  const alternates = new Map<string, Scored[]>();
  for (const entry of [...assessed].sort((a, b) => b.score - a.score || a.priority - b.priority)) {
    const verdict = classifyEvent(entry.identity, accepted);
    if (verdict.decision === "duplicate") {
      const lead = leads.find((candidate) => candidate.item.url === verdict.matched.sourceUrl);
      if (lead) {
        alternates.set(lead.key, [...(alternates.get(lead.key) ?? []), { ...entry, verdict: { ...verdict, reasons: [{ code: "same_run_weaker_report" }, ...verdict.reasons] } }]);
        continue;
      }
    }
    // A same-run follow-up (e.g. the result scored below its preview) is linked to the lead it extends.
    if (verdict.decision === "follow_up") entry.verdict = { ...verdict, reasons: [{ code: "same_run_follow_up" }, ...verdict.reasons] };
    accepted.push({ identity: entry.identity, sourceUrl: entry.item.url, title: entry.item.title, origin: "stored" });
    leads.push(entry);
  }
  const selection = selectSportsNews(leads, threshold, scoring?.fallback_mode ?? "highest", postsPerScan);
  const fallback = !testDate && selection.fallback;
  const selected = testDate ? (selection.fallback ? [] : selection.selected.slice(0, 1)) : selection.selected;
  const selectedKeys = new Set(selected.map((entry) => entry.key));

  const evidence = await Promise.allSettled(skippedEvents.map(({ url, key, identity, verdict }) =>
    client.rpc("record_sports_news_event_duplicate", {
      p_workspace_id: config.workspaceId,
      p_project_id: config.projectId,
      p_source_url: url,
      p_headline_key: key,
      p_event: buildEventPayload(identity, verdict) as unknown as Json,
    })));
  // Evidence failures are reported, never swallowed.
  report.eventEvidenceFailures = evidence.filter((entry) => entry.status === "rejected" || entry.value.error).length;
  report.itemFailures += report.eventEvidenceFailures;

  type Saved = { id: string; title: string; body: string; publishedAt: number; manual: ManualReviewReason | null };
  // Existing AI budget: never more draft calls than one run could already make (SPORTS_NEWS_DRAFT_CALL_BUDGET), separate from the 3-post output cap.
  let draftCalls = 0;
  const reportOf = (entry: Scored) => manualReviewReason(entry.identity, entry.verdict, entry.reconsidered);
  const record = async (entry: Scored, materialize: boolean): Promise<Saved | null> => {
    const { item, key, priority, identity, verdict, assessment, score, reach, freshness } = entry;
    const decision = materialize ? (fallback ? "highest_below_threshold" : "threshold_met") : "below_threshold";
    let draft = null;
    if (materialize) {
      await assertAutomationNotOff(client, config.workspaceId, config.projectId);
      draftCalls += 1;
      draft = await writeSportsDraft(item);
      await assertAutomationNotOff(client, config.workspaceId, config.projectId);
    }
    const photo = draft ? await findSourceSportsPhoto(item)
      ?? (draft.photoSubject ? await findSportsPostPhoto(draft.photoSubject, draft.matchPhoto ?? undefined, draft.photoNeedsAction) : null) : null;
    if (!testDate && !publishedToday(item.publishedAt)) return null;
    const manual = reportOf(entry);
    const result = await client.rpc("record_sports_news_event_assessment", {
      p_workspace_id: config.workspaceId,
      p_project_id: config.projectId,
      p_source_url: item.url,
      p_headline_key: key,
      p_score: score,
      p_title: draft?.title ?? null,
      p_body: draft?.body ?? null,
      p_image: photo?.image ?? null,
      p_reason: draft ? `${testDate ? "Đăng thử Telegram · " : ""}RSS · ${score}/10${fallback ? " · Cao nhất lượt quét, dưới ngưỡng" : ""} · ${assessment.reason}`.slice(0, 500) : null,
      p_assessment: {
        ...assessment, rubricVersion: SPORTS_SCORING_RUBRIC.version, reach, freshness, priority, decision,
        ...(testDate ? { testPublishUntil: new Date(now + 24 * 60 * 60 * 1000).toISOString() } : {}),
        threshold, scoringVersion: scoring?.version ?? 0, weights, components: {
          playerPopularity: assessment.playerPopularity, teamPopularity: assessment.teamPopularity,
          competitionPopularity: assessment.competitionPopularity, eventImportance: assessment.eventImportance,
          engagement: assessment.engagement,
          reach, freshness,
        },
        title: item.title, photo: photo?.metadata ?? null, publishedAt: new Date(item.publishedAt).toISOString(),
      },
      p_destinations: destinations,
      p_event: buildEventPayload(identity, verdict, manual) as unknown as Json,
    });
    if (result.error) throw new Error("sports_news_record_failed");
    return result.data && draft
      ? { id: result.data, title: draft.title, body: draft.body, publishedAt: item.publishedAt, manual } : null;
  };

  // Settles one selected event: the lead first, then (only if the lead FAILED before a post existed) its
  // alternates in rank order, within the draft budget. A null result (stale or database-rejected duplicate) is a
  // legitimate outcome, not a failure, and never triggers a fallback.
  const settle = async (lead: Scored): Promise<{ saved: Saved | null; failed: boolean; used: Scored | null }> => {
    const queue = [lead, ...(alternates.get(lead.key) ?? []).filter((alt) => alt.score >= threshold || fallback)];
    let failed = false;
    for (const [index, entry] of queue.entries()) {
      if (index > 0 && draftCalls >= SPORTS_NEWS_DRAFT_CALL_BUDGET) break;
      try {
        return { saved: await record(entry, true), failed: false, used: entry };
      } catch (error) {
        if (error instanceof AutomationOffError) { report.mode = "stopped"; report.skipped = "automation_off"; break; }
        failed = true;
        report.itemFailures += 1;
      }
    }
    return { saved: null, failed, used: null };
  };
  const settled = await Promise.all(selected.map(settle));
  // Off arrived mid-run: stop at this checkpoint (no further AI, image, notice or delivery work).
  if (report.mode === "stopped") return { ...report, drafted: settled.filter((entry) => entry.saved).length };
  const usedKeys = new Set(settled.flatMap((entry) => entry.used ? [entry.used.key] : []));
  const materializedLeads = new Set(selected.filter((_, index) => !settled[index].failed).map((entry) => entry.key));

  // Weaker reports are persisted as skips only for an event that really became a post (or already was one).
  const lateSkips: typeof skippedEvents = [];
  for (const lead of leads) {
    if (!materializedLeads.has(lead.key)) continue;
    for (const alt of alternates.get(lead.key) ?? []) {
      if (usedKeys.has(alt.key)) continue;
      report.semanticDuplicates += 1;
      if (lateSkips.length < 30) lateSkips.push({ url: alt.item.url, key: alt.key, identity: alt.identity, verdict: alt.verdict });
    }
  }
  const lateEvidence = await Promise.allSettled(lateSkips.map(({ url, key, identity, verdict }) =>
    client.rpc("record_sports_news_event_duplicate", {
      p_workspace_id: config.workspaceId, p_project_id: config.projectId, p_source_url: url, p_headline_key: key,
      p_event: buildEventPayload(identity, verdict) as unknown as Json,
    })));
  const lateFailures = lateEvidence.filter((entry) => entry.status === "rejected" || entry.value.error).length;
  report.eventEvidenceFailures += lateFailures;
  report.itemFailures += lateFailures;

  // Low-score reports are recorded without a post (never blocking). A used fallback alternate is already recorded.
  const lows = assessed.filter((entry) => entry.score < threshold && !selectedKeys.has(entry.key) && !usedKeys.has(entry.key));
  const lowResults = await Promise.allSettled(lows.map((entry) => record(entry, false)));

  const drafts = settled.flatMap((entry) => entry.saved ? [entry.saved] : []);
  report.drafted = drafts.length;
  if (autoWindow && autoTarget) {
    // Only regular eligible drafts may be auto-published. Unresolved identities, follow-ups, uncertain facts and
    // reconsidered (previously archived/rejected) events are manual review only; the database enforces it too.
    // Persistent Auto (owner-approved FN08) also permits those; confirmed duplicates never become drafts.
    const eligible = autoWindow.persistent ? drafts : drafts.filter((draft) => draft.manual === null);
    const sent = await Promise.allSettled(eligible.slice(0, autoWindow.persistent ? postsPerScan : AUTO_PUBLISH_MAX_PER_RUN).map((draft) =>
      sendTemporarySportsPost(client, autoTarget, tokens[autoTarget.destinationId], draft)));
    report.autoPublished = sent.filter((item) => item.status === "fulfilled" && item.value).length;
    report.autoPublishFailures = sent.length - report.autoPublished;
  }
  report.itemFailures += lowResults.filter((item) => item.status === "rejected").length;
  return { ...report, ...await alert() };
}
