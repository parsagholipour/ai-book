import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: { safetySettingsRevision: { findFirst: vi.fn() } }
}));
vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma }));

import {
  JEV_SELECTION,
  type AppConfig,
  type DecisionModelAdapter,
  type DecisionModelSelection,
  type DecisionRequest,
  type DecisionResult,
  type GenerationTextModelRouting
} from "@book-maker/core";
import { forgetSexualContentFilterSetting } from "./contentSafety.js";
import {
  BOOK_TEXT_MAX_WINDOWS,
  BOOK_TEXT_WINDOW_CHARS,
  forgetContentSafetyVerdicts,
  screenBookTextForSexualContent,
  screenRequestForSexualContent,
  textWindows
} from "./contentSafetyScreen.js";
import type { UserTextModerationDeps } from "./userTextModeration.js";

const FALLBACK = { provider: "deepseek", model: "deepseek-chat" } as const;

/** Jev's full distribution over whatever options the request offered. */
function verdict(request: DecisionRequest, selectedOption: string, winner = 0.95): DecisionResult {
  const rest = (1 - winner) / (request.options.length - 1);
  const probabilities = Object.fromEntries(request.options.map((option) => [option.id, option.id === selectedOption ? winner : rest]));
  return { ...JEV_SELECTION, selectedOption, probabilities, usage: { promptTokens: 80, outputTokens: 0 } };
}

function deps(decide: (request: DecisionRequest) => Promise<DecisionResult>, requests: DecisionRequest[] = []): UserTextModerationDeps {
  return {
    config: { MOCK_AI: false } as AppConfig,
    loadRouting: async () =>
      ({ fastDecisions: JEV_SELECTION, fastDecisionsFallback: FALLBACK, fastJudgments: FALLBACK }) as unknown as GenerationTextModelRouting,
    createAdapter: (_selection: DecisionModelSelection): DecisionModelAdapter => ({
      choose: async (request) => {
        requests.push(request);
        return decide(request);
      }
    }),
    retry: { attempts: 1 }
  };
}

const quietLog = () => ({ warn: vi.fn(), info: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  forgetSexualContentFilterSetting();
  forgetContentSafetyVerdicts();
  mocks.prisma.safetySettingsRevision.findFirst.mockResolvedValue(null);
});

describe("textWindows", () => {
  it("cuts overlapping windows that cover the whole text", () => {
    const text = "x".repeat(20_000);
    const windows = textWindows(text, 6_000, 400);
    expect(windows.length).toBe(4);
    expect(windows.every((window) => window.length <= 6_000)).toBe(true);
    expect(windows.at(-1)!.length).toBeGreaterThan(0);
    expect(textWindows("   ", 6_000)).toEqual([]);
  });
});

