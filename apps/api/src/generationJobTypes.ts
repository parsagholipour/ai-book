import { type GenerationJobType } from "@book-maker/core";

/**
 * Which failed `GenerationJob` types a recovery surface may offer, and what it
 * offers for each — the four lists every failure read filters on.
 *
 * A leaf module on purpose. These used to be declared three times over, byte
 * for byte, in `mobile/schemas.ts`, `projectStatus.ts` and `routes/projects.ts`
 * with no import between them, which is how a new job type ends up recoverable
 * on one surface and invisible on another. The obvious repair — importing the
 * exported copy in `mobile/schemas.ts` — closes a cycle: that file reaches
 * `projectStatus.ts` through `mobile/dto.ts`. So the definition lives here,
 * importing nothing but a type, and all three read it.
 *
 * `mobile/schemas.ts` re-exports them under their original names, because that
 * is the path `mobile/routes/plans.ts` and the mobile suites already import.
 */

/** Planning jobs whose failure is retried by re-running the plan itself. */
export const retryablePlanningJobTypes: GenerationJobType[] = ["PLAN_BOOK", "REVISE_PLAN"];

/** Jobs a resume can pick up from the work already settled on disk. */
export const resumableJobTypes: GenerationJobType[] = [
  "GENERATE_PAGE",
  "GENERATE_IMAGE",
  "COMPILE_EXPORT",
  "APPLY_BOOK_EDIT"
];

/** Jobs that have to start over rather than resume. */
export const restartableJobTypes: GenerationJobType[] = ["GENERATE_BOOK", "REPLAN_BOOK"];

/** Every job type whose failure is the book's own trouble to report. */
export const generationFailureJobTypes = [
  ...retryablePlanningJobTypes,
  ...resumableJobTypes,
  ...restartableJobTypes
];
