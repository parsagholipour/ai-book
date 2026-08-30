import { describe, expect, it, vi } from "vitest";

import {
  claimAppliedEditPublication,
  restoreEditProjectStatus
} from "./editProjectStatus.js";

type StatusClient = Parameters<typeof claimAppliedEditPublication>[0];

const appliedAt = new Date("2026-08-24T10:00:00.000Z");
const createdAt = new Date("2026-08-24T09:59:00.000Z");

function statusClient(options: {
  phase?: "ACTIVE" | "APPLIED";
  publicationRevision?: number | null;
  kind?: "PAGE_REWRITE" | "ADD_IMAGE" | "MOVE_IMAGE" | "REMOVE_IMAGE" | "RESTRUCTURE_PAGES" | "MANUAL_EDIT";
  classifier?: Record<string, unknown>;
  ownerJob?: { projectId: string; type: string; status: string } | null;
  projectLockCount?: number;
  laterOperation?: { id: string; status?: "QUEUED" | "ACTIVE" | "APPLIED" } | null;
  laterLifecycle?: { id: string } | null;
} = {}) {
  const updateMany = vi
    .fn()
    .mockResolvedValueOnce({ count: options.projectLockCount ?? 1 })
    .mockResolvedValue({ count: 1 });
  const operation = {
    id: "op-old",
    projectId: "project-1",
    generationJobId: "job-old",
    kind: options.kind ?? "PAGE_REWRITE",
    classifier: options.classifier ?? {},
    status: options.phase ?? "APPLIED",
    createdAt,
    appliedAt: options.phase === "ACTIVE" ? null : appliedAt,
    publicationRevision: options.publicationRevision === undefined ? 8 : options.publicationRevision
  };
  const findOperation = vi.fn().mockResolvedValue(operation);
  const lockOperation = vi.fn().mockResolvedValue({ count: 1 });
  const findLaterOperation = vi.fn().mockResolvedValue(options.laterOperation ?? null);
  const findLaterLifecycle = vi.fn().mockResolvedValue(options.laterLifecycle ?? null);
  const findOwnerJob = vi.fn().mockResolvedValue(
    options.ownerJob === undefined
      ? { projectId: "project-1", type: "APPLY_BOOK_EDIT", status: "ACTIVE" }
      : options.ownerJob
  );
  const findProject = vi.fn().mockResolvedValue({ contentRevision: 8 });
  return {
    client: {
      project: { updateMany, findUnique: findProject },
      bookEditOperation: { updateMany: lockOperation, findUnique: findOperation, findFirst: findLaterOperation },
      generationJob: { findFirst: findLaterLifecycle, findUnique: findOwnerJob }
    } as unknown as StatusClient,
    updateMany,
    findLaterOperation,
    findLaterLifecycle
  };
}