describe("screenRequestForSexualContent", () => {
  it("refuses a confident child_safety verdict with the minor sentence, asking only the filter's options", async () => {
    const requests: DecisionRequest[] = [];
    const refusal = await screenRequestForSexualContent({
      text: "An erotic story about two 15-year-olds.",
      door: "plan_approval",
      deps: deps(async (request) => verdict(request, "child_safety"), requests),
      log: quietLog()
    });

    expect(refusal).toMatchObject({ allowed: false, reason: "minor_sexual_content" });
    expect(refusal!.message).toContain("under 18");
    expect(requests[0]!.options.map((option) => option.id)).toEqual(["allowed", "sexual", "child_safety"]);
    expect(requests[0]!.purpose).toBe("moderation.book_request");
  });

  it("refuses a confident sexual verdict with the adult sentence", async () => {
    const refusal = await screenRequestForSexualContent({
      text: "Write explicit porn.",
      door: "project_chat",
      deps: deps(async (request) => verdict(request, "sexual")),
      log: quietLog()
    });
    expect(refusal).toMatchObject({ reason: "sexual_content" });
  });

  it("fails open on an outage, and says so", async () => {
    const log = quietLog();
    const refusal = await screenRequestForSexualContent({
      text: "A gentle bedtime story.",
      door: "plan_approval",
      deps: deps(async () => { throw new Error("gateway 503"); }),
      log
    });
    expect(refusal).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "content_safety.request_undecided" }), expect.any(String));
  });

  it("asks nothing while the operator has the filter off", async () => {
    mocks.prisma.safetySettingsRevision.findFirst.mockResolvedValue({ sexualContentFilterEnabled: false });
    const decide = vi.fn(async (request: DecisionRequest) => verdict(request, "sexual"));
    await expect(screenRequestForSexualContent({ text: "Anything.", door: "plan", deps: deps(decide) })).resolves.toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it("screens when the switch cannot be read (the filter fails closed)", async () => {
    mocks.prisma.safetySettingsRevision.findFirst.mockRejectedValue(new Error("connection reset"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = await screenRequestForSexualContent({
      text: "Write explicit porn.",
      door: "plan",
      deps: deps(async (request) => verdict(request, "sexual")),
      log: quietLog()
    });
    expect(refusal).toMatchObject({ reason: "sexual_content" });
    errors.mockRestore();
  });

  it("does not pay twice for the same words", async () => {
    const decide = vi.fn(async (request: DecisionRequest) => verdict(request, "allowed"));
    await screenRequestForSexualContent({ text: "A pirate adventure.", door: "creation_build", deps: deps(decide) });
    await screenRequestForSexualContent({ text: "A pirate adventure.", door: "creation_build", deps: deps(decide) });
    expect(decide).toHaveBeenCalledTimes(1);
  });
});

describe("screenBookTextForSexualContent", () => {
  const chapter = (n: number) => `Chapter ${n}. ${"The tide came in and the gulls argued. ".repeat(250)}`;

  it("reads every window of the book and allows a clean one", async () => {
    const requests: DecisionRequest[] = [];
    const sections = [chapter(1), chapter(2), chapter(3)];
    const screen = await screenBookTextForSexualContent({
      sections,
      deps: deps(async (request) => verdict(request, "allowed"), requests)
    });
    const expected = textWindows(sections.join("\n\n"), BOOK_TEXT_WINDOW_CHARS).length;
    expect(screen).toEqual({ verdict: "allowed", windows: expected });
    expect(requests).toHaveLength(expected);
    expect(requests[0]!.purpose).toBe("moderation.book_text");
  });

  it("refuses the share when any window is confidently a violation", async () => {
    const screen = await screenBookTextForSexualContent({
      sections: [chapter(1), "A scene that is explicit.", chapter(2)],
      deps: deps(async (request) =>
        verdict(request, JSON.parse(request.context.slice(request.context.indexOf("\n") + 1)).includes("explicit.") ? "sexual" : "allowed")
      ),
      log: quietLog()
    });
    expect(screen).toMatchObject({ verdict: "refused", refusal: { reason: "sexual_content" } });
  });

  it("holds for review, never allows, when a window has no verdict", async () => {
    // Both the primary and the fallback fail on the window holding the marker.
    const screen = await screenBookTextForSexualContent({
      sections: [chapter(1), "OUTAGE-MARK", chapter(2)],
      deps: deps(async (request) => {
        if (request.context.includes("OUTAGE-MARK")) throw new Error("gateway 503");
        return verdict(request, "allowed");
      }),
      log: quietLog()
    });
    expect(screen).toMatchObject({ verdict: "held", unscreened: 0, reasons: ["provider_failure"] });
    expect(screen && screen.verdict === "held" ? screen.undecided : 0).toBeGreaterThan(0);
  });

  it("holds the windows its budget never reached", async () => {
    let clock = 0;
    const screen = await screenBookTextForSexualContent({
      // More windows than run at once, so later ones start after the clock has moved.
      sections: Array.from({ length: 12 }, (_, index) => chapter(index + 1)),
      deps: deps(async (request) => {
        clock += 5_000;
        return verdict(request, "allowed");
      }),
      budgetMs: 12_000,
      now: () => clock,
      log: quietLog()
    });
    expect(screen).toMatchObject({ verdict: "held" });
    expect(screen && screen.verdict === "held" ? screen.unscreened : 0).toBeGreaterThan(0);
  });

  it("caps the windows it reads and holds the rest", async () => {
    const huge = "word ".repeat((BOOK_TEXT_WINDOW_CHARS * (BOOK_TEXT_MAX_WINDOWS + 5)) / 5);
    const decide = vi.fn(async (request: DecisionRequest) => verdict(request, "allowed"));
    const screen = await screenBookTextForSexualContent({ sections: [huge], deps: deps(decide), budgetMs: 600_000, log: quietLog() });
    expect(decide.mock.calls.length).toBeLessThanOrEqual(BOOK_TEXT_MAX_WINDOWS);
    expect(screen).toMatchObject({ verdict: "held", reasons: ["not_reached"] });
  });

  it("is off with the filter", async () => {
    mocks.prisma.safetySettingsRevision.findFirst.mockResolvedValue({ sexualContentFilterEnabled: false });
    await expect(screenBookTextForSexualContent({ sections: [chapter(1)], deps: deps(async (r) => verdict(r, "sexual")) })).resolves.toBeNull();
  });
});
