import { z } from "zod";

/** A guide's or a workbook's recurring example person (`generation/exampleCast.ts`): a name and the one role they keep. */
export const exampleCastMemberSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().min(3).max(200),
  /** The chapter where a toolkit book introduces this person, the one place their role is explained (`exampleCastLinesForChapter`). */
  introducedIn: z.number().int().positive().optional().catch(undefined)
});
export type ExampleCastMember = z.infer<typeof exampleCastMemberSchema>;
export const exampleCastSchema = z.array(exampleCastMemberSchema).max(6);
