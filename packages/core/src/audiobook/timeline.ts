import { z } from "zod";
import type { ChapterNarration, NarrationSegment } from "./narration.js";

/**
 * The sidecar that makes the transcript follow the audio.
 *
 * Chunk boundaries are measured from the synthesized PCM, so every chunk's start
 * and end are exact. Inside a chunk that holds several sentences we split the
 * span by character count — the only place any estimation happens, and it is
 * corrected at the next chunk boundary rather than accumulating.
 */

export const AUDIOBOOK_TIMELINE_VERSION = 1;

const timelineSegmentSchema = z.object({
  i: z.number().int().min(0),
  kind: z.enum(["title", "sentence"]),
  paragraph: z.number().int().min(0),
  pageIndex: z.number().int().min(0),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string()
});

export const audiobookTimelineSchema = z.object({
  version: z.literal(AUDIOBOOK_TIMELINE_VERSION),
  chapterIndex: z.number().int().min(0),
  title: z.string(),
  language: z.string(),
  direction: z.enum(["ltr", "rtl"]),
  durationMs: z.number().int().min(0),
  segments: z.array(timelineSegmentSchema)
});

export type AudiobookTimelineSegment = z.infer<typeof timelineSegmentSchema>;
export type AudiobookTimeline = z.infer<typeof audiobookTimelineSchema>;

export type SynthesizedChunkTiming = {
  /** Index of the narration chunk this timing belongs to. */
  index: number;
  /** Measured length of the chunk's own speech, excluding the pause after it. */
  durationMs: number;
};

export function buildAudiobookTimeline(options: {
  narration: ChapterNarration;
  timings: SynthesizedChunkTiming[];
}): AudiobookTimeline {
  const { narration } = options;
  const durationByChunk = new Map(options.timings.map((timing) => [timing.index, timing.durationMs]));
  const segmentsByIndex = new Map(narration.segments.map((segment) => [segment.index, segment]));
  const segments: AudiobookTimelineSegment[] = [];
  let cursorMs = 0;

  for (const chunk of narration.chunks) {
    const chunkDuration = Math.max(0, durationByChunk.get(chunk.index) ?? 0);
    const chunkSegments = chunk.segmentIndexes
      .map((index) => segmentsByIndex.get(index))
      .filter((segment): segment is NarrationSegment => segment !== undefined);

    const totalChars = chunkSegments.reduce((sum, segment) => sum + segment.text.length, 0);
    let offsetMs = 0;

    chunkSegments.forEach((segment, position) => {
      const isLast = position === chunkSegments.length - 1;
      const share = totalChars > 0 ? (segment.text.length / totalChars) * chunkDuration : 0;
      const startMs = cursorMs + offsetMs;
      // The last segment is pinned to the measured chunk end so rounding never
      // drifts past a boundary we actually know.
      const endMs = isLast ? cursorMs + chunkDuration : startMs + share;
      segments.push({
        i: segment.index,
        kind: segment.kind,
        paragraph: segment.paragraph,
        pageIndex: segment.pageIndex,
        startMs: Math.round(startMs),
        endMs: Math.round(Math.max(endMs, startMs)),
        text: segment.text
      });
      offsetMs += share;
    });

    cursorMs += chunkDuration + chunk.pauseAfterMs;
  }

  return {
    version: AUDIOBOOK_TIMELINE_VERSION,
    chapterIndex: narration.chapterIndex,
    title: narration.title,
    language: narration.language,
    direction: narration.direction,
    durationMs: Math.round(cursorMs),
    segments
  };
}

export function serializeAudiobookTimeline(timeline: AudiobookTimeline): string {
  return JSON.stringify(timeline);
}

export function parseAudiobookTimeline(raw: string): AudiobookTimeline {
  return audiobookTimelineSchema.parse(JSON.parse(raw));
}

/** The segment being spoken at `positionMs`, or the one just before it. */
export function segmentAtPosition(timeline: AudiobookTimeline, positionMs: number): AudiobookTimelineSegment | undefined {
  const segments = timeline.segments;
  if (segments.length === 0) {
    return undefined;
  }

  let low = 0;
  let high = segments.length - 1;
  let candidate: AudiobookTimelineSegment | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (!segment) {
      break;
    }
    if (segment.startMs <= positionMs) {
      candidate = segment;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return candidate;
}
