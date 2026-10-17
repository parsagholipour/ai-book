import { MAX_PICTURE_BOOK_PAGES } from "./pageCountAllowance.js";
import { z } from "zod";
import { pictureBookReviewRowSchema } from "./pictureBookReviewValidation.js";

export const pictureBookCitationRowsSchema = z.array(pictureBookReviewRowSchema).max(MAX_PICTURE_BOOK_PAGES);
export type PictureBookCitationRow = z.infer<typeof pictureBookReviewRowSchema>;
