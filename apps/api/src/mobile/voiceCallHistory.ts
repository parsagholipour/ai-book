import { prisma } from "@book-maker/db";

/**
 * What a character remembers of a reader between calls.
 *
 * Audio never reaches the server — the app opens its own socket to Gemini — so
 * a transcript exists here only because the app uploads one as the call runs, a
 * batch at a time on the heartbeat it is already sending. `VoiceCall.transcript`
 * holds the tail of a single call; opening a new call reads the tail of the
 * previous ones back.
 *
 * This is memory, not resumption. Each call is a fresh session behind a fresh
 * single-use token, and the history goes in as something the character already
 * knows rather than as a conversation to pick back up mid-sentence — which is
 * what `formatVoiceCallHistory` spends its first paragraph saying.
 */

export type VoiceCallMessage = {
  speaker: "caller" | "character";
  text: string;
};

/** One earlier call, as the next one is told about it. */
export type VoiceCallHistoryEntry = {
  startedAt: Date;
  messages: VoiceCallMessage[];
};

/** Messages kept per call. A long call is trimmed to how it ended. */
export const VOICE_CALL_TRANSCRIPT_LIMIT = 100;

/** Messages carried into the next call, across as many calls as it takes. */
export const VOICE_CALL_HISTORY_LIMIT = 100;

/** Earlier calls scanned to fill that. */
const HISTORY_CALL_LOOKBACK = 10;

/**
 * Characters of remembered speech the instructions will carry.
 *
 * The system instruction is locked into the ephemeral token, so history with no
 * ceiling means a token mint with no ceiling on every call. The oldest messages
 * are dropped first, which is also the order they stop mattering in.
 */
const HISTORY_CHAR_BUDGET = 12_000;

/**
 * Appends what the app heard since its last upload.
 *
 * Scoped by user as well as call: this runs beside the meter rather than inside
 * it, and a transcript is the one part of a call that would be worth writing to
 * someone else's.
 *
 * Uploads are at-least-once — a heartbeat that times out is retried with the
 * same batch — so an overlap with what is already stored is dropped rather than
 * remembered twice.
 */
export async function appendVoiceCallMessages(options: {
  callId: string;
  userId: string;
  messages: VoiceCallMessage[];
}): Promise<void> {
  if (options.messages.length === 0) {
    return;
  }
  const call = await prisma.voiceCall.findFirst({
    where: { id: options.callId, userId: options.userId },
    select: { id: true, transcript: true }
  });
  if (!call) {
    return;
  }

  const stored = parseTranscript(call.transcript);
  const fresh = options.messages.slice(overlapLength(stored, options.messages));
  if (fresh.length === 0) {
    return;
  }

  await prisma.voiceCall.update({
    where: { id: call.id },
    data: { transcript: [...stored, ...fresh].slice(-VOICE_CALL_TRANSCRIPT_LIMIT) }
  });
}

/**
 * The reader's last calls with one character, oldest first.
 *
 * Bounded twice over — by how many calls are read and by how many messages come
 * out of them — because a reader who rings the same character every day would
 * otherwise carry a year of it into every call.
 */
export async function loadVoiceCallHistory(options: {
  userId: string;
  characterId: string;
}): Promise<VoiceCallHistoryEntry[]> {
  const calls = await prisma.voiceCall.findMany({
    where: { userId: options.userId, characterId: options.characterId },
    orderBy: { startedAt: "desc" },
    take: HISTORY_CALL_LOOKBACK,
    select: { startedAt: true, transcript: true }
  });

  const entries: VoiceCallHistoryEntry[] = [];
  let remaining = VOICE_CALL_HISTORY_LIMIT;
  // Newest first, taking the tail of each call, so the budget is spent on the
  // most recent thing said rather than on the first call the reader ever made.
  for (const call of calls) {
    if (remaining <= 0) {
      break;
    }
    const messages = parseTranscript(call.transcript).slice(-remaining);
    if (messages.length === 0) {
      continue;
    }
    remaining -= messages.length;
    entries.unshift({ startedAt: call.startedAt, messages });
  }
  return withinCharBudget(entries);
}

