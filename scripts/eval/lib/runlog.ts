/**
 * Run-log events → one record per provider call. The worker appends `text.<op>.request`,
 * `.provider_request` (one per physical attempt), `.provider_usage`, `.response` / `.error` for text
 * calls and `research.search.request` / `.response` for grounded searches, all keyed by `callId`
 * (`apps/worker/src/providers/loggedAdapters.ts`). Pure, so it runs on the host over a dumped log.
 */
import type { ChatMessage } from "./fixtures.ts";

export type RunEvent = {
  event: string;
  timestamp?: string;
  callId?: string;
  job?: { name?: string; projectId?: string; id?: string };
  [key: string]: unknown;
};

export type LoggedCall = {
  callId: string;
  op: "generateText" | "generateJson" | "search";
  purpose: string;
  jobName: string;
  model: { provider: string; model: string };
  answeredBy?: { provider: string; model: string };
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  durationMs: number;
  temperature?: number;
  maxTokens?: number;
  messages: ChatMessage[];
  query?: { query: string; purpose: string };
  text?: string;
  data?: unknown;
  sources?: Array<{ title?: string; url?: string; summary?: string }> | undefined;
  grounding?: unknown;
  truncated?: boolean;
  usage: { promptTokens: number; outputTokens: number; reasoningTokens: number; cacheHitTokens: number };
  attempts: number;
  errors: string[];
  ok: boolean;
};

export function parseRunLogText(text: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as RunEvent;
      if (value && typeof value.event === "string") events.push(value);
    } catch {
      // A torn line is skipped; the run log is diagnostic, not a ledger.
    }
  }
  return events;
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function usageOf(value: unknown): LoggedCall["usage"] {
  const usage = asRecord(value);
  return {
    promptTokens: num(usage.promptTokens),
    outputTokens: num(usage.outputTokens),
    reasoningTokens: num(usage.reasoningTokens),
    cacheHitTokens: num(usage.cacheHitTokens)
  };
}

export function groupCalls(events: readonly RunEvent[]): LoggedCall[] {
  const calls = new Map<string, LoggedCall>();
  const order: string[] = [];
  const get = (event: RunEvent): LoggedCall => {
    const id = event.callId!;
    let call = calls.get(id);
    if (!call) {
      call = {
        callId: id,
        op: "generateText",
        purpose: "",
        jobName: event.job?.name ?? "",
        model: { provider: "", model: "" },
        durationMs: 0,
        messages: [],
        usage: { promptTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheHitTokens: 0 },
        attempts: 0,
        errors: [],
        ok: false
      };
      calls.set(id, call);
      order.push(id);
    }
    return call;
  };
  for (const event of events) {
    if (!event.callId) continue;
    const name = event.event;
    const parts = name.split(".");
    if (parts[0] === "text" && parts.length === 3) {
      const op = parts[1];
      if (op !== "generateText" && op !== "generateJson") continue;
      const call = get(event);
      call.op = op;
      const stage = parts[2];
      if (stage === "request") {
        const request = asRecord(parseMaybeJson(event.request));
        const model = asRecord(event.model);
        call.purpose = String(request.purpose ?? call.purpose ?? "");
        call.model = { provider: String(model.provider ?? ""), model: String(model.model ?? "") };
        call.startedAt = event.timestamp;
        if (typeof request.temperature === "number") call.temperature = request.temperature;
        const maxTokens = request.maxTokens ?? request.requestedMaxTokens;
        if (typeof maxTokens === "number") call.maxTokens = maxTokens;
        const messages = Array.isArray(request.messages) ? request.messages : [];
        call.messages = messages
          .map((message) => asRecord(message))
          .filter((message) => typeof message.content === "string")
          .map((message) => ({ role: String(message.role) as ChatMessage["role"], content: String(message.content) }));
      } else if (stage === "provider_request") {
        call.attempts += 1;
        if (!call.purpose && typeof event.purpose === "string") call.purpose = event.purpose;
      } else if (stage === "response") {
        const result = asRecord(parseMaybeJson(event.result ?? event.response));
        call.endedAt = event.timestamp;
        call.text = typeof result.text === "string" ? result.text : "";
        if ("data" in result) call.data = result.data;
        call.usage = usageOf(result.usage);
        call.answeredBy = { provider: String(result.provider ?? ""), model: String(result.model ?? "") };
        call.ok = true;
      } else if (stage === "error") {
        const error = asRecord(event.error);
        call.errors.push(String(error.message ?? error.name ?? "error"));
        call.endedAt = event.timestamp;
      }
      continue;
    }
    if (name === "research.search.request" || name === "research.search.response") {
      const call = get(event);
      call.op = "search";
      if (name.endsWith("request")) {
        const query = asRecord(event.query);
        call.query = { query: String(query.query ?? ""), purpose: String(query.purpose ?? "") };
        call.purpose = call.query.purpose;
        call.startedAt = event.timestamp;
        call.attempts += 1;
      } else {
        const result = asRecord(event.result);
        call.endedAt = event.timestamp;
        call.text = typeof result.summary === "string" ? result.summary : "";
        call.sources = Array.isArray(result.sources) ? (result.sources as LoggedCall["sources"]) : [];
        call.grounding = result.grounding;
        call.truncated = result.truncated === true;
        call.usage = usageOf(result.usage);
        call.model = { provider: String(result.provider ?? ""), model: String(result.model ?? "") };
        call.answeredBy = call.model;
        call.ok = true;
      }
    }
  }
  for (const call of calls.values()) {
    if (call.startedAt && call.endedAt) call.durationMs = Math.max(0, Date.parse(call.endedAt) - Date.parse(call.startedAt));
  }
  return order.map((id) => calls.get(id)!);
}
