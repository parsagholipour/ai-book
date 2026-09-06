root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
p=root+'packages/core/src/generation/composedChapter.ts'; s=open(p).read()
old='''  const mode = inferWritingMode(options.input, options.plan);
  const cap = manuscriptReadEditCap(options.chapters.length);
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: READ_MANUSCRIPT_PURPOSE,
    temperature: 0.3,
    maxTokens: 6000,'''
new='''  const mode = inferWritingMode(options.input, options.plan);
  const cap = manuscriptReadEditCap(options.chapters.length);
  // The read returns notes, never prose, so a provider failure here is a
  // skipped read and not a failed book: composed-17 composed every chapter and
  // then failed at 70% on "OpenAI response was incomplete: max_output_tokens",
  // because at effort high the reasoning shares this output budget. The
  // budget is sized for that now; a cancellation still propagates.
  let result: { data: z.infer<typeof manuscriptReadSchema> };
  try {
    result = await generateJsonWithRetry(options.textModel, {
    purpose: READ_MANUSCRIPT_PURPOSE,
    temperature: 0.3,
    maxTokens: 16000,'''
assert old in s; s=s.replace(old,new,1)
old='''  });
  const known = new Set(options.chapters.map((chapter) => chapter.index));
  let edits = 0;'''
new='''  });
  } catch (error) {
    if (isStopOrAbortError(error)) {
      throw error;
    }
    return { chapters: [], bookNotes: [], skipped: `read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const known = new Set(options.chapters.map((chapter) => chapter.index));
  let edits = 0;'''
assert old in s; s=s.replace(old,new,1)
old='''import { authorStancePromptLines, isNarrativeWritingMode } from "./authorStance.js";'''
new='''import { isStopOrAbortError } from "../adapters/retry.js";
import { authorStancePromptLines, isNarrativeWritingMode } from "./authorStance.js";'''
assert old in s; s=s.replace(old,new,1)
open(p,'w').write(s); print("read degrade patch applied")
