import {
  VOICE_CALL_OPERATION,
  VOICE_CALL_PURPOSE,
  addLiveVoiceUsage,
  calculateLiveVoiceCost,
  emptyLiveVoiceUsage,
  parseGeminiLiveUsage,
  type LiveVoiceUsage
} from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";

/**
 * Provider cost rows for a relayed voice call.
 *
 * The relay is the only place a call's spend is visible: the device never sees
 * provider frames beyond `serverContent`, and Gemini Live bills per turn for
 * the whole context window, reported as `usageMetadata` beside the turn's
 * content. `VoiceUsageMeter` folds every report the relay receives into one
 * running total per call and hands it over as rows — one *segment* per flush —
 * priced from the provider's own per-modality counts (`liveVoiceUsage.ts`).
 *
 * - **Never double counted.** `take()` empties the meter synchronously before
 *   anything is awaited, so a report rides exactly one segment however the
 *   periodic flush and the stop interleave. A row that fails to write is lost
 *   (and logged), never retried: a retry after an ambiguous failure is how one
 *   segment becomes two.
 * - **Survives a provider resume.** The meter belongs to the device's
 *   connection, not to the provider socket the relay reopens on `goAway`, so
 *   a reconnect neither drops nor restarts the count.
 * - **Never invents a price.** A report whose modality split does not add up,
 *   or that names a modality the model's card has no rate for, goes into a
 *   separate unpriced row (`costHint` null, `costStatus: "unknown_rate"`) — the
 *   Costs tab's *unrated* bucket — rather than being priced as a guess or
 *   dropped. Priced reports keep their own row, so one odd report cannot take
 *   a whole segment's spend out of `SUM("costHint")`.
 * - **Never touches the call.** Recording is called without awaiting it on the
 *   frame path, and every failure is logged and swallowed.
 */

export type VoiceUsageIdentity = {
  callId: string;
  userId: string;
  /** The book a book call is about; null for a library character. */
  projectId: string | null;
  provider: string;
  model: string;
};

type Segment = { usage: LiveVoiceUsage; costHint: number | null };

export class VoiceUsageMeter {
  private priced = emptyLiveVoiceUsage();
  private unpriced = emptyLiveVoiceUsage();
  private segments = 0;
  private openedAt: number;

  constructor(private readonly identity: VoiceUsageIdentity, now = Date.now()) {
    this.openedAt = now;
  }

  /** Folds in a provider frame's `usageMetadata`, if it carries one. */
  observe(frame: Record<string, unknown>): void {
    const report = parseGeminiLiveUsage(frame.usageMetadata);
    if (!report) {
      return;
    }
    const priceable = report.complete && this.cost(report.usage) !== null;
    if (priceable) {
      this.priced = addLiveVoiceUsage(this.priced, report.usage);
    } else {
      this.unpriced = addLiveVoiceUsage(this.unpriced, report.usage);
    }
  }

  /** Whether anything has been observed since the last `take()`. */
  get pending(): boolean {
    return this.priced.reports + this.unpriced.reports > 0;
  }

  /** Everything observed since the last take, as rows to write; the meter starts afresh. */
  take(now = Date.now()): Prisma.ProviderCallLogCreateManyInput[] {
    const segments: Segment[] = [];
    if (this.priced.reports > 0) {
      segments.push({ usage: this.priced, costHint: this.cost(this.priced) });
    }
    if (this.unpriced.reports > 0) {
      segments.push({ usage: this.unpriced, costHint: null });
    }
    const startedAt = this.openedAt;
    this.priced = emptyLiveVoiceUsage();
    this.unpriced = emptyLiveVoiceUsage();
    this.openedAt = now;
    if (segments.length === 0) {
      return [];
    }
    this.segments += 1;
    const segment = this.segments;
    return segments.map(({ usage, costHint }) => this.row(usage, costHint, segment, startedAt, now));
  }

  private cost(usage: LiveVoiceUsage): number | null {
    return calculateLiveVoiceCost({ provider: this.identity.provider, model: this.identity.model, usage });
  }

  private row(
    usage: LiveVoiceUsage,
    costHint: number | null,
    segment: number,
    startedAt: number,
    now: number
  ): Prisma.ProviderCallLogCreateManyInput {
    return {
      projectId: this.identity.projectId,
      generationJobId: null,
      userId: this.identity.userId,
      provider: this.identity.provider,
      model: this.identity.model,
      purpose: VOICE_CALL_PURPOSE,
      promptTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      // No Live rate discounts cached tokens, so they are not "cache hits" in
      // the Costs tab's sense; the count rides the metadata instead.
      cacheHitTokens: null,
      cacheWriteTokens: null,
      costHint,
      durationMs: Math.max(0, Math.round(now - startedAt)),
      metadata: {
        operation: VOICE_CALL_OPERATION,
        voiceCallId: this.identity.callId,
        segment,
        segmentStartedAt: new Date(startedAt).toISOString(),
        usageReports: usage.reports,
        inputByModality: usage.inputByModality,
        outputByModality: usage.outputByModality,
        cachedTokens: usage.cachedTokens,
        thoughtsTokens: usage.thoughtsTokens,
        liveStatus: "settled",
        provisional: false,
        costStatus: costHint === null ? "unknown_rate" : "priced"
      } satisfies Prisma.InputJsonValue
    };
  }
}

/** Writes a segment's rows. Never throws: a failure is reported to `warn` and the rows are dropped. */
export async function recordVoiceUsage(
  rows: Prisma.ProviderCallLogCreateManyInput[],
  warn: (error: unknown) => void
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  try {
    await prisma.providerCallLog.createMany({ data: rows });
  } catch (error) {
    warn(error);
  }
}

/** The model a relay session names, as the rate card and every other cost row spell it. */
export function voiceUsageModel(sessionModel: string): string {
  return sessionModel.replace(/^models\//, "");
}
