import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ calls: vi.fn(), images: vi.fn(async () => []) }));
vi.mock("@book-maker/db", () => ({ prisma: {
  providerCallLog: { findMany: mocks.calls }, imageAsset: { findMany: mocks.images }
} }));
import { loadProjectCostSummaries, loadProjectCostSummary } from "./projectCosts.js";

it("includes settled unknown usage in both project summaries without adding estimated spend", async () => {
  const row = { projectId: "book", provider: "openai", model: "gpt-6-luna", purpose: "extract-excerpts",
    promptTokens: 14421, outputTokens: 735, cacheHitTokens: null, cacheWriteTokens: null, costHint: null,
    createdAt: new Date(), metadata: { operation: "text.generateJson", liveStatus: "settled", provisional: true } };
  mocks.calls.mockResolvedValue([
    row,
    { ...row, costHint: 0.25, metadata: { operation: "text.generateJson", liveStatus: "settled", provisional: false } },
    { ...row, metadata: { operation: "text.generateJson", liveStatus: "in_progress", provisional: true } }
  ]);
  expect(await loadProjectCostSummary("book")).toMatchObject({ totalUsd: 0.25, unpricedTextCalls: 1 });
  expect((await loadProjectCostSummaries(["book"])).get("book")).toMatchObject({ totalUsd: 0.25, unpricedTextCalls: 1 });
});