/**
 * The block of instructions that turns those calls into memory.
 *
 * Returns an empty string when there is nothing to remember, so a first call
 * reads exactly as it did before this existed.
 */
export function formatVoiceCallHistory(entries: VoiceCallHistoryEntry[], now = new Date()): string {
  if (entries.length === 0) {
    return "";
  }

  const calls = entries.map((entry) => {
    const lines = entry.messages.map(
      (message) => `${message.speaker === "caller" ? "Reader" : "You"}: ${message.text}`
    );
    return [`[${callAgeLabel(entry.startedAt, now)}]`, ...lines].join("\n");
  });

  return [
    "You have spoken with this reader before.",
    [
      "This is a new call, not a continuation of those: greet them as someone you already know rather than picking up mid-thought from where the last one ended.",
      "What follows is your own memory of what was said. Draw on it when it is natural to — remember what they told you, what you told them, what was left unfinished — but do not recite it back, and do not mention being given notes or a transcript.",
      "If they ask about something that is not there, you simply do not remember it."
    ].join(" "),
    ["Earlier calls, oldest first:", ...calls].join("\n\n")
  ].join("\n\n");
}

/**
 * How long ago a call was, in the words someone would actually use.
 *
 * Measured as elapsed time rather than off the calendar: the server's midnight
 * is not the reader's, and "yesterday" is worth getting right for a character
 * who is meant to sound like they remember.
 */
function callAgeLabel(startedAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 60_000));
  if (minutes < 60) {
    return "a few minutes ago";
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return "earlier today";
  }
  const days = Math.floor(hours / 24);
  if (days < 2) {
    return "yesterday";
  }
  if (days < 7) {
    return `${days} days ago`;
  }
  if (days < 30) {
    const weeks = Math.max(1, Math.round(days / 7));
    return weeks === 1 ? "last week" : `${weeks} weeks ago`;
  }
  const months = Math.max(1, Math.round(days / 30));
  return months === 1 ? "last month" : `${months} months ago`;
}

/** Drops whole leading messages until the history fits the prompt budget. */
function withinCharBudget(entries: VoiceCallHistoryEntry[]): VoiceCallHistoryEntry[] {
  let total = entries.reduce(
    (sum, entry) => sum + entry.messages.reduce((count, message) => count + message.text.length, 0),
    0
  );
  if (total <= HISTORY_CHAR_BUDGET) {
    return entries;
  }

  const trimmed = entries.map((entry) => ({ ...entry, messages: [...entry.messages] }));
  for (const entry of trimmed) {
    while (entry.messages.length > 0 && total > HISTORY_CHAR_BUDGET) {
      const [dropped] = entry.messages.splice(0, 1);
      total -= dropped?.text.length ?? 0;
    }
  }
  return trimmed.filter((entry) => entry.messages.length > 0);
}

/**
 * How much of `incoming` the stored tail already ends with.
 *
 * A retried upload resends its whole batch, so the answer is the longest suffix
 * of what is stored that is also a prefix of what arrived. Testing longest-first
 * matters: a batch of repeated one-word answers has several short overlaps, and
 * only the longest is the one that was actually resent.
 */
function overlapLength(stored: VoiceCallMessage[], incoming: VoiceCallMessage[]): number {
  const max = Math.min(stored.length, incoming.length);
  for (let length = max; length > 0; length -= 1) {
    let matches = true;
    for (let offset = 0; offset < length; offset += 1) {
      const previous = stored[stored.length - length + offset];
      const next = incoming[offset];
      if (!previous || !next || previous.speaker !== next.speaker || previous.text !== next.text) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return length;
    }
  }
  return 0;
}

/** Reads back what we wrote, defensively: it is JSON in a column, not a type. */
function parseTranscript(value: unknown): VoiceCallMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const { speaker, text } = entry as Record<string, unknown>;
    if (speaker !== "caller" && speaker !== "character") {
      return [];
    }
    if (typeof text !== "string" || !text.trim()) {
      return [];
    }
    return [{ speaker, text }];
  });
}
