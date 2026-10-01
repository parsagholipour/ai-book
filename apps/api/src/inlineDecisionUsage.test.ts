import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./mobile/testing/mobileApiMocks.js")).dbModuleMock());

import { JEV_SELECTION, type DecisionAttempt } from "@book-maker/core";
import { recordInlineDecisionAttempt } from "./inlineDecisionUsage.js";
import { mockPrisma } from "./mobile/testing/mobileApiMocks.js";

afterEach(() => {
  vi.clearAllMocks();
});

const REQUEST = {
  purpose: "moderation.book_share_caption",
  instructions: "…",
  context: "…",
  options: [{ id: "allowed", description: "fine" }]
};

function row() {
  return mockPrisma.providerCallLog.create.mock.calls.at(-1)?.[0].data;
}

describe("recordInlineDecisionAttempt", () => {
  it("writes an inline, job-less row priced from the provider's own tokens", async () => {
    const attempt: DecisionAttempt = {
      request: REQUEST,
      selection: JEV_SELECTION,
      role: "primary",
      durationMs: 640,
      result: {
        ...JEV_SELECTION,
        selectedOption: "allowed",
        probabilities: { allowed: 0.97 },
        usage: { promptTokens: 1_000_000, outputTokens: 0 }
      }
    };

    await recordInlineDecisionAttempt(attempt, { projectId: "project-1" });

    expect(row()).toMatchObject({
      projectId: "project-1",
      generationJobId: null,
      provider: JEV_SELECTION.provider,
      model: JEV_SELECTION.model,
      purpose: "moderation.book_share_caption",
      promptTokens: 1_000_000,
      outputTokens: 0,
      durationMs: 640,
      metadata: {
        operation: "inline",
        textOperation: "decision.choose",
        provisional: false,
        decision: { role: "primary", selectedOption: "allowed", probabilities: { allowed: 0.97 } }
      }
    });
    // Jev's rate card: $0.042 per million input tokens.
    expect(row()?.costHint).toBeCloseTo(0.042);
  });

  it("writes a failed attempt with no tokens and no price rather than guessing", async () => {
    await recordInlineDecisionAttempt(
      {
        request: REQUEST,
        selection: { provider: "deepseek", model: "deepseek-chat" },
        role: "fallback",
        durationMs: 20_000,
        error: Object.assign(new Error("Jev did not answer"), { status: 504 }),
        escalationReason: "provider_failure"
      },
      { projectId: null }
    );

    expect(row()).toMatchObject({
      projectId: null,
      generationJobId: null,
      provider: "deepseek",
      promptTokens: null,
      outputTokens: null,
      costHint: null,
      metadata: {
        operation: "inline",
        provisional: true,
        decision: { role: "fallback", escalationReason: "provider_failure" },
        outcome: { error: { status: 504 } }
      }
    });
  });

  it("never fails the caller when the row cannot be written", async () => {
    mockPrisma.providerCallLog.create.mockRejectedValueOnce(new Error("db down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordInlineDecisionAttempt({ request: REQUEST, selection: JEV_SELECTION, role: "primary", durationMs: 1 }, { projectId: null })
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
