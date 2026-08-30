export function staleGenerationTargetReason(input: {
  durableProjectId: string;
  payloadProjectId: string;
  type: string;
  planId: string | null;
  currentPlanId: string | null;
  pageId: string | null;
  pageProjectId: string | null;
  contentRevision: number | null;
  projectContentRevision: number;
  expectedProjectStatus?: string | null;
  projectStatus?: string;
  jobCreatedCurrentPlan?: boolean;
  jobTargetsStagedReplan?: boolean;
}): string | null {
  if (input.durableProjectId !== input.payloadProjectId) {
    return "The job targets a different project than its durable record.";
  }
  const planBoundTypes = new Set([
    "REVISE_PLAN",
    "GENERATE_BOOK",
    "GENERATE_PAGE",
    "GENERATE_IMAGE",
    "COMPILE_EXPORT",
    "APPLY_BOOK_EDIT"
  ]);
  if (
    input.planId &&
    planBoundTypes.has(input.type) &&
    input.currentPlanId !== input.planId &&
    !(input.type === "APPLY_BOOK_EDIT" && input.jobCreatedCurrentPlan) &&
    !(input.type === "GENERATE_BOOK" && input.jobTargetsStagedReplan)
  ) {
    return "The job targets a superseded book plan.";
  }
  if (input.pageId && input.pageProjectId !== input.payloadProjectId) {
    return "The job targets a missing page or a page from another project.";
  }
  if (
    (input.type === "COMPILE_EXPORT" ||
      (input.type === "GENERATE_IMAGE" && input.expectedProjectStatus !== null && input.expectedProjectStatus !== undefined)) &&
    input.contentRevision !== null &&
    input.contentRevision !== input.projectContentRevision
  ) {
    return "The manuscript changed after this export job was queued.";
  }
  if (
    input.type === "GENERATE_IMAGE" &&
    input.expectedProjectStatus !== null &&
    input.expectedProjectStatus !== undefined &&
    input.projectStatus !== input.expectedProjectStatus
  ) {
    return "The project changed status after this publication job was queued.";
  }
  return null;
}
