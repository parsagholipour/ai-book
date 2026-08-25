import { type SettledProjectStatus } from "@book-maker/core";

/** The settled status an Apply job must restore after its enqueue sets EDITING. */
export function settledStatusBeforeEdit(projectStatus: string): SettledProjectStatus {
  return projectStatus === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE";
}
