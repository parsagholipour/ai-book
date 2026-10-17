import { MAX_PICTURE_BOOK_PAGES } from "./pageCountAllowance.js";
import { z } from "zod";
import { pictureBookFindingSchema, pictureBookReviewRowSchema } from "./pictureBookReviewValidation.js";

// A pending diagnosis is not editing authority. Keep its original scope and all
// supplied citations until a bounded correction passes the ordinary validator.
const pendingFinding = pictureBookFindingSchema.extend({
  repairPageIndexes: z.unknown().optional(),
  relatedEvidence: z.array(pictureBookFindingSchema.shape.relatedEvidence.removeDefault().element).max(MAX_PICTURE_BOOK_PAGES).default([])
});
const pendingRow = pictureBookReviewRowSchema.extend({ findings: z.array(pendingFinding).min(1).max(8) });
export const pictureBookMetadataRowsSchema = z.array(pendingRow).max(MAX_PICTURE_BOOK_PAGES);
export type PictureBookMetadataRow = z.infer<typeof pendingRow>;
