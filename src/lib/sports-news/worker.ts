import "server-only";

import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getSupabaseEnv } from "@/lib/env";
import { AGENT_ACTOR_HEADER } from "@/lib/supabase/server";
import { getPublisher } from "@/lib/publishing/registry";
import { PublisherSecret } from "@/lib/publishing/types";
import type { Database } from "@/types/database";
import { assessSportsNews, writeSportsDraft } from "./editor";
import { collectSportsNews } from "./feeds";
import { readSportsPhoto } from "./photo-snapshot";
import { findLicensedSportsPhoto } from "./licensed-photo";
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

async function sendApproved(client: Client, config: Config, tokens: Config["tokens"]) {
  const destinations = Object.keys(tokens);
  if (!destinations.length) return { delivered: 0, deliveryFailures: 0 };
  const { data, error } = await client.rpc("claim_social_deliveries", {
    p_workspace_id: config.workspaceId,
    p_destinations: destinations,
  });
  if (error) throw new Error("sports_news_claim_failed");

  const results = await Promise.allSettled(data.map(async (delivery) => {
    const adapter = getPublisher(delivery.kind);
    const image = await readSportsPhoto(client, delivery.post_id, delivery.post_version);
    const snapshot = {
      postId: delivery.post_id,
      postVersion: delivery.post_version,
      title: delivery.title,
      body: delivery.body,
      ...(image ? { image: Uint8Array.from(Buffer.from(image, "base64")) } : {}),
    };
    const outcome = await adapter.publish(adapter.render(snapshot), {
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
    return outcome.ok;
  }));

  const delivered = results.filter((result) => result.status === "fulfilled" && result.value).length;
  return { delivered, deliveryFailures: results.length - delivered };
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

export async function runSportsNews(config: Config) {
  const notices = readReviewNoticeConfig();
  const client = await connectWorker(config);
  const tokens = { ...config.tokens };
  if (config.telegramDestinationId && !tokens[config.telegramDestinationId]) {
    const { data, error } = await client.from("publishing_destinations").select("id")
      .eq("workspace_id", config.workspaceId).eq("id", config.telegramDestinationId)
      .eq("kind", "telegram").eq("status", "active").maybeSingle();
    if (error || !data || !notices) throw new Error("sports_news_telegram_destination_unavailable");
    tokens[data.id] = notices.botToken;
  }
  const destinations = Object.keys(tokens);
  const delivery = await sendApproved(client, config, tokens);
  const alert = () => sendReviewNotices(client, config.workspaceId, config.projectId, notices);
  const now = Date.now();
  const { articles, unavailableSources } = await collectSportsNews(now);
  const report = { ...delivery, feedsUnavailable: unavailableSources, assessed: 0, drafted: 0, itemFailures: 0 };
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
  const prioritized = articles.map((item) => ({ item, priority: footballPriority(item.title, item.summary) }))
    .sort((a, b) => a.priority - b.priority || b.item.publishedAt - a.item.publishedAt);
  const candidates = [];
  for (const { item, priority } of prioritized) {
    const key = headlineKey(item.title);
    if (urls.has(item.url) || headlines.has(key)) continue;
    urls.add(item.url);
    headlines.add(key);
    candidates.push({ item, key, priority });
    if (candidates.length === 8) break;
  }

  const assessments = await Promise.allSettled(candidates.map(async ({ item, key, priority }) => {
    const assessment = await assessSportsNews(item);
    return { item, key, priority, assessment, ...scoreSportsNews(assessment, item.publishedAt, now) };
  }));
  const assessed = assessments.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  report.assessed = assessed.length;
  report.itemFailures = assessments.length - assessed.length;
  const { selected, fallback } = selectSportsNews(assessed, config.threshold);
  const selectedKeys = new Set(selected.map((entry) => entry.key));
  const decided = assessed.filter((entry) => entry.score < config.threshold || selectedKeys.has(entry.key));

  const saved = await Promise.allSettled(
    decided.map(async ({ item, key, priority, assessment, score, reach, freshness }) => {
      const decision = selectedKeys.has(key) ? (fallback ? "highest_below_threshold" : "threshold_met") : "below_threshold";
      const draft = selectedKeys.has(key) ? await writeSportsDraft(item) : null;
      const candidatePhoto = draft?.photoSubject ? await findLicensedSportsPhoto(draft.photoSubject) : null;
      const photo = candidatePhoto && draft &&
        draft.title.length + draft.body.length + candidatePhoto.attribution.length + 4 <= 1024
        ? candidatePhoto : null;
      const result = await client.rpc("record_sports_news_assessment", {
        p_workspace_id: config.workspaceId,
        p_project_id: config.projectId,
        p_source_url: item.url,
        p_headline_key: key,
        p_score: score,
        p_title: draft?.title ?? null,
        p_body: draft ? (photo ? `${draft.body}\n\n${photo.attribution}` : draft.body) : null,
        p_image: photo?.image ?? null,
        p_reason: draft ? `RSS · ${score}/10${fallback ? " · Cao nhất lượt quét, dưới ngưỡng" : ""} · ${assessment.reason}`.slice(0, 500) : null,
        p_assessment: {
          ...assessment, rubricVersion: SPORTS_SCORING_RUBRIC.version, reach, freshness, priority, decision,
          threshold: config.threshold, title: item.title, photo: photo?.metadata ?? null, publishedAt: new Date(item.publishedAt).toISOString(),
        },
        p_destinations: destinations,
      });
      if (result.error) throw new Error("sports_news_record_failed");
      return result.data;
    }),
  );

  report.drafted = saved.filter((item) => item.status === "fulfilled" && item.value !== null).length;
  report.itemFailures += saved.filter((item) => item.status === "rejected").length;
  return { ...report, ...await alert() };
}
