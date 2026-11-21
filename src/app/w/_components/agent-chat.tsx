"use client";

import { Bot, RotateCcw, SendHorizontal, Sparkles, UserRound } from "lucide-react";
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
          <button type="button" onClick={resetChat} className={buttonClass.secondary} disabled={pending} data-testid="agent-reset">
            <RotateCcw className="h-4 w-4 text-slate-500" aria-hidden />
            Cuộc trò chuyện mới
          </button>
        ) : null}
      </div>

      <div
        ref={listRef}
        className="flex max-h-[62vh] min-h-72 flex-col gap-5 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/70 p-3 sm:p-5"
        aria-live="polite"
        data-testid="agent-messages"
      >
        {entries.length === 0 ? (
          <div className="m-auto max-w-md py-6 text-center" data-testid="agent-empty">
            <span className="mx-auto mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm shadow-indigo-600/30">
              <Sparkles className="h-5 w-5" aria-hidden />
            </span>
            <p className="font-semibold text-slate-900">Bạn muốn Trợ lý AI giúp gì?</p>
            <p className="mt-1 text-sm text-slate-600">
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
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-left text-sm text-slate-700 shadow-xs transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
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
          <div className="flex items-center gap-2.5 rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-600 shadow-card sm:w-fit" role="status" data-testid="agent-pending">
            <span className="inline-flex gap-1" aria-hidden>
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-400" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-400 [animation-delay:120ms]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-400 [animation-delay:240ms]" />
            </span>
            Trợ lý đang xử lý… (có thể mất đến khoảng 1 phút)
          </div>
        ) : null}
      </div>

      <form
        onSubmit={send}
        className="space-y-2 rounded-xl border border-slate-200 bg-white p-2 shadow-card transition focus-within:border-indigo-300 focus-within:ring-4 focus-within:ring-indigo-500/10"
        data-testid="agent-form"
      >
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
          className="block w-full resize-y border-0 bg-transparent px-2 py-1.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-500"
          disabled={pending}
          data-testid="agent-input"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-2 pt-2">
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
            <SendHorizontal className="h-4 w-4" aria-hidden />
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
      <div className="flex items-end justify-end gap-2">
        <div
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2.5 text-sm leading-6 text-white shadow-sm shadow-indigo-600/20"
          data-testid="chat-user"
        >
          {entry.content}
        </div>
        <span className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-600 sm:inline-flex" aria-hidden>
          <UserRound className="h-4 w-4" />
        </span>
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
    <div className="flex items-start justify-start gap-2" data-testid="chat-assistant">
      <span className="mt-0.5 hidden h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white sm:inline-flex" aria-hidden>
        <Bot className="h-4 w-4" />
      </span>
      <div className="w-full min-w-0 max-w-[92%] space-y-3 rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-3 text-sm shadow-card sm:px-4">
        <p className="whitespace-pre-wrap break-words leading-6 text-slate-800">{entry.content}</p>
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
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Thao tác đã thực hiện</p>
            <ActionList items={items} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export { ChatBubble };
