"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import {
  type AgentApiAction,
  type AgentCallErrorKind,
  type ChatTurnMessage,
  browserTimeZone,
  buildAgentRequest,
  callAgent,
  isPartialResult,
} from "@/lib/agent/client";
import { STOP_REASON_LABELS } from "@/lib/agent/labels";
import { AGENT_CHAT_LIMITS } from "@/lib/validation/agent";

import { ActionList, apiActionToView } from "./agent-actions";
import { FieldLabel, Notice, buttonClass, inputClass } from "./ui";

/**
 * Chat with the AI assistant. The conversation lives only in this browser tab
 * (sessionStorage); nothing of it is stored in the database. "Actions
 * performed" come from the server response, never from the assistant's text.
 */

export type ChatEntry =
  | { id: string; role: "user"; content: string }
  | {
      id: string;
      role: "assistant";
      content: string;
      actions: AgentApiAction[];
      stopReason: string;
      partial: boolean;
    }
  | { id: string; role: "error"; content: string; kind: AgentCallErrorKind };

export const AGENT_SUGGESTIONS = [
  "Liệt kê các dự án trong không gian làm việc này",
  "Liệt kê các bài viết bản nháp của dự án đang chọn",
  "Viết một bài nháp giới thiệu sản phẩm mới, khoảng 150 từ",
  "Đọc bài viết bản nháp gần nhất và rút gọn nội dung cho súc tích hơn",
];

const storageKey = (workspaceId: string) => `contentpilot:agent-chat:${workspaceId}`;
const newId = () => Math.random().toString(36).slice(2);

