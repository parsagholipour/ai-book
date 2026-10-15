/**
 * What a realtime voice call spent, read from the provider's own token counts.
 *
 * Gemini Live bills a call per turn, and each turn is billed for the whole
 * context window — the conversation so far and the system instruction —
 * re-read as prompt tokens (Google's Live API best practices: "During each
 * turn, the API bills for all context tokens", monitored through the
 * `usageMetadata` each server message may carry). So every report is that
 * turn's billed usage, and the call's spend is the *sum* of its reports, never
 * the last or the largest one: the last report alone undercounts by roughly
 * the number of turns.
 *
 * A report is priced by modality, because an audio token costs up to four
 * times a text token. A report whose per-modality
 * details do not account for its totals, or that names a modality this card
 * has no rate for, cannot be priced without inventing a split — so it is kept
 * apart and recorded unpriced (`costHint` null), which the Costs tab counts as
 * *unrated*: real spend the dashboard is understating, and says so
 * (`apps/api/src/admin/CLAUDE.md`).
 */

/** The `ProviderCallLog.purpose` of a voice call's spend. */
export const VOICE_CALL_PURPOSE = "voice-call";
/** Its `metadata.operation`, which `costs.ts` reads to put the row in the audio bucket. */
export const VOICE_CALL_OPERATION = "voice.live";

/** Token counts by Gemini `Modality` name (`TEXT`, `AUDIO`, `IMAGE`, `VIDEO`, …). */
export type ModalityTokens = Record<string, number>;

export type LiveVoiceUsage = {
  /** Usage reports folded in. */
  reports: number;
  /** Billed input: every turn's prompt, the re-read context included, plus any tool-use prompt. */
  inputTokens: number;
  /** Billed output, thinking included (billed as output text). */
  outputTokens: number;
  /**
   * `inputTokens` by modality. Whatever a report's details did not account
   * for sits under {@link UNATTRIBUTED_MODALITY}, so the split always adds up
   * to the total and a token with no known modality can never be priced.
   */
  inputByModality: ModalityTokens;
  /** `outputTokens` by modality, on the same rule. */
  outputByModality: ModalityTokens;
  /** The cached part of the prompt, already inside `inputTokens`. Diagnostic: no Live rate discounts it. */
  cachedTokens: number;
  /** Thinking tokens, already inside `outputTokens` (as `TEXT` when the report counted them apart). */
  thoughtsTokens: number;
};

/** Tokens a report billed without saying which modality they were. No card has a rate for it. */
export const UNATTRIBUTED_MODALITY = "UNATTRIBUTED";

/** Per-million-token USD rates by modality, one table per direction. */
export type LiveVoiceRate = {
  inputPerMillion: ModalityTokens;
  outputPerMillion: ModalityTokens;
};

/**
 * Google's published paid-tier Live API rates, per 1M tokens, read off
 * https://ai.google.dev/gemini-api/docs/pricing on 2026-10-13. The page lists
 * no cached-input rate for either model, so cached prompt tokens are billed at
 * the input rate. Thinking tokens are billed as output text.
 */
const GEMINI_LIVE_RATES = new Map<string, LiveVoiceRate>([
  [
    // "Gemini 3.1 Flash Live Preview": $0.75 text, $3.00 audio, $1.00
    // image/video in; $4.50 text, $12.00 audio out. GEMINI_LIVE_MODEL's default.
    "gemini-3.1-flash-live-preview",
    {
      inputPerMillion: { TEXT: 0.75, AUDIO: 3, IMAGE: 1, VIDEO: 1 },
      outputPerMillion: { TEXT: 4.5, AUDIO: 12 }
    }
  ],
  [
    // "Gemini 2.5 Flash Native Audio (Live API)": $0.50 text, $3.00 audio/video
    // in; $2.00 text, $12.00 audio out. No image rate is listed.
    "gemini-2.5-flash-native-audio-preview-12-2025",
    {
      inputPerMillion: { TEXT: 0.5, AUDIO: 3, VIDEO: 3 },
      outputPerMillion: { TEXT: 2, AUDIO: 12 }
    }
  ]
]);

const TOKENS_PER_MILLION = 1_000_000;
const COST_PRECISION = 1_000_000;

export function emptyLiveVoiceUsage(): LiveVoiceUsage {
  return { reports: 0, inputTokens: 0, outputTokens: 0, inputByModality: {}, outputByModality: {}, cachedTokens: 0, thoughtsTokens: 0 };
}

