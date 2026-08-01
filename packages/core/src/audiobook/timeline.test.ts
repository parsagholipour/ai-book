import { describe, expect, it } from "vitest";
import { buildChapterNarration } from "./narration.js";
import {
  buildAudiobookTimeline,
  parseAudiobookTimeline,
  segmentAtPosition,
  serializeAudiobookTimeline
} from "./timeline.js";

function narrationFor(markdown: string, title = "") {
  return buildChapterNarration({
    chapterIndex: 1,
    title,
    language: "en",
    pages: [{ index: 1, markdown }]
  });
}

/** Every chunk lasts a fixed, easy-to-reason-about second. */
function evenTimings(chunkCount: number, durationMs = 1000) {
  return Array.from({ length: chunkCount }, (_, index) => ({ index, durationMs }));
}

describe("audiobook timeline", () => {
  it("pins every chunk boundary to the audio that was actually produced", () => {
    const narration = narrationFor("One.\n\nTwo.\n\nThree.");
    const timeline = buildAudiobookTimeline({
      narration,
      timings: evenTimings(narration.chunks.length)
    });

    // Three paragraphs → three chunks, each 1000 ms, separated by the
    // paragraph pause the narration planned.
    expect(timeline.segments[0]).toMatchObject({ startMs: 0, endMs: 1000 });
    const paragraphPause = narration.chunks[0]?.pauseAfterMs ?? 0;
    expect(timeline.segments[1]?.startMs).toBe(1000 + paragraphPause);
  });

  it("splits a multi-sentence chunk by length and still lands on the measured end", () => {
    const narration = narrationFor("Hi. A somewhat longer sentence here.");
    expect(narration.chunks).toHaveLength(1);

    const timeline = buildAudiobookTimeline({ narration, timings: [{ index: 0, durationMs: 4000 }] });
    const [first, second] = timeline.segments;

    expect(first?.startMs).toBe(0);
    expect(second?.startMs).toBe(first?.endMs);
    // The last segment of a chunk is pinned to the chunk's real end, so
    // interpolation error never leaks past a boundary.
    expect(second?.endMs).toBe(4000);
    expect(second!.endMs - second!.startMs).toBeGreaterThan(first!.endMs - first!.startMs);
  });

  it("reports a duration that includes the planned pauses", () => {
    const narration = narrationFor("One.\n\nTwo.");
    const timeline = buildAudiobookTimeline({
      narration,
      timings: evenTimings(narration.chunks.length)
    });
    const pauses = narration.chunks.reduce((total, chunk) => total + chunk.pauseAfterMs, 0);
    expect(timeline.durationMs).toBe(narration.chunks.length * 1000 + pauses);
  });

  it("never runs a segment backwards, even for a chunk that produced no audio", () => {
    const narration = narrationFor("One. Two. Three.");
    const timeline = buildAudiobookTimeline({ narration, timings: [{ index: 0, durationMs: 0 }] });
    for (const segment of timeline.segments) {
      expect(segment.endMs).toBeGreaterThanOrEqual(segment.startMs);
    }
  });

  it("survives a round trip through the sidecar file", () => {
    const narration = narrationFor("One. Two.", "Tide");
    const timeline = buildAudiobookTimeline({
      narration,
      timings: evenTimings(narration.chunks.length, 1500)
    });
    expect(parseAudiobookTimeline(serializeAudiobookTimeline(timeline))).toEqual(timeline);
  });

  it("finds the sentence being spoken, and holds it through the pause after it", () => {
    const narration = narrationFor("One.\n\nTwo.");
    const timeline = buildAudiobookTimeline({
      narration,
      timings: evenTimings(narration.chunks.length)
    });

    expect(segmentAtPosition(timeline, 0)?.text).toBe("One.");
    expect(segmentAtPosition(timeline, 999)?.text).toBe("One.");
    // Mid-pause still shows the line just read rather than blanking out.
    expect(segmentAtPosition(timeline, 1100)?.text).toBe("One.");
    expect(segmentAtPosition(timeline, timeline.segments[1]!.startMs)?.text).toBe("Two.");
  });

  it("has nothing to highlight before the first word", () => {
    const narration = narrationFor("Only.");
    const timeline = buildAudiobookTimeline({ narration, timings: evenTimings(1) });
    expect(segmentAtPosition({ ...timeline, segments: [] }, 10)).toBeUndefined();
  });

  it("carries the language direction through to the app", () => {
    const narration = buildChapterNarration({
      chapterIndex: 2,
      title: "فصل",
      language: "fa",
      pages: [{ index: 1, markdown: "سلام." }]
    });
    const timeline = buildAudiobookTimeline({ narration, timings: evenTimings(narration.chunks.length) });
    expect(timeline.direction).toBe("rtl");
    expect(timeline.chapterIndex).toBe(2);
  });
});
