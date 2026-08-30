import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@book-maker/db", () => ({ prisma: { $queryRawUnsafe: mocks.query } }));
vi.mock("@book-maker/core", () => ({
  jsonPayloadToRecord: (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : {}
}));

import { stagedReplanSuccessorProof } from "./stagedReplanJobGuard.js";

const options = {
  targetProjectId: "project-target",
  generationJobId: "job-successor",
  operationId: "operation-1",
  stagedPlanId: "plan-staged"
};

function inPlaceRow() {
  return {
    jobId: "job-successor",
    jobProjectId: "project-target",
    jobType: "GENERATE_BOOK",
    jobStatus: "QUEUED",
    targetProjectId: "project-target",
    targetCurrentPlanId: "plan-source",
    targetStatus: "EDITING",
    operationId: "operation-1",
    operationProjectId: "project-target",
    operationSourceProjectId: "project-target",
    operationGenerationJobId: "job-successor",
    operationKind: "BOOK_REPLAN",
    operationStatus: "ACTIVE",
    operationClassifier: {
      replanStagedPlanId: "plan-staged",
      replanSuccessorJobId: "job-successor",
      replanSourcePlanId: "plan-source"
    },
    stagedPlanId: "plan-staged",
    stagedPlanProjectId: "project-target",
    stagedPlanStatus: "DRAFT",
    sourceProjectId: "project-target",
    sourceCurrentPlanId: "plan-source",
    sourcePlanId: "plan-source",
    sourcePlanProjectId: "project-target",
    sourcePlanStatus: "APPROVED"
  };
}

function copyRow() {
  return {
    ...inPlaceRow(),
    targetCurrentPlanId: null,
    operationProjectId: "project-source",
    operationSourceProjectId: "project-source",
    sourceProjectId: "project-source",
    sourcePlanProjectId: "project-source"
  };
}

describe("exact staged replan successor proof", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["in-place staging", inPlaceRow()],
    ["copy staging", copyRow()],
    ["an ACTIVE redelivery of the same durable identity", { ...copyRow(), jobStatus: "ACTIVE" }]
  ])("accepts %s", async (_label, row) => {
    mocks.query.mockResolvedValue([row]);

    await expect(stagedReplanSuccessorProof(options)).resolves.toBe("exact");

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM "GenerationJob" AS job'),
      "project-target",
      "job-successor",
      "operation-1",
      "plan-staged"
    );
  });

  it.each([
    ["job id", { jobId: "job-other" }],
    ["job project", { jobProjectId: "project-other" }],
    ["job type", { jobType: "GENERATE_PAGE" }],
    ["completed job status", { jobStatus: "COMPLETED" }],
    ["canceled job status", { jobStatus: "CANCELED" }],
    ["target project", { targetProjectId: "project-other" }],
    ["target staging status", { targetStatus: "GENERATING" }],
    ["operation id", { operationId: "operation-other" }],
    ["operation owner", { operationProjectId: "project-other" }],
    ["operation relink", { operationGenerationJobId: "job-other" }],
    ["operation kind", { operationKind: "PAGE_REWRITE" }],
    ["applied operation", { operationStatus: "APPLIED" }],
    ["canceled operation", { operationStatus: "CANCELED" }],
    ["staged plan id", { stagedPlanId: "plan-other" }],
    ["staged plan project", { stagedPlanProjectId: "project-other" }],
    ["approved staged plan", { stagedPlanStatus: "APPROVED" }],
    ["missing source project", { sourceProjectId: null }],
    ["changed source current plan", { sourceCurrentPlanId: "plan-newer" }],
    ["missing source plan", { sourcePlanId: null }],
    ["source plan project", { sourcePlanProjectId: "project-other" }],
    ["superseded source plan", { sourcePlanStatus: "SUPERSEDED" }],
    ["superseded in-place current plan", { targetCurrentPlanId: "plan-newer" }]
  ])("rejects a mismatched %s", async (_label, change) => {
    mocks.query.mockResolvedValue([{ ...inPlaceRow(), ...change }]);
    await expect(stagedReplanSuccessorProof(options)).resolves.toBe("mismatch");
  });

  it.each([
    ["classifier staged plan", { replanStagedPlanId: "plan-other" }],
    ["classifier successor", { replanSuccessorJobId: "job-other" }],
    ["classifier source plan", { replanSourcePlanId: "plan-other" }],
    ["missing classifier successor", { replanSuccessorJobId: null }],
    ["missing classifier source plan", { replanSourcePlanId: null }]
  ])("rejects a mismatched %s", async (_label, classifierChange) => {
    const row = inPlaceRow();
    mocks.query.mockResolvedValue([{
      ...row,
      operationClassifier: { ...row.operationClassifier, ...classifierChange }
    }]);
    await expect(stagedReplanSuccessorProof(options)).resolves.toBe("mismatch");
  });

  // A replan queued before staging existed: it published its plan the old way,
  // so the whole staged shape below disagrees and none of the three stamps are
  // on the classifier. Reading that as supersession cancelled and refunded a
  // paid whole-book replan the moment a deploy landed under one in flight.
  it("has no opinion on a replan that was queued before staging existed", async () => {
    mocks.query.mockResolvedValue([{
      ...inPlaceRow(),
      targetStatus: "GENERATING",
      targetCurrentPlanId: "plan-staged",
      operationStatus: "APPLIED",
      operationClassifier: { intent: "book_replan" },
      stagedPlanStatus: "APPROVED"
    }]);

    await expect(stagedReplanSuccessorProof(options)).resolves.toBe("unstaged");
  });

  it("keeps the mismatch answer for an unstamped operation that is not a replan", async () => {
    mocks.query.mockResolvedValue([{
      ...inPlaceRow(),
      operationKind: "PAGE_REWRITE",
      operationClassifier: {}
    }]);

    await expect(stagedReplanSuccessorProof(options)).resolves.toBe("mismatch");
  });

  it("rejects a copy once any current plan appears on its target", async () => {
    mocks.query.mockResolvedValue([{ ...copyRow(), targetCurrentPlanId: "plan-published-elsewhere" }]);
    await expect(stagedReplanSuccessorProof(options)).resolves.toBe("mismatch");
  });

  it.each([{ rows: [] }, { rows: [inPlaceRow(), inPlaceRow()] }])(
    "rejects a non-unique durable snapshot",
    async ({ rows }) => {
      mocks.query.mockResolvedValue(rows);
      await expect(stagedReplanSuccessorProof(options)).resolves.toBe("mismatch");
    }
  );
});