/** The rate card for a Live model, or null when it has none. `models/` and case are ignored. */
export function liveVoiceRate(provider: string, model: string): LiveVoiceRate | null {
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider !== "gemini" && normalizedProvider !== "google") {
    return null;
  }
  return GEMINI_LIVE_RATES.get(model.trim().toLowerCase().replace(/^models\//, "")) ?? null;
}

/**
 * One Gemini Live `usageMetadata` (`BidiGenerateContentServerMessage.usageMetadata`)
 * as billed usage, and whether its modality split accounts for every billed
 * token; null when it is not a report or reports nothing.
 *
 * `promptTokensDetails`, `toolUsePromptTokensDetails` and
 * `responseTokensDetails` carry the modality split; the scalar counts are the
 * totals they must add up to. Thinking (`thoughtsTokenCount`) sits outside
 * `responseTokenCount` under the generateContent convention, and is added to
 * output text — unless `totalTokenCount` shows it was already inside the
 * response, in which case adding it would bill it twice.
 */
export function parseGeminiLiveUsage(value: unknown):
  | { usage: LiveVoiceUsage; complete: boolean }
  | null {
  if (!isRecord(value)) {
    return null;
  }
  const prompt = count(value.promptTokenCount);
  const response = count(value.responseTokenCount);
  const toolUse = count(value.toolUsePromptTokenCount);
  const thoughts = count(value.thoughtsTokenCount);
  const total = optionalCount(value.totalTokenCount);
  if (prompt + response + toolUse + thoughts === 0) {
    return null;
  }

  const inputByModality: ModalityTokens = {};
  const outputByModality: ModalityTokens = {};
  const promptDetails = addDetails(inputByModality, value.promptTokensDetails);
  const toolDetails = addDetails(inputByModality, value.toolUsePromptTokensDetails);
  const responseDetails = addDetails(outputByModality, value.responseTokensDetails);
  addUnattributed(inputByModality, prompt + toolUse - promptDetails - toolDetails);
  addUnattributed(outputByModality, response - responseDetails);
  const thoughtsInsideResponse = thoughts > 0 && total !== null && total === prompt + toolUse + response;
  const billedThoughts = thoughtsInsideResponse ? 0 : thoughts;
  if (billedThoughts > 0) {
    outputByModality.TEXT = (outputByModality.TEXT ?? 0) + billedThoughts;
  }
  return {
    usage: {
      reports: 1,
      inputTokens: prompt + toolUse,
      outputTokens: response + billedThoughts,
      inputByModality,
      outputByModality,
      cachedTokens: count(value.cachedContentTokenCount),
      thoughtsTokens: thoughts
    },
    // The split must account for every billed token, or pricing it would be a
    // guess; details that claim *more* than the total are no better.
    complete: promptDetails === prompt && toolDetails === toolUse && responseDetails === response
  };
}

export function addLiveVoiceUsage(left: LiveVoiceUsage, right: LiveVoiceUsage): LiveVoiceUsage {
  return {
    reports: left.reports + right.reports,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    inputByModality: addModalities(left.inputByModality, right.inputByModality),
    outputByModality: addModalities(left.outputByModality, right.outputByModality),
    cachedTokens: left.cachedTokens + right.cachedTokens,
    thoughtsTokens: left.thoughtsTokens + right.thoughtsTokens
  };
}

/** The USD a usage costs on its model's card, or null when any of its tokens has no rate. */
export function calculateLiveVoiceCost(input: { provider: string; model: string; usage: LiveVoiceUsage }): number | null {
  const rate = liveVoiceRate(input.provider, input.model);
  if (!rate) {
    return null;
  }
  const inputUsd = priceModalities(input.usage.inputByModality, rate.inputPerMillion);
  const outputUsd = priceModalities(input.usage.outputByModality, rate.outputPerMillion);
  if (inputUsd === null || outputUsd === null) {
    return null;
  }
  return Math.round((inputUsd + outputUsd) * COST_PRECISION) / COST_PRECISION;
}

function priceModalities(tokens: ModalityTokens, rates: ModalityTokens): number | null {
  let usd = 0;
  for (const [modality, amount] of Object.entries(tokens)) {
    if (amount === 0) {
      continue;
    }
    const rate = rates[modality];
    if (rate === undefined) {
      return null;
    }
    usd += (amount / TOKENS_PER_MILLION) * rate;
  }
  return usd;
}

/** Adds a `ModalityTokenCount[]` into `target` and returns how many tokens it carried. */
function addDetails(target: ModalityTokens, details: unknown): number {
  if (!Array.isArray(details)) {
    return 0;
  }
  let carried = 0;
  for (const detail of details) {
    if (!isRecord(detail)) {
      continue;
    }
    const tokens = count(detail.tokenCount);
    if (tokens === 0) {
      continue;
    }
    const modality = typeof detail.modality === "string" && detail.modality.trim()
      ? detail.modality.trim().toUpperCase()
      : "MODALITY_UNSPECIFIED";
    target[modality] = (target[modality] ?? 0) + tokens;
    carried += tokens;
  }
  return carried;
}

function addUnattributed(target: ModalityTokens, residual: number): void {
  if (residual > 0) {
    target[UNATTRIBUTED_MODALITY] = (target[UNATTRIBUTED_MODALITY] ?? 0) + residual;
  }
}

function addModalities(left: ModalityTokens, right: ModalityTokens): ModalityTokens {
  const sum: ModalityTokens = { ...left };
  for (const [modality, amount] of Object.entries(right)) {
    sum[modality] = (sum[modality] ?? 0) + amount;
  }
  return sum;
}

function count(value: unknown): number {
  return optionalCount(value) ?? 0;
}

function optionalCount(value: unknown): number | null {
  // proto3 JSON may render an int64 as a string.
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
