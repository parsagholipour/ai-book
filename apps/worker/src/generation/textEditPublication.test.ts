import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    project: { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    page: { count: vi.fn() },
    pageEditSnapshot: { deleteMany: vi.fn() },
    continuityNote: { createMany: vi.fn() },
    bookEditOperation: { update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn()
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(),
      bookEditOperation: { findUnique: vi.fn() },
      project: { updateMany: vi.fn() }
    },
    claimDurableEditCompletionTx: vi.fn(async () => true),
    settleDurableEditAttemptTx: vi.fn(async () => true),
    assertTextEditLeaseTx: vi.fn(),
    completeTextEditLease: vi.fn(async () => true),
    releaseTextEditTailLease: vi.fn(async () => true),
    heartbeatAssertHeld: vi.fn(async () => undefined),
    heartbeatStop: vi.fn(async () => undefined),
    waitForTextEditLeaseCompletion: vi.fn(async (): Promise<"completed" | "abandoned"> => "completed"),
    invalidateProjectExports: vi.fn(),
    maybeEnqueueCompile: vi.fn(
      async (): Promise<"compile" | "waiting" | "not-ready" | "settled"> => "compile"
    ),
    claimAppliedEditPublication: vi.fn(async () => true),
    restoreEditProjectStatus: vi.fn(
      async (_tx: unknown, _projectId: string, _operationId: string, _fallbackStatus: string) => true
    ),
    runBestEffortPageMemoryWrite: vi.fn(async (_tx: unknown, run: () => Promise<unknown>) => run())
  };
});

vi.mock("@book-maker/db", () => ({
  prisma: mocks.prisma,
  Prisma: {},
  MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 }
}));
vi.mock("./bookHelpers.js", () => ({ invalidateProjectExports: mocks.invalidateProjectExports }));
vi.mock("./bestEffortSavepoint.js", () => ({
  runBestEffortPageMemoryWrite: mocks.runBestEffortPageMemoryWrite
}));
vi.mock("./textEditLease.js", () => ({
  assertTextEditLeaseTx: mocks.assertTextEditLeaseTx,
  completeTextEditLease: mocks.completeTextEditLease,
  releaseTextEditTailLease: mocks.releaseTextEditTailLease,
  startTextEditLeaseHeartbeat: () => ({
    assertHeld: mocks.heartbeatAssertHeld,
    stop: mocks.heartbeatStop
  }),
  waitForTextEditLeaseCompletion: mocks.waitForTextEditLeaseCompletion
}));
vi.mock("./editProjectStatus.js", () => ({
  claimAppliedEditPublication: mocks.claimAppliedEditPublication,
  restoreEditProjectStatus: mocks.restoreEditProjectStatus
}));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/durableEditCompletion.js", () => ({
  claimDurableEditCompletionTx: mocks.claimDurableEditCompletionTx,
  settleDurableEditAttemptTx: mocks.settleDurableEditAttemptTx
}));

import {
  adoptLegacyTextEditTail,
  publishTextEditManuscript,
  textEditPublicationCompletion,
  type TextEditPublicationIdentity,
  type TextEditPublicationPage
} from "./textEditPublication.js";

const emptyStoryState = { promises: [], facts: [], entities: {}, unanswered: [] };

function publicationPage(index: number): TextEditPublicationPage {
  return {
    pageId: `page-${index}`,
    pageIndex: index,
    revisionBefore: 3,
    titleBefore: `Old ${index}`,
    markdownBefore: `Old markdown ${index}`,
    summaryBefore: `Old summary ${index}`,
    imagePromptBefore: index % 2 === 0 ? `Old image ${index}` : null,
    qualityReportBefore: { score: 60 },
    storyDeltaBefore: { factsAdded: [`old-${index}`] },
    titleAfter: `New ${index}`,
    markdownAfter: `New markdown ${index}`,
    summaryAfter: `New summary ${index}`,
    imagePromptAfter: index % 2 === 0 ? `New image ${index}` : null,
    qualityReportAfter: { score: 100 },
    storyDeltaAfter: { factsAdded: [`new-${index}`] },
    statusAfter: index % 3 === 0 ? "FAILED_QA" : "COMPLETED",
    continuityNotes: [`note-${index}`],
    preparedEmbedding: null
  };
}

