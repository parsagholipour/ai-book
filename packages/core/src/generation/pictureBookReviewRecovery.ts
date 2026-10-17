import { z } from "zod";
import { pictureBookReviewRowSchema } from "./pictureBookReviewValidation.js";

const editorialRowSchema = pictureBookReviewRowSchema.partial({ storyExtract: true, styleAudit: true });
export type PictureBookEditorialRow = z.infer<typeof editorialRowSchema>;