function loadChat(workspaceId: string): ChatEntry[] {
  try {
    const raw = sessionStorage.getItem(storageKey(workspaceId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ChatEntry[]).slice(-50) : [];
  } catch {
    return [];
  }
}

function saveChat(workspaceId: string, entries: ChatEntry[]) {
  try {
    sessionStorage.setItem(storageKey(workspaceId), JSON.stringify(entries.slice(-50)));
  } catch {
    // Private mode / storage full: the chat simply is not kept on reload.
  }
}

/** History sent to the API: user and assistant texts only (no errors, no actions). */
export function historyForApi(entries: ChatEntry[]): ChatTurnMessage[] {
  return entries
    .filter((e): e is Extract<ChatEntry, { role: "user" | "assistant" }> => e.role === "user" || e.role === "assistant")
    .map((e) => ({ role: e.role, content: e.content }));
}

export type AgentChatProps = {
  workspaceId: string;
  projects: { id: string; name: string }[];
  initialProjectId: string | null;
};

export function AgentChat({ workspaceId, projects, initialProjectId }: AgentChatProps) {
  const router = useRouter();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? "");
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();

  // Restore the session chat after mount (sessionStorage is browser-only).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from browser storage
    setEntries(loadChat(workspaceId));
    setHydrated(true);
  }, [workspaceId]);

  useEffect(() => {
    if (hydrated) saveChat(workspaceId, entries);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [entries, hydrated, workspaceId]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const trimmed = text.trim();
  const canSend = !pending && cooldown === 0 && trimmed.length > 0 && trimmed.length <= AGENT_CHAT_LIMITS.maxMessageLength;

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    const question = trimmed;
    const body = buildAgentRequest({
      workspaceId,
      projectId: projectId || null,
      history: historyForApi(entries),
      text: question,
      timeZone: browserTimeZone(),
    });
    setEntries((prev) => [...prev, { id: newId(), role: "user", content: question }]);
    setText("");
    setPending(true);

    const result = await callAgent(body);
    setPending(false);

    if (result.ok) {
      const { reply, actions, stopReason } = result.data;
      setEntries((prev) => [
        ...prev,
        { id: newId(), role: "assistant", content: reply, actions, stopReason, partial: isPartialResult(result.data) },
      ]);
      if (actions.length > 0) router.refresh(); // reload "Recent AI activity" from agent_actions
    } else {
      if (result.kind === "rate_limited") setCooldown(result.retryAfterSeconds ?? 30);
      setEntries((prev) => [...prev, { id: newId(), role: "error", content: result.message, kind: result.kind }]);
    }
    inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  function resetChat() {
    setEntries([]);
    inputRef.current?.focus();
  }

  return (
    <div className="flex flex-col gap-4" data-testid="agent-chat">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full sm:max-w-xs">
          <FieldLabel htmlFor={`${inputId}-project`}>Dự án (không bắt buộc)</FieldLabel>
          <select
            id={`${inputId}-project`}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className={inputClass}
            data-testid="agent-project-select"
          >
            <option value="">Tất cả dự án</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {entries.length > 0 ? (
          <button type="button" onClick={resetChat} className={buttonClass.ghost} disabled={pending} data-testid="agent-reset">
            Cuộc trò chuyện mới
          </button>
        ) : null}
      </div>

      <div
        ref={listRef}
        className="flex max-h-[60vh] min-h-64 flex-col gap-4 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4 dark:border-slate-800 dark:bg-slate-900/40"
        aria-live="polite"
        data-testid="agent-messages"
      >
        {entries.length === 0 ? (
          <div className="m-auto max-w-md py-6 text-center" data-testid="agent-empty">
            <p className="font-medium">Bạn muốn Trợ lý AI giúp gì?</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Trợ lý có thể đọc dự án và bài viết, tạo bài nháp mới và chỉnh sửa bài đang ở trạng thái Bản nháp.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2" data-testid="agent-suggestions">
              {AGENT_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setText(s);
                    inputRef.current?.focus();
                  }}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-left text-sm text-slate-700 hover:border-indigo-300 hover:bg-indigo-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          entries.map((entry) => <ChatBubble key={entry.id} entry={entry} workspaceId={workspaceId} />)
        )}
        {pending ? (
          <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400" role="status" data-testid="agent-pending">
            <span className="inline-flex gap-1" aria-hidden>
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-400" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-400 [animation-delay:120ms]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-400 [animation-delay:240ms]" />
            </span>
            Trợ lý đang xử lý… (có thể mất đến khoảng 1 phút)
          </div>
        ) : null}
      </div>

      <form onSubmit={send} className="space-y-2" data-testid="agent-form">
        <label htmlFor={inputId} className="sr-only">
          Yêu cầu cho Trợ lý AI
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          maxLength={AGENT_CHAT_LIMITS.maxMessageLength}
          placeholder="Ví dụ: Viết bài nháp giới thiệu tính năng mới cho dự án Blog…"
          className={`${inputClass} resize-y`}
          disabled={pending}
          data-testid="agent-input"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-500">
            {cooldown > 0 ? (
              <span className="text-amber-700 dark:text-amber-400" data-testid="agent-cooldown">
                Vui lòng đợi {cooldown} giây trước khi gửi tiếp.
              </span>
            ) : (
              <>
                Enter để gửi, Shift + Enter để xuống dòng · {text.length}/{AGENT_CHAT_LIMITS.maxMessageLength}
              </>
            )}
          </p>
          <button type="submit" disabled={!canSend} className={buttonClass.primary} data-testid="agent-send">
            {pending ? "Đang gửi…" : "Gửi"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ChatBubble({ entry, workspaceId }: { entry: ChatEntry; workspaceId: string }) {
  if (entry.role === "user") {
    return (
      <div className="flex justify-end" data-testid="chat-user">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-2 text-sm text-white">
          {entry.content}
        </div>
      </div>
    );
  }
  if (entry.role === "error") {
    return (
      <div data-testid="chat-error" data-kind={entry.kind}>
        <Notice tone={entry.kind === "rate_limited" ? "warning" : "error"}>
          {entry.content}
          {entry.kind === "unauthenticated" ? (
            <>
              {" "}
              <Link href="/login" className="font-medium underline">
                Đăng nhập lại
              </Link>
            </>
          ) : null}
        </Notice>
      </div>
    );
  }
  const items = entry.actions.map((a, i) => apiActionToView(workspaceId, a, i));
  const stopNote = STOP_REASON_LABELS[entry.stopReason];
  return (
    <div className="flex justify-start" data-testid="chat-assistant">
      <div className="w-full max-w-[92%] space-y-3 rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-3 py-3 text-sm sm:px-4 dark:border-slate-800 dark:bg-slate-950">
        <p className="whitespace-pre-wrap break-words">{entry.content}</p>
        {entry.partial ? (
          <Notice tone="warning" testId="agent-partial">
            Một phần thao tác đã được thực hiện trước khi Trợ lý dừng. Kiểm tra danh sách bên dưới trước khi gửi tiếp.
          </Notice>
        ) : stopNote ? (
          <Notice tone="info" testId="agent-stop-note">
            {stopNote}
          </Notice>
        ) : null}
        {items.length > 0 ? (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Thao tác đã thực hiện</p>
            <ActionList items={items} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export { ChatBubble };