const publicationOptions = (pages: TextEditPublicationPage[]) => ({
  projectId: "project-1",
  operationId: "operation-1",
  ownerToken: "owner-1",
  planVersionId: "plan-1",
  fallbackStatus: "REVIEW_REQUIRED" as const,
  editInstruction: "Rewrite the selected pages",
  audit: { satisfied: true },
  skippedPageIndexes: [999],
  pages,
  storyStateAfter: emptyStoryState,
  completion: {
    generationJobId: "job-1",
    projectId: "project-1",
    operationId: "operation-1",
    attemptId: "attempt-1",
    type: "APPLY_BOOK_EDIT" as const,
    message: "Book edit applied"
  }
});

const identity: TextEditPublicationIdentity = {
  projectId: "project-1",
  operationId: "operation-1",
  planVersionId: "plan-1",
  publicationRevision: 8,
  fallbackStatus: "REVIEW_REQUIRED"
};

function followUpClassifier(completedSteps: string[] = []) {
  return {
    textEditFollowUp: {
      planVersionId: identity.planVersionId,
      publicationRevision: identity.publicationRevision,
      fallbackStatus: identity.fallbackStatus,
      completedSteps,
      updatedAt: new Date(0).toISOString()
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(
    async (run: (tx: typeof mocks.tx) => Promise<unknown>) => run(mocks.tx)
  );
  mocks.assertTextEditLeaseTx.mockResolvedValue({ status: "ACTIVE", classifier: {} });
  mocks.tx.project.update.mockResolvedValue({});
  mocks.tx.project.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.page.count.mockResolvedValue(0);
  mocks.tx.pageEditSnapshot.deleteMany.mockResolvedValue({ count: 0 });
  mocks.tx.continuityNote.createMany.mockResolvedValue({ count: 0 });
  mocks.tx.bookEditOperation.update.mockResolvedValue({});
  mocks.tx.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.bookEditOperation.count.mockResolvedValue(0);
  mocks.prisma.project.updateMany.mockResolvedValue({ count: 0 });
  mocks.claimAppliedEditPublication.mockResolvedValue(true);
  mocks.restoreEditProjectStatus.mockResolvedValue(true);
  mocks.claimDurableEditCompletionTx.mockResolvedValue(true);
  mocks.settleDurableEditAttemptTx.mockResolvedValue(true);
  mocks.completeTextEditLease.mockResolvedValue(true);
  mocks.waitForTextEditLeaseCompletion.mockResolvedValue("completed");
  mocks.maybeEnqueueCompile.mockResolvedValue("compile");
});

describe("publishTextEditManuscript", () => {
  it("publishes 120 exact page/snapshot pairs with constant transaction round trips", async () => {
    const pages = Array.from({ length: 120 }, (_, offset) => publicationPage(offset + 1));
    mocks.tx.$queryRawUnsafe
      .mockImplementationOnce(async (sql: string, _projectId: string, _operationId: string, json: string) => {
        const payload = JSON.parse(json) as Array<Record<string, unknown>>;
        expect(payload).toHaveLength(120);
        expect(payload[0]).toMatchObject({
          page_id: "page-1",
          story_delta_before: { factsAdded: ["old-1"] },
          image_prompt_before: null,
          quality_report_after: { score: 100 }
        });
        expect(sql).toContain("jsonb_to_recordset($3::jsonb)");
        expect(sql).toContain('page."revision" = item.revision_before');
        expect(sql).toContain('page."qualityReport" IS NOT DISTINCT FROM item.quality_report_before');
        expect(sql).toContain('snapshot."storyDeltaBefore" IS NOT DISTINCT FROM item.story_delta_before');
        expect(sql.match(/"updatedAt" = CURRENT_TIMESTAMP/g)).toHaveLength(1);
        expect(sql).toMatch(/"storyDelta" = item\.story_delta_after,\s+"status" = item\.status_after,/);
        expect(sql).toContain("status_after text");
        // A page whose best candidate still failed review must not be
        // republished as finished: it would vanish from the failed count and
        // from the next compile's repair targets.
        expect(payload.filter((entry) => entry.status_after === "FAILED_QA")).toHaveLength(40);
        return [{
          inputCount: payload.length,
          distinctPageCount: payload.length,
          resolvedSnapshotCount: payload.length,
          validSnapshotCount: payload.length,
          updatedPageCount: payload.length,
          updatedSnapshotCount: payload.length
        }];
      })
      .mockResolvedValueOnce([{ contentRevision: 8 }]);

    const result = await publishTextEditManuscript(publicationOptions(pages));

    expect(result.identity).toEqual(identity);
    expect(mocks.tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(mocks.tx.pageEditSnapshot.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.tx.continuityNote.createMany).toHaveBeenCalledTimes(1);
    // Fenced on ACTIVE: the shared lease CAS admits an APPLIED row, so an
    // `update` by id alone would let a second delivery re-stamp a publication
    // that already happened and reset its tail's checkpoints to `[]`.
    expect(mocks.tx.bookEditOperation.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.tx.bookEditOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "operation-1", status: "ACTIVE" } })
    );
    expect(mocks.tx.bookEditOperation.update).not.toHaveBeenCalled();
    expect(mocks.claimDurableEditCompletionTx).toHaveBeenCalledTimes(1);
    expect(mocks.settleDurableEditAttemptTx).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("creates a first delivery's snapshots in a statement of their own", async () => {
    // Nothing else writes a text edit's PageEditSnapshot rows, so on a first
    // delivery every one of them is born in this publication. PostgreSQL runs
    // all of a statement's `WITH` sub-statements against one snapshot, so an
    // `INSERT` folded in beside the publication is invisible to the sibling
    // `UPDATE "PageEditSnapshot"`: `updatedSnapshotCount` came back 0 for every
    // page_rewrite and local_patch, the count check rolled the transaction
    // back, and the edit failed after paying for each rewrite.
    const statements: string[] = [];
    mocks.tx.$executeRawUnsafe.mockImplementation(async (sql: string) => {
      statements.push(sql);
      return 2;
    });
    mocks.tx.$queryRawUnsafe
      .mockImplementationOnce(async (sql: string) => {
        statements.push(sql);
        return [{
          inputCount: 2,
          distinctPageCount: 2,
          resolvedSnapshotCount: 2,
          validSnapshotCount: 2,
          updatedPageCount: 2,
          updatedSnapshotCount: 2
        }];
      })
      .mockResolvedValueOnce([{ contentRevision: 8 }]);

    await publishTextEditManuscript(publicationOptions([publicationPage(1), publicationPage(2)]));

    expect(mocks.tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(2);
    const [insertSql, publishSql] = statements;
    expect(insertSql).toContain('INSERT INTO "PageEditSnapshot"');
    expect(insertSql).toContain('WHERE snapshot."operationId" = $2');
    expect(publishSql).toContain('UPDATE "PageEditSnapshot" snapshot');
    expect(publishSql).toContain('"revisionAfter" = page."revision"');
    expect(publishSql).not.toContain("INSERT INTO");
    expect(mocks.tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.any(String),
      "project-1",
      "operation-1",
      expect.stringContaining('"snapshot_id"')
    );
  });

  it("refuses to republish an operation that already published", async () => {
    // `assertTextEditLeaseTx` delegates to the lease CAS the tail shares, whose
    // `WHERE` deliberately admits `status IN ('ACTIVE','APPLIED')`. Nothing here
    // read that status, so a delivery landing on an APPLIED row re-stamped
    // `publicationRevision` and wrote `completedSteps: []` back over a tail that
    // was still checkpointing against them.
    mocks.assertTextEditLeaseTx.mockResolvedValue({ status: "APPLIED", classifier: {} });

    await expect(
      publishTextEditManuscript(publicationOptions([publicationPage(1)]))
    ).rejects.toThrow("Text edit wait gave up without owning the delivery");

    expect(mocks.tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(mocks.tx.bookEditOperation.updateMany).not.toHaveBeenCalled();
    expect(mocks.settleDurableEditAttemptTx).not.toHaveBeenCalled();
  });

  it("rolls back when the ACTIVE-fenced APPLIED write matches no row", async () => {
    mocks.tx.$queryRawUnsafe
      .mockResolvedValueOnce([{
        inputCount: 1,
        distinctPageCount: 1,
        resolvedSnapshotCount: 1,
        validSnapshotCount: 1,
        updatedPageCount: 1,
        updatedSnapshotCount: 1
      }])
      .mockResolvedValueOnce([{ contentRevision: 8 }]);
    mocks.tx.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      publishTextEditManuscript(publicationOptions([publicationPage(1)]))
    ).rejects.toThrow("Text edit wait gave up without owning the delivery");

    expect(mocks.settleDurableEditAttemptTx).not.toHaveBeenCalled();
  });

  it("stamps the export barrier through the primitive the other publications can call", async () => {
    // Three sibling publications commit a revision and unlink the shared export
    // files afterwards with no barrier at all, so the stamp is a named call
    // rather than another column fused onto the revision statement.
    mocks.tx.$queryRawUnsafe
      .mockImplementationOnce(async () => [{
        inputCount: 1,
        distinctPageCount: 1,
        resolvedSnapshotCount: 1,
        validSnapshotCount: 1,
        updatedPageCount: 1,
        updatedSnapshotCount: 1
      }])
      .mockImplementationOnce(async (sql: string) => {
        expect(sql).not.toContain("exportInvalidationRevision");
        return [{ contentRevision: 8 }];
      });

    await publishTextEditManuscript(publicationOptions([publicationPage(1)]));

    expect(mocks.tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { exportInvalidationRevision: 8 }
    });
  });

  it("aborts the atomic publication when any exact page or snapshot count is short", async () => {
    let rolledBack = false;
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: typeof mocks.tx) => Promise<unknown>) => {
      try {
        return await run(mocks.tx);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    mocks.tx.$queryRawUnsafe.mockResolvedValueOnce([{
      inputCount: 2,
      distinctPageCount: 2,
      resolvedSnapshotCount: 2,
      validSnapshotCount: 2,
      updatedPageCount: 1,
      updatedSnapshotCount: 1
    }]);

    await expect(
      publishTextEditManuscript(publicationOptions([publicationPage(1), publicationPage(2)]))
    ).rejects.toThrow("did not update every exact page/snapshot pair");

    expect(rolledBack).toBe(true);
    expect(mocks.tx.bookEditOperation.updateMany).not.toHaveBeenCalled();
    expect(mocks.settleDurableEditAttemptTx).not.toHaveBeenCalled();
  });
});

describe("adoptLegacyTextEditTail", () => {
  beforeEach(() => {
    mocks.tx.project.findUnique.mockResolvedValue({ currentPlanId: "plan-1", contentRevision: 8 });
    mocks.assertTextEditLeaseTx.mockResolvedValue({ status: "APPLIED", classifier: {} });
  });

  it("restores the stamped status when no plan can be handed to a compile", async () => {
    mocks.tx.project.findUnique.mockResolvedValue({ currentPlanId: null, contentRevision: 8 });

    await expect(
      adoptLegacyTextEditTail({
        projectId: "project-1",
        operationId: "operation-1",
        ownerToken: "owner-1",
        fallbackStatus: "REVIEW_REQUIRED"
      })
    ).resolves.toBeNull();

    // The claim above committed EDITING, and only a compile takes it back out.
    expect(mocks.claimAppliedEditPublication).toHaveBeenCalledTimes(1);
    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.tx, "project-1", "operation-1", "REVIEW_REQUIRED"
    );
    expect(mocks.tx.bookEditOperation.update).not.toHaveBeenCalled();
  });

  it("claims nothing to restore when a newer lifecycle owns the publication window", async () => {
    mocks.claimAppliedEditPublication.mockResolvedValue(false);

    await expect(
      adoptLegacyTextEditTail({
        projectId: "project-1",
        operationId: "operation-1",
        ownerToken: "owner-1",
        fallbackStatus: "REVIEW_REQUIRED"
      })
    ).resolves.toBeNull();

    expect(mocks.restoreEditProjectStatus).not.toHaveBeenCalled();
  });

  it("adopts the current revision and checkpoints the steps the old publication already ran", async () => {
    await expect(
      adoptLegacyTextEditTail({
        projectId: "project-1",
        operationId: "operation-1",
        ownerToken: "owner-1",
        planVersionId: "plan-1",
        fallbackStatus: "REVIEW_REQUIRED"
      })
    ).resolves.toEqual(identity);

    expect(mocks.restoreEditProjectStatus).not.toHaveBeenCalled();
    expect(mocks.tx.bookEditOperation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publicationRevision: 8,
          classifier: expect.objectContaining({
            textEditFollowUp: expect.objectContaining({ completedSteps: ["exports", "memory"] })
          })
        })
      })
    );
  });
});

