import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateJobProgress: vi.fn()
}));

vi.mock("../runtime/jobLifecycle.js", () => ({
  updateJobProgress: mocks.updateJobProgress
}));

import { revisePageDraftWithRestart } from "./pageRevision.js";

const draftNamed = (name: string) => ({
  title: name,
  markdown: `${name} text.`,
  summary: `${name} summary.`,
  continuityNotes: [] as string[]
});

const strategyWith = (revise: ReturnType<typeof vi.fn>) => ({ revisePageDraft: revise }) as never;

beforeEach(() => vi.clearAllMocks());

describe("revisePageDraftWithRestart", () => {
  it("returns the first successful revision", async () => {
    const revise = vi.fn().mockResolvedValue(draftNamed("Fixed"));

    await expect(
      revisePageDraftWithRestart({ strategy: strategyWith(revise), reviseOptions: {} as never, context: "Page 1" })
    ).resolves.toMatchObject({ title: "Fixed" });
    expect(revise).toHaveBeenCalledTimes(1);
  });

  it("restarts after failures and surfaces the last error when the budget runs out", async () => {
    const revise = vi.fn().mockRejectedValue(new Error("provider hiccup"));

    await expect(
      revisePageDraftWithRestart({
        strategy: strategyWith(revise),
        reviseOptions: {} as never,
        context: "Page 1",
        maxRestarts: 2
      })
    ).rejects.toThrow("provider hiccup");
    expect(revise).toHaveBeenCalledTimes(3);
    expect(mocks.updateJobProgress).toHaveBeenCalledTimes(2);
  });

  it("succeeds on a restart within the budget", async () => {
    const revise = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider hiccup"))
      .mockResolvedValueOnce(draftNamed("Recovered"));

    await expect(
      revisePageDraftWithRestart({
        strategy: strategyWith(revise),
        reviseOptions: {} as never,
        context: "Page 1",
        maxRestarts: 1
      })
    ).resolves.toMatchObject({ title: "Recovered" });
  });
});
