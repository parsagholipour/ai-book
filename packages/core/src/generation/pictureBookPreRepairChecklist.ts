import { z } from "zod";

export const pictureBookRequirementChecksSchema = z.array(z.strictObject({
  requirementIndex: z.number().int().nonnegative(), evidence: z.string().trim().min(1).max(300).nullable()
})).max(64);
