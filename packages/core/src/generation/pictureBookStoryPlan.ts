import type { JsonResult, TextModelAdapter } from "../adapters/types.js";
import { bookPlanSchema, pictureBookStoryPlanSchema, type BookPlan } from "../schemas/plan.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { compactPictureBookPlanMessages } from "./compactPictureBookPlanning.js";

/** Replaces the ordinary planning call; pagination remains the later map call. */
export async function generatePictureBookStoryPlan(options: {
  input: CreateProjectInput; fallback: BookPlan; textModel: TextModelAdapter;
}): Promise<JsonResult<Omit<BookPlan, "researchNotes">>> {
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "plan-book", temperature: Math.min(0.8, options.input.temperature),
    schema: pictureBookStoryPlanSchema(options.fallback),
    messages: compactPictureBookPlanMessages(options.input, true)
  });
  // One temporary container satisfies the existing plan/storage contract. It is
  // never an instruction to the mapper; the actual groups are chosen there.
  const data = bookPlanSchema.parse({ ...result.data, chapters: [{
    index: 1, title: result.data.title, summary: result.data.premise,
    targetPages: options.input.targetPages, keyBeats: [], illustrationPrompts: []
  }] });
  return { ...result, data };
}
