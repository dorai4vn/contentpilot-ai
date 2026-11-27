import "server-only";

import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getSupabaseEnv } from "@/lib/env";
import { AGENT_ACTOR_HEADER } from "@/lib/supabase/server";
import { getPublisher } from "@/lib/publishing/registry";
import { PublisherSecret } from "@/lib/publishing/types";
import type { Database } from "@/types/database";
import { getTemporaryAutoWindow, sendTemporarySportsPost } from "./auto-delivery";
import { AUTO_PUBLISH_MAX_PER_RUN } from "./temporary-auto-publish";
import { assessSportsNews, writeSportsDraft } from "./editor";
import { collectSportsNews } from "./feeds";
import { dubaiDate, publishedToday, sportsArticleIsCurrent } from "./publication-day";
import { readSportsPhoto } from "./photo-snapshot";
import { findSportsPostPhoto } from "./licensed-photo";
import { findSourceSportsPhoto } from "./source-photo";
import { readReviewNoticeConfig, sendReviewNotices } from "./review-notices";
import { inspectTelegramSetup } from "./telegram-setup";
import { footballPriority, scoreSportsNews, selectSportsNews, SPORTS_SCORING_RUBRIC } from "./scoring";

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
    const image = await readSportsPhoto(client, delivery.post_id, delivery.post_version);
    const snapshot = {
      postId: delivery.post_id,
      postVersion: delivery.post_version,
      title: delivery.title,
      body: delivery.body,
      ...(image ? { image } : {}),
    };
    const stale = article.data !== null && !sportsArticleIsCurrent(article.data.assessment);
    const outcome = stale ? { ok: false as const, code: "stale_article" }
      : await adapter.publish(adapter.render(snapshot), {
      credentials: new PublisherSecret(tokens[delivery.destination_id]),
      targetRef: delivery.target_ref,
      idempotencyKey: delivery.idempotency_key,
    });
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
export async function runSportsDelivery(
  config: Config, now: () => number = Date.now, timeBudgetMs: number = DELIVERY_TIME_BUDGET_MS,
) {
  const notices = readReviewNoticeConfig();
  const client = await connectWorker(config);
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
  return { ...total, autoPublishActive: autoWindow !== null };
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
  const scoringResult = await client.from("sports_news_scoring_configs")
    .select("version,threshold,reach_weight,importance_weight,freshness_weight,fallback_mode")
    .eq("workspace_id", config.workspaceId).eq("project_id", config.projectId).maybeSingle();
  if (scoringResult.error) throw new Error("sports_news_scoring_config_failed");
  const scoring = scoringResult.data;
  const threshold = scoring?.threshold ?? config.threshold;
  const weights = scoring ? {
    reach: scoring.reach_weight / 100,
    eventImportance: scoring.importance_weight / 100,
    freshness: scoring.freshness_weight / 100,
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
  const feed = await collectSportsNews(now);
  const { unavailableSources } = feed;
  const articles = feed.articles.filter((item) => testDate
    ? item.publishedAt <= now && dubaiDate(item.publishedAt) === testDate
    : publishedToday(item.publishedAt, now));
  const report = { ...delivery, autoPublishActive: autoWindow !== null, autoPublishUntil: autoWindow?.ends_at ?? null, autoPublished: 0, autoPublishFailures: 0, feedsUnavailable: unavailableSources, assessed: 0, drafted: 0, itemFailures: 0 };
  if (!articles.length) return { ...report, ...await alert() };

  const seen = await client
    .from("sports_news_items")
    .select("source_url, headline_key")
    .eq("workspace_id", config.workspaceId)
    .eq("project_id", config.projectId)
    .gte("created_at", new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(800);
  if (seen.error) throw new Error("sports_news_history_failed");
  const urls = new Set(seen.data.map((item) => item.source_url));
  const headlines = new Set(seen.data.map((item) => item.headline_key));
  const prioritized = articles.map((item) => ({ item, priority: footballPriority(item.title, [item.summary, item.categories].filter(Boolean).join(" ")) }))
    .sort((a, b) => a.priority - b.priority || b.item.publishedAt - a.item.publishedAt);
  const candidates = [];
  for (const { item, priority } of prioritized) {
    const key = headlineKey(item.title);
    if (urls.has(item.url) || headlines.has(key)) continue;
    urls.add(item.url);
    headlines.add(key);
    candidates.push({ item, key, priority });
    if (candidates.length === (testDate ? 16 : 20)) break;
  }

  const assessments = await Promise.allSettled(candidates.map(async ({ item, key, priority }) => {
    const assessment = await assessSportsNews(item);
    return { item, key, priority, assessment, ...scoreSportsNews(assessment, item.publishedAt, now, weights) };
  }));
  const assessed = assessments.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  report.assessed = assessed.length;
  report.itemFailures = assessments.length - assessed.length;
  const selection = selectSportsNews(assessed, threshold, scoring?.fallback_mode ?? "highest");
  const fallback = !testDate && selection.fallback;
  const selected = testDate ? (selection.fallback ? [] : selection.selected.slice(0, 1)) : selection.selected;
  const selectedKeys = new Set(selected.map((entry) => entry.key));
  const decided = testDate ? selected : assessed.filter((entry) => entry.score < threshold || selectedKeys.has(entry.key));

  const saved = await Promise.allSettled(
    decided.map(async ({ item, key, priority, assessment, score, reach, freshness }) => {
      const decision = selectedKeys.has(key) ? (fallback ? "highest_below_threshold" : "threshold_met") : "below_threshold";
      const draft = selectedKeys.has(key) ? await writeSportsDraft(item) : null;
      const photo = draft ? await findSourceSportsPhoto(item)
        ?? (draft.photoSubject ? await findSportsPostPhoto(draft.photoSubject, draft.matchPhoto ?? undefined, draft.photoNeedsAction) : null) : null;
      if (!testDate && !publishedToday(item.publishedAt)) return null;
      const result = await client.rpc("record_sports_news_assessment", {
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
            reach, freshness,
          },
          title: item.title, photo: photo?.metadata ?? null, publishedAt: new Date(item.publishedAt).toISOString(),
        },
        p_destinations: destinations,
      });
      if (result.error) throw new Error("sports_news_record_failed");
      return result.data && draft
        ? { id: result.data, title: draft.title, body: draft.body, publishedAt: item.publishedAt } : null;
    }),
  );

  const drafts = saved.flatMap((item) => item.status === "fulfilled" && item.value ? [item.value] : []);
  report.drafted = drafts.length;
  if (autoWindow && autoTarget) {
    const sent = await Promise.allSettled(drafts.slice(0, AUTO_PUBLISH_MAX_PER_RUN).map((draft) =>
      sendTemporarySportsPost(client, autoTarget, tokens[autoTarget.destinationId], draft)));
    report.autoPublished = sent.filter((item) => item.status === "fulfilled" && item.value).length;
    report.autoPublishFailures = sent.length - report.autoPublished;
  }
  report.itemFailures += saved.filter((item) => item.status === "rejected").length;
  return { ...report, ...await alert() };
}