describe("edit project status ownership", () => {
  it("rejects an APPLIED replay after the project leaves its publication statuses", async () => {
    const { client, updateMany, findLaterOperation, findLaterLifecycle } = statusClient({ projectLockCount: 0 });

    await expect(
      claimAppliedEditPublication(client, "project-1", "op-old", "COMPLETE")
    ).resolves.toBe(false);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(findLaterOperation).not.toHaveBeenCalled();
    expect(findLaterLifecycle).not.toHaveBeenCalled();
  });

  it.each(["QUEUED", "ACTIVE", "APPLIED"] as const)(
    "refuses an old APPLIED replay while a newer %s edit owns the window",
    async (status) => {
      const { client, updateMany } = statusClient({ laterOperation: { id: "op-new", status } });

      await expect(
        claimAppliedEditPublication(client, "project-1", "op-old", "REVIEW_REQUIRED")
      ).resolves.toBe(false);
      expect(updateMany).toHaveBeenCalledTimes(1);
    }
  );

  it("refuses an old APPLIED replay while a newer compile-pending lifecycle has not advanced revision", async () => {
    const { client, updateMany, findLaterLifecycle } = statusClient({
      laterLifecycle: { id: "compile-new" }
    });

    await expect(
      claimAppliedEditPublication(client, "project-1", "op-old", "COMPLETE")
    ).resolves.toBe(false);
    expect(findLaterLifecycle).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        createdAt: { gt: appliedAt },
        id: { notIn: ["job-old"] }
      },
      select: { id: true }
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it.each(["COMPLETE", "EDITING"] as const)(
    "claims its stamped APPLIED publication from %s",
    async () => {
      const { client, updateMany } = statusClient();

      await expect(
        claimAppliedEditPublication(client, "project-1", "op-old", "COMPLETE")
      ).resolves.toBe(true);
      expect(updateMany).toHaveBeenLastCalledWith({
        where: { id: "project-1", status: { in: ["COMPLETE", "EDITING"] } },
        data: { status: "EDITING" }
      });
    }
  );

  it("refuses APPLIED ownership when the project revision has moved", async () => {
    const { client, updateMany } = statusClient({ publicationRevision: 7 });

    await expect(
      claimAppliedEditPublication(client, "project-1", "op-old", "COMPLETE")
    ).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    "PAGE_REWRITE",
    "ADD_IMAGE",
    "MOVE_IMAGE",
    "REMOVE_IMAGE",
    "RESTRUCTURE_PAGES"
  ] as const)("adopts an in-flight legacy %s publication under the operation lock", async (kind) => {
    const { client, updateMany } = statusClient({ publicationRevision: null, kind });

    await expect(
      claimAppliedEditPublication(client, "project-1", "op-old", "COMPLETE")
    ).resolves.toBe(true);

    const operationUpdates = (client.bookEditOperation.updateMany as ReturnType<typeof vi.fn>).mock.calls;
    expect(operationUpdates).toContainEqual([{
      where: {
        id: "op-old",
        projectId: "project-1",
        status: "APPLIED",
        publicationRevision: null,
        generationJobId: "job-old"
      },
      data: { publicationRevision: 8 }
    }]);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "project-1", status: { in: ["COMPLETE", "EDITING"] } },
      data: { status: "EDITING" }
    });
  });

  it.each([
    [{ textExactSkipped: true }],
    [{ layoutMissing: true }],
    [{ structuralSkipped: "unknown_pages" }],
    [{ structuralRolledBackAt: "2026-08-24T10:01:00.000Z" }],
    [{ undoneAt: "2026-08-24T10:01:00.000Z" }]
  ])("does not turn a legacy no-op or undone edit into a publication owner", async (classifier) => {
    const { client, updateMany } = statusClient({ publicationRevision: null, classifier });

    await expect(
      claimAppliedEditPublication(client, "project-1", "op-old", "COMPLETE")
    ).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    { projectId: "project-2", type: "APPLY_BOOK_EDIT", status: "ACTIVE" },
    { projectId: "project-1", type: "COMPILE_EXPORT", status: "ACTIVE" },
    { projectId: "project-1", type: "APPLY_BOOK_EDIT", status: "COMPLETED" }
  ])("requires the legacy operation's own open apply job: %j", async (ownerJob) => {
    const { client, updateMany } = statusClient({ publicationRevision: null, ownerJob });

    await expect(
      claimAppliedEditPublication(client, "project-1", "op-old", "COMPLETE")
    ).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not stamp a legacy operation when a same-millisecond newer lifecycle exists", async () => {
    const { client, updateMany, findLaterLifecycle } = statusClient({
      publicationRevision: null,
      laterLifecycle: { id: "compile-new" }
    });

    await expect(
      claimAppliedEditPublication(client, "project-1", "op-old", "COMPLETE")
    ).resolves.toBe(false);
    expect(findLaterLifecycle).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        createdAt: { gte: appliedAt },
        id: { notIn: ["job-old"] }
      },
      select: { id: true }
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("keeps non-publication APPLIED kinds unstamped", async () => {
    const { client, updateMany } = statusClient({
      publicationRevision: null,
      kind: "MANUAL_EDIT"
    });

    await expect(
      claimAppliedEditPublication(client, "project-1", "op-old", "COMPLETE")
    ).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("restores a first-delivery ACTIVE no-op that still owns EDITING", async () => {
    const { client, updateMany } = statusClient({ phase: "ACTIVE", publicationRevision: null });

    await expect(
      restoreEditProjectStatus(client, "project-1", "op-old", "REVIEW_REQUIRED", "ACTIVE")
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "project-1", status: "EDITING" },
      data: { status: "REVIEW_REQUIRED" }
    });
  });

  it("refuses an APPLIED status restore while a newer lifecycle owns EDITING", async () => {
    const { client, updateMany, findLaterLifecycle } = statusClient({
      laterLifecycle: { id: "compile-new" }
    });

    await expect(
      restoreEditProjectStatus(client, "project-1", "op-old", "REVIEW_REQUIRED")
    ).resolves.toBe(false);
    expect(findLaterLifecycle).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        createdAt: { gt: appliedAt },
        id: { notIn: ["job-old"] }
      },
      select: { id: true }
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
