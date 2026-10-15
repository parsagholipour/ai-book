import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    project: { findUnique: vi.fn() },
    providerCallLog: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() }
  }
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));

import {
  beginLiveTextUsage,
  recordProviderAudioCost,
  recordProviderImageCost,
  recordProviderUsage
} from "../providers/usageAccounting.js";
import type { AnyWorkerJob } from "./jobPayloads.js";
import { currentProviderSpendUserId, runWithProviderSpendUser } from "./providerSpendUser.js";

function bookJob(): AnyWorkerJob {
  return { name: "generate-page", data: { projectId: "project-1", generationJobId: "gj-1", planId: "plan-1", pageId: "page-1" } } as unknown as AnyWorkerJob;
}

function portraitJob(): AnyWorkerJob {
  return {
    name: "generate-character-portrait",
    data: { generationJobId: "gj-portrait", libraryCharacterId: "character-1", userId: "reader-portrait" }
  } as unknown as AnyWorkerJob;
}

const call = {
  projectId: "project-1",
  generationJobId: "gj-1",
  provider: "gemini",
  model: "gemini-2.5-flash",
  purpose: "book.page",
  operation: "text.generateText",
  callId: "call-1",
  durationMs: 10
};

const writtenUsers = () => [
  ...mocks.prisma.providerCallLog.create.mock.calls.map((args) => args[0].data.userId),
  ...mocks.prisma.providerCallLog.update.mock.calls.map((args) => args[0].data.userId)
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.project.findUnique.mockResolvedValue({ userId: "reader-book" });
  mocks.prisma.providerCallLog.create.mockResolvedValue({ id: "live-1" });
  mocks.prisma.providerCallLog.update.mockResolvedValue({});
});

describe("provider spend attribution", () => {
  it("stamps every row a book job writes with the book's owner, looked up once", async () => {
    await runWithProviderSpendUser(bookJob(), async () => {
      const live = await beginLiveTextUsage({ ...call, startedAt: new Date().toISOString(), options: { messages: [{ role: "user", content: "hi" }] } });
      await recordProviderUsage({ ...call, usage: { promptTokens: 10, outputTokens: 5 }, liveUsageId: live?.id });
      await recordProviderUsage({ ...call, callId: "call-2", usage: { promptTokens: 10, outputTokens: 5 } });
      await recordProviderImageCost({ ...call, operation: "image.generate", costHint: 0.039, metadata: {} });
      await recordProviderAudioCost({ ...call, operation: "tts.synthesize", costHint: 0.01, audioMs: 1000 });
    });

    expect(writtenUsers()).toEqual(["reader-book", "reader-book", "reader-book", "reader-book", "reader-book"]);
    // One query per delivery, not one per provider call.
    expect(mocks.prisma.project.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: "project-1" }, select: { userId: true } });
  });

  it("stamps the portrait job's rows with the user its payload names, without a query", async () => {
    await runWithProviderSpendUser(portraitJob(), async () => {
      await recordProviderImageCost({ ...call, projectId: undefined, generationJobId: "gj-portrait", operation: "image.generate", costHint: 0.039, metadata: {} });
    });

    expect(writtenUsers()).toEqual(["reader-portrait"]);
    expect(mocks.prisma.project.findUnique).not.toHaveBeenCalled();
  });

  it("keeps concurrent deliveries apart", async () => {
    mocks.prisma.project.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({ userId: `owner-of-${args.where.id}` }));
    const deliveryFor = (projectId: string) =>
      ({ name: "generate-page", data: { projectId, generationJobId: `gj-${projectId}`, planId: "plan", pageId: "page" } }) as unknown as AnyWorkerJob;
    const seen = await Promise.all(["a", "b"].map((projectId) =>
      runWithProviderSpendUser(deliveryFor(projectId), async () => {
        await new Promise((resolve) => setTimeout(resolve, projectId === "a" ? 5 : 0));
        return currentProviderSpendUserId();
      })
    ));
    expect(seen).toEqual(["owner-of-a", "owner-of-b"]);
  });

  it("writes an unattributed row rather than failing the call when the lookup fails", async () => {
    mocks.prisma.project.findUnique.mockRejectedValue(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runWithProviderSpendUser(bookJob(), () =>
      recordProviderUsage({ ...call, usage: { promptTokens: 10, outputTokens: 5 } })
    );
    expect(writtenUsers()).toEqual([null]);
    consoleError.mockRestore();
  });

  it("names nobody outside a delivery", async () => {
    await recordProviderUsage({ ...call, usage: { promptTokens: 10, outputTokens: 5 } });
    expect(writtenUsers()).toEqual([null]);
    await expect(currentProviderSpendUserId()).resolves.toBeNull();
  });
});
