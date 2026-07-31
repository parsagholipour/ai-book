import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());

import { formatVoiceCallHistory, loadVoiceCallHistory, type VoiceCallHistoryEntry } from "./voiceCallHistory.js";
import { mockPrisma, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";

const DAY = 24 * 60 * 60 * 1000;

function callRow(options: { agoMs: number; messages: { speaker: string; text: string }[] }) {
  return {
    startedAt: new Date(Date.now() - options.agoMs),
    transcript: options.messages
  };
}

function exchange(count: number, prefix = "line") {
  return Array.from({ length: count }, (_, index) => ({
    speaker: index % 2 === 0 ? ("caller" as const) : ("character" as const),
    text: `${prefix} ${index}`
  }));
}

function texts(entries: VoiceCallHistoryEntry[]): string[] {
  return entries.flatMap((entry) => entry.messages.map((message) => message.text));
}

describe("what a character carries between calls", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  describe("reading it back", () => {
    it("returns earlier calls oldest first, so the last thing said is the last thing read", async () => {
      mockPrisma.voiceCall.findMany.mockResolvedValue([
        callRow({ agoMs: DAY, messages: [{ speaker: "caller", text: "yesterday" }] }),
        callRow({ agoMs: 5 * DAY, messages: [{ speaker: "caller", text: "last week" }] })
      ]);

      const history = await loadVoiceCallHistory({ userId: "user-a", characterId: "character-1" });

      expect(texts(history)).toEqual(["last week", "yesterday"]);
    });

    it("stops at a hundred messages, keeping the most recent", async () => {
      mockPrisma.voiceCall.findMany.mockResolvedValue([
        callRow({ agoMs: DAY, messages: exchange(60, "recent") }),
        callRow({ agoMs: 2 * DAY, messages: exchange(60, "older") })
      ]);

      const history = await loadVoiceCallHistory({ userId: "user-a", characterId: "character-1" });
      const remembered = texts(history);

      expect(remembered).toHaveLength(100);
      expect(remembered.at(-1)).toBe("recent 59");
      // The older call is trimmed from its start, not its end: what was said
      // last in a call is what a person would still have.
      expect(remembered.at(0)).toBe("older 20");
    });

    it("drops calls that never uploaded anything rather than counting them", async () => {
      mockPrisma.voiceCall.findMany.mockResolvedValue([
        callRow({ agoMs: DAY, messages: [] }),
        { startedAt: new Date(Date.now() - 2 * DAY), transcript: null },
        callRow({ agoMs: 3 * DAY, messages: [{ speaker: "character", text: "the only line" }] })
      ]);

      const history = await loadVoiceCallHistory({ userId: "user-a", characterId: "character-1" });

      expect(history).toHaveLength(1);
      expect(texts(history)).toEqual(["the only line"]);
    });

    it("ignores anything in the column that is not a message", async () => {
      mockPrisma.voiceCall.findMany.mockResolvedValue([
        callRow({
          agoMs: DAY,
          messages: [
            { speaker: "narrator", text: "not a speaker" },
            { speaker: "caller", text: "   " },
            { speaker: "character", text: "kept" }
          ] as never
        })
      ]);

      const history = await loadVoiceCallHistory({ userId: "user-a", characterId: "character-1" });

      expect(texts(history)).toEqual(["kept"]);
    });

    it("holds the remembered talk to a size the instructions can carry", async () => {
      // The system instruction is locked into the ephemeral token, so a reader
      // who talks in paragraphs must not mint an unbounded one.
      const long = Array.from({ length: 40 }, (_, index) => ({
        speaker: "caller" as const,
        text: `${index}`.padEnd(500, "x")
      }));
      mockPrisma.voiceCall.findMany.mockResolvedValue([callRow({ agoMs: DAY, messages: long })]);

      const history = await loadVoiceCallHistory({ userId: "user-a", characterId: "character-1" });
      const kept = texts(history);

      expect(kept.length).toBeLessThan(40);
      expect(kept.join("").length).toBeLessThanOrEqual(12_000);
      // Trimmed from the front, so the end of the last call always survives.
      expect(kept.at(-1)).toBe(long.at(-1)?.text);
    });
  });

  describe("writing it into the instructions", () => {
    const now = new Date("2026-07-28T12:00:00.000Z");

    function block(agoMs: number): string {
      return formatVoiceCallHistory(
        [
          {
            startedAt: new Date(now.getTime() - agoMs),
            messages: [
              { speaker: "caller", text: "Do you remember me?" },
              { speaker: "character", text: "I do." }
            ]
          }
        ],
        now
      );
    }

    it("says nothing at all when there is nothing to remember", () => {
      expect(formatVoiceCallHistory([], now)).toBe("");
    });

    it("frames it as a new call rather than a conversation to resume", () => {
      const instructions = block(3 * DAY);

      expect(instructions).toContain("This is a new call, not a continuation");
      expect(instructions).toContain("do not recite it back");
    });

    it("names both speakers the way the character would", () => {
      const instructions = block(3 * DAY);

      expect(instructions).toContain("Reader: Do you remember me?");
      expect(instructions).toContain("You: I do.");
    });

    it("tells the character how long ago each call was", () => {
      expect(block(20 * 60 * 1000)).toContain("[a few minutes ago]");
      expect(block(5 * 60 * 60 * 1000)).toContain("[earlier today]");
      expect(block(30 * 60 * 60 * 1000)).toContain("[yesterday]");
      expect(block(4 * DAY)).toContain("[4 days ago]");
      expect(block(9 * DAY)).toContain("[last week]");
      expect(block(20 * DAY)).toContain("[3 weeks ago]");
      expect(block(200 * DAY)).toContain("[7 months ago]");
    });
  });
});
