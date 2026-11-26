import { createHash } from "node:crypto";

import type { PublisherAdapter, PublishContext, PublishOutcome } from "../adapter";
import type { ApprovedSnapshot } from "../types";

type SocialKind = "telegram" | "discord" | "facebook";
type Payload = { text: string; titleLength: number; image: Uint8Array<ArrayBuffer> | undefined };

const targetPatterns = {
  telegram: /^-100[0-9]{5,18}$/,
  discord: /^[0-9]{5,25}$/,
  facebook: /^[0-9]{5,25}$/,
};

function attachImage(form: FormData, field: string, image: NonNullable<Payload["image"]>) {
  form.append(field, new Blob([image], { type: "image/jpeg" }), "sports-news.jpg");
}

function requestFor(kind: SocialKind, target: string, token: string, payload: Payload, key: string) {
  const form = new FormData();
  if (kind === "telegram") {
    if (!/^\d+:[\w-]+$/.test(token)) return null;
    form.set("chat_id", target);
    if (payload.titleLength > 0) {
      // Telegram entities use UTF-16 code units, as does JavaScript length.
      form.set(payload.image ? "caption_entities" : "entities",
        JSON.stringify([{ type: "bold", offset: 0, length: payload.titleLength }]));
    }
    if (payload.image) {
      form.set("caption", payload.text);
      attachImage(form, "photo", payload.image);
    } else {
      form.set("text", payload.text);
    }
    const method = payload.image ? "sendPhoto" : "sendMessage";
    return { url: `https://api.telegram.org/bot${token}/${method}`, body: form };
  }
  if (kind === "discord") {
    const message = JSON.stringify({
      content: payload.text,
      allowed_mentions: { parse: [] },
      nonce: createHash("sha256").update(key).digest("hex").slice(0, 24),
      enforce_nonce: true,
    });
    if (payload.image) {
      form.set("payload_json", message);
      attachImage(form, "files[0]", payload.image);
    }
    return {
      url: `https://discord.com/api/v10/channels/${target}/messages`,
      headers: {
        authorization: `Bot ${token}`,
        ...(payload.image ? {} : { "content-type": "application/json" }),
      },
      body: payload.image ? form : message,
    };
  }
  const version = process.env.FACEBOOK_GRAPH_VERSION || "v25.0";
  if (!/^v[0-9]+\.[0-9]+$/.test(version)) return null;
  form.set("message", payload.text);
  if (payload.image) attachImage(form, "source", payload.image);
  return {
    url: `https://graph.facebook.com/${version}/${target}/${payload.image ? "photos" : "feed"}`,
    headers: { authorization: `Bearer ${token}` },
    body: form,
  };
}

function failure(code: Exclude<PublishOutcome, { ok: true }>["code"], retryable = false): PublishOutcome {
  return { ok: false, code, retryable };
}

function externalId(kind: SocialKind, value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const response = value as { id?: unknown; post_id?: unknown; result?: { message_id?: unknown }; ok?: boolean };
  const result = kind === "telegram" ?
    (response.ok === true ? response.result?.message_id : undefined) : (response.post_id ?? response.id);
  if (typeof result === "number" && Number.isSafeInteger(result) && result > 0) return String(result);
  if (typeof result === "string" && /^[0-9_]{1,200}$/.test(result)) return result;
}

export function socialPublisher(kind: SocialKind): PublisherAdapter<Payload> {
  return {
    kind,
    execution: "async",
    validateTarget(target) {
      return target && targetPatterns[kind].test(target) ? { ok: true } : { ok: false, code: "invalid_target" };
    },
    render(snapshot: ApprovedSnapshot) {
      const title = snapshot.title.trim();
      const body = snapshot.body.trim();
      const headline = kind === "discord" && title ? `**${title.replace(/[\\*_~`|]/g, "\\$&")}**` : title;
      return {
        text: [headline, body].filter(Boolean).join("\n\n"),
        titleLength: title.length,
        image: snapshot.image,
      };
    },
    async publish(payload: Payload, context: PublishContext) {
      const { targetRef, credentials } = context;
      if (!targetRef || !targetPatterns[kind].test(targetRef)) return failure("invalid_target");
      if (!credentials) return failure("unauthorized");
      const limit = kind === "telegram" ? (payload.image ? 1024 : 4096) : kind === "discord" ? 2000 : 60_000;
      if (!payload.text || payload.text.length > limit) return failure("content_rejected");
      const request = requestFor(kind, targetRef, credentials.reveal(), payload, context.idempotencyKey);
      if (!request) return failure("unauthorized");
      try {
        const response = await fetch(request.url, {
          method: "POST",
          body: request.body,
          headers: request.headers,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 429) return failure("rate_limited", true);
        if (response.status === 401 || response.status === 403) return failure("unauthorized");
        if (response.status >= 400 && response.status < 500) return failure("content_rejected");
        if (!response.ok) return failure("delivery_unconfirmed");
        const id = externalId(kind, await response.json());
        return id ? { ok: true, externalId: id } : failure("delivery_unconfirmed");
      } catch {
        return failure("delivery_unconfirmed");
      }
    },
  };
}
