import type { PictureBookEditorialRow } from "./pictureBookReviewRecovery.js";
import type { PictureBookCitationRow } from "./pictureBookReviewCitations.js";
import type { PictureBookMetadataRow } from "./pictureBookReviewMetadata.js";
import type { PictureBookPageReview } from "./pictureBookReviewValidation.js";
export type { PictureBookPageReview, PictureBookReviewChecks } from "./pictureBookReviewValidation.js";

export type PictureBookReviewCheckpoint = {
  version: 2; reviews: PictureBookPageReview[]; unresolvedPageIndexes: number[];
  validationIssues: { pageIndex: number; message: string }[]; protocolIssues: string[];
  roundsStarted: number; attemptsUsed: number; outputWidened: boolean;
  /** Original unverified judgments survive recovery, exhaustion and worker restarts. */
  citationRows?: PictureBookCitationRow[];
  /** Grounded prose assessments survive malformed auxiliary story/style checks. */
  editorialRows?: PictureBookEditorialRow[];
  /** Grounded diagnoses survive invalid repair scope or excess supporting citations. */
  metadataRows?: PictureBookMetadataRow[];
};
export class PictureBookReviewIncompleteError extends Error {
  constructor(readonly checkpoint: PictureBookReviewCheckpoint, cause?: unknown) {
    super(`Picture-book review incomplete; unverified pages: ${checkpoint.unresolvedPageIndexes.join(", ") || "none"}.${checkpoint.protocolIssues.length ? ` ${checkpoint.protocolIssues.join(" ")}` : ""}`, { cause });
    this.name = "PictureBookReviewIncompleteError";
  }
}

export { pictureBookReviewKind, type PictureBookReviewKind } from "./pictureBookReviewContext.js";
export { pictureBookCitationRowsSchema } from "./pictureBookReviewCitations.js";
export { pictureBookMetadataRowsSchema } from "./pictureBookReviewMetadata.js";