describe("text edit publication follow-up", () => {
  let classifier: ReturnType<typeof followUpClassifier>;
  let project: {
    contentRevision: number;
    currentPlanId: string;
    status: string;
    exportInvalidationRevision: number | null;
  };
  let transactionOpen: boolean;

  beforeEach(() => {
    classifier = followUpClassifier();
    project = {
      contentRevision: 8,
      currentPlanId: "plan-1",
      status: "EDITING",
      exportInvalidationRevision: 8
    };
    transactionOpen = false;
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: typeof mocks.tx) => Promise<unknown>) => {
      transactionOpen = true;
      try {
        return await run(mocks.tx);
      } finally {
        transactionOpen = false;
      }
    });
    mocks.prisma.bookEditOperation.findUnique.mockImplementation(async () => ({ classifier }));
    mocks.assertTextEditLeaseTx.mockImplementation(async () => ({ status: "APPLIED", classifier }));
    mocks.tx.project.update.mockImplementation(async ({ select }: { select?: Record<string, boolean> }) => {
      if (select?.contentRevision) return { ...project };
      if (select?.exportInvalidationRevision) {
        return { exportInvalidationRevision: project.exportInvalidationRevision };
      }
      return {};
    });
    mocks.tx.project.updateMany.mockImplementation(async ({ where, data }) => {
      if ("exportInvalidationRevision" in where && "exportInvalidationRevision" in data) {
        if (project.exportInvalidationRevision !== where.exportInvalidationRevision) return { count: 0 };
        project.exportInvalidationRevision = data.exportInvalidationRevision;
      }
      if (data.status) project.status = data.status;
      return { count: 1 };
    });
    mocks.tx.bookEditOperation.update.mockImplementation(async ({ data }) => {
      if (data.classifier) classifier = data.classifier;
      return {};
    });
    mocks.restoreEditProjectStatus.mockImplementation(
      async (_tx, _projectId, _operationId, fallbackStatus) => {
        project.status = fallbackStatus;
        return true;
      }
    );
    mocks.invalidateProjectExports.mockImplementation(async () => {
      expect(transactionOpen).toBe(false);
    });
  });

  it("runs invalidation outside SQL, fences memory, and durably checkpoints every step", async () => {
    const memory = [{
      pageId: "page-1",
      pageIndex: 1,
      pageRevision: 4,
      summary: "New summary 1",
      preparedEmbedding: { vectorLiteral: "[0.1]", error: null }
    }];
    mocks.tx.page.count.mockResolvedValue(1);
    mocks.tx.$queryRawUnsafe.mockResolvedValue([{ count: 1 }]);
    mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");
    const completion = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory });

    await completion.afterJobCompleted?.();

    expect(mocks.invalidateProjectExports).toHaveBeenCalledWith("project-1");
    expect(project.exportInvalidationRevision).toBeNull();
    expect(mocks.tx.page.count).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        OR: [{ id: "page-1", index: 1, revision: 4, summary: "New summary 1" }]
      }
    });
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(
      "project-1",
      "plan-1",
      { skipFinalReview: true },
      { contentRevision: 8, requireContentRevisionMatch: true }
    );
    expect(project.status).toBe("REVIEW_REQUIRED");
    expect(classifier.textEditFollowUp.completedSteps).toEqual(["exports", "memory", "compile", "status"]);
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("operation-1", "owner-1");
  });

  it("abandons the barrier when even the retry cannot clear it, and never unlinks again", async () => {
    // Two rejections: the step's own checkpoint and the retry the abandon path
    // makes behind it. The value left standing is the revision *every* later
    // reader of this book claims, so `publishCompiledExports`,
    // `publishRebuiltExport` and the provenance repair all refuse it, the
    // project never leaves EDITING and `ensureExportRepairQueued` cannot reach
    // it either. The delayed stranded sweep is the final backstop, but this tail
    // should not make the reader wait for its lease to expire first.
    mocks.tx.project.updateMany
      .mockRejectedValueOnce(new Error("database unavailable after unlink"))
      .mockRejectedValueOnce(new Error("database unavailable after unlink"));
    mocks.prisma.project.updateMany.mockImplementation(async ({ where, data }) => {
      if (project.exportInvalidationRevision !== where.exportInvalidationRevision) return { count: 0 };
      project.exportInvalidationRevision = data.exportInvalidationRevision;
      return { count: 1 };
    });
    const first = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory: [] });

    await expect(first.afterJobCompleted?.()).rejects.toThrow("database unavailable after unlink");

    expect(mocks.releaseTextEditTailLease).toHaveBeenCalledWith("operation-1", "owner-1");
    expect(classifier.textEditFollowUp.completedSteps).toEqual([]);
    expect(project.exportInvalidationRevision).toBeNull();
    expect(mocks.prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: "project-1", exportInvalidationRevision: 8 },
      data: { exportInvalidationRevision: null }
    });

    // Clearing early is only safe because a cleared barrier is also the tail's
    // own word for "already retired": the replay checkpoints the step instead
    // of deleting files a compile may since have installed.
    mocks.invalidateProjectExports.mockClear();
    mocks.tx.project.updateMany.mockImplementation(async ({ where, data }) => {
      if ("exportInvalidationRevision" in where && "exportInvalidationRevision" in data) {
        project.exportInvalidationRevision = data.exportInvalidationRevision;
      }
      if (data.status) project.status = data.status;
      return { count: 1 };
    });
    const replay = textEditPublicationCompletion({ identity, ownerToken: "owner-2", memory: [] });
    await replay.afterJobCompleted?.();

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(project.exportInvalidationRevision).toBeNull();
    expect(classifier.textEditFollowUp.completedSteps).toEqual(["exports", "memory", "compile", "status"]);
  });

  it("leaves the barrier to the successor that took the lease off it", async () => {
    // A release that matched no row is a live successor inside this tail — or a
    // tail already complete. Either way the barrier is not this delivery's to
    // abandon: clearing it could let a compile install files the successor's
    // own unlink is about to delete.
    mocks.releaseTextEditTailLease.mockResolvedValue(false);
    mocks.tx.project.updateMany
      .mockRejectedValueOnce(new Error("database unavailable after unlink"))
      .mockRejectedValueOnce(new Error("database unavailable after unlink"));
    const completion = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory: [] });

    await expect(completion.afterJobCompleted?.()).rejects.toThrow("database unavailable after unlink");

    expect(mocks.prisma.project.updateMany).not.toHaveBeenCalled();
    expect(project.exportInvalidationRevision).toBe(8);
  });

  it("does not settle the project when a newer operation or job owns its EDITING", async () => {
    // A successor can take EDITING before it advances the manuscript revision,
    // and a presentation lifecycle has no BookEditOperation at all. The shared
    // ownership guard covers both shapes; a status-only restore does not.
    mocks.restoreEditProjectStatus.mockResolvedValue(false);
    mocks.maybeEnqueueCompile.mockResolvedValue("not-ready");
    const completion = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory: [] });

    await completion.afterJobCompleted?.();

    expect(mocks.restoreEditProjectStatus).toHaveBeenCalledWith(
      mocks.tx,
      "project-1",
      "operation-1",
      "REVIEW_REQUIRED"
    );
    expect(project.status).toBe("EDITING");
    expect(classifier.textEditFollowUp.completedSteps).toEqual(["exports", "memory", "compile", "status"]);
  });

  it("stands the tail down when the row it is the tail of is no longer APPLIED", async () => {
    mocks.assertTextEditLeaseTx.mockImplementation(async () => ({ status: "ACTIVE", classifier }));
    const completion = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory: [] });

    await expect(completion.afterJobCompleted?.()).rejects.toThrow("no longer owns an APPLIED edit");

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
  });

  it("lets a failed lease completion travel instead of reporting the tail as done", async () => {
    // Returning here is how `afterJobCompleted` reports success, so Bull marked
    // the job done over a row still carrying this delivery's token with
    // `structuralLeaseCompletedAt` NULL — never completed, and never released
    // either, because only a rejection reaches the catch that hands it back.
    mocks.completeTextEditLease.mockRejectedValue(new Error("pool timeout"));
    const completion = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory: [] });

    await expect(completion.afterJobCompleted?.()).rejects.toThrow("pool timeout");

    expect(mocks.releaseTextEditTailLease).toHaveBeenCalledWith("operation-1", "owner-1");
    expect(classifier.textEditFollowUp.completedSteps).toEqual(["exports", "memory", "compile", "status"]);
  });

  it("waits out a compare-and-set miss instead of treating it as a failed completion", async () => {
    mocks.completeTextEditLease.mockResolvedValue(false);
    const completion = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory: [] });

    await expect(completion.afterJobCompleted?.()).resolves.toBeUndefined();

    expect(mocks.waitForTextEditLeaseCompletion).toHaveBeenCalledWith("operation-1");
    expect(mocks.releaseTextEditTailLease).not.toHaveBeenCalled();
  });

  it("throws unowned when the completion wait is abandoned", async () => {
    mocks.completeTextEditLease.mockResolvedValue(false);
    mocks.waitForTextEditLeaseCompletion.mockResolvedValue("abandoned");
    const completion = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory: [] });

    await expect(completion.afterJobCompleted?.()).rejects.toMatchObject({
      name: "UnownedTextEditDeliveryError"
    });

    expect(mocks.releaseTextEditTailLease).toHaveBeenCalledWith("operation-1", "owner-1");
  });

  it("retires the barrier it stamped before handing the tail back", async () => {
    // The stamping operation's own tail is the immediate clear path, and every
    // export publisher stands down while it is set. The delayed lease-aware
    // sweep is a backstop, not a substitute for handing this delivery back.
    mocks.tx.project.updateMany.mockRejectedValueOnce(new Error("database blip after unlink"));
    const completion = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory: [] });

    await expect(completion.afterJobCompleted?.()).rejects.toThrow("database blip after unlink");

    expect(project.exportInvalidationRevision).toBeNull();
    expect(classifier.textEditFollowUp.completedSteps).toEqual(["exports"]);
    expect(mocks.releaseTextEditTailLease).toHaveBeenCalledWith("operation-1", "owner-1");
  });

  it("leaves a barrier a newer tail owns untouched when it gives up", async () => {
    project.exportInvalidationRevision = 9;
    mocks.maybeEnqueueCompile.mockImplementation(async () => {
      throw new Error("unreachable");
    });
    mocks.tx.project.update.mockImplementationOnce(async () => {
      throw new Error("pool timeout");
    });
    const completion = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory: [] });

    await expect(completion.afterJobCompleted?.()).rejects.toThrow("pool timeout");

    expect(project.exportInvalidationRevision).toBe(9);
    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
  });

  it("degrades a compile enqueue outage to not-ready instead of throwing through the tail", async () => {
    // The manuscript is committed and the exports are already retired. Failing
    // here retries a delivered edit until Bull gives up, after which the job
    // stays COMPLETED and nothing takes the book out of EDITING again.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.maybeEnqueueCompile.mockRejectedValue(new Error("queue unavailable"));
    const completion = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory: [] });

    await expect(completion.afterJobCompleted?.()).resolves.toBeUndefined();

    expect(project.status).toBe("REVIEW_REQUIRED");
    expect(project.exportInvalidationRevision).toBeNull();
    expect(classifier.textEditFollowUp.completedSteps).toEqual(["exports", "memory", "compile", "status"]);
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("operation-1", "owner-1");
    expect(mocks.releaseTextEditTailLease).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("never invalidates or publishes memory for a superseded revision", async () => {
    project = {
      ...project,
      contentRevision: 9,
      exportInvalidationRevision: 9
    };
    const completion = textEditPublicationCompletion({
      identity,
      ownerToken: "owner-1",
      memory: [{
        pageId: "page-1",
        pageIndex: 1,
        pageRevision: 4,
        summary: "New summary 1",
        preparedEmbedding: { vectorLiteral: "[0.1]", error: null }
      }]
    });

    await completion.afterJobCompleted?.();

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(mocks.tx.page.count).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
    expect(project.exportInvalidationRevision).toBe(9);
  });

  it("skips the optional memory write an edited page no longer matches, and still compiles", async () => {
    // The fingerprint miss is not supersession, and everything after it is not
    // optional: returning here left the book EDITING at the published revision
    // with its exports already unlinked, no compile behind it, and a completed
    // tail lease standing every redelivery down.
    classifier = followUpClassifier(["exports"]);
    project.exportInvalidationRevision = null;
    mocks.tx.page.count.mockResolvedValue(0);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const completion = textEditPublicationCompletion({
      identity,
      ownerToken: "owner-1",
      memory: [{
        pageId: "page-1",
        pageIndex: 1,
        pageRevision: 4,
        summary: "New summary 1",
        preparedEmbedding: { vectorLiteral: "[0.1]", error: null }
      }]
    });

    await completion.afterJobCompleted?.();

    expect(mocks.tx.page.count).toHaveBeenCalledTimes(1);
    // Nothing describes a page these embeddings were not prepared from.
    expect(mocks.tx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledTimes(1);
    expect(classifier.textEditFollowUp.completedSteps).toEqual(["exports", "memory", "compile", "status"]);
    expect(mocks.completeTextEditLease).toHaveBeenCalledWith("operation-1", "owner-1");
    expect(warned).toHaveBeenCalledWith(
      expect.stringContaining("skipped semantic memory"),
      expect.objectContaining({ event: "generation.text_edit_tail_memory_unverified", matched: 0 })
    );
    warned.mockRestore();
  });

  it("degrades a failed optional vector write without poisoning publication progress", async () => {
    classifier = followUpClassifier(["exports"]);
    project.exportInvalidationRevision = null;
    mocks.tx.page.count.mockResolvedValue(1);
    mocks.tx.$queryRawUnsafe.mockRejectedValueOnce(new Error("vector extension unavailable"));
    mocks.tx.$executeRawUnsafe.mockResolvedValue(1);
    mocks.runBestEffortPageMemoryWrite
      .mockImplementationOnce(async (_tx, run) => {
        try {
          return await run();
        } catch {
          return null;
        }
      })
      .mockImplementationOnce(async (_tx, run) => run());
    const completion = textEditPublicationCompletion({
      identity,
      ownerToken: "owner-1",
      memory: [{
        pageId: "page-1",
        pageIndex: 1,
        pageRevision: 4,
        summary: "New summary 1",
        preparedEmbedding: { vectorLiteral: "[0.1]", error: null }
      }]
    });

    await completion.afterJobCompleted?.();

    expect(mocks.tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("vectorStored"),
      "project-1",
      expect.stringContaining("Bulk vector persistence unavailable")
    );
    expect(classifier.textEditFollowUp.completedSteps).toEqual(["exports", "memory", "compile", "status"]);
  });

  it("recovers a committed unlink whose classifier checkpoint was not observed", async () => {
    project.exportInvalidationRevision = null;
    const completion = textEditPublicationCompletion({ identity, ownerToken: "owner-1", memory: [] });

    await completion.afterJobCompleted?.();

    expect(mocks.invalidateProjectExports).not.toHaveBeenCalled();
    expect(classifier.textEditFollowUp.completedSteps).toEqual(["exports", "memory", "compile", "status"]);
  });
});
