"""Move the manuscript read out of composedChapter.ts (size gate) into manuscriptRead.ts; re-export so no consumer changes."""
import re
root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
p=root+'packages/core/src/generation/composedChapter.ts'; s=open(p).read()
if 'from "./manuscriptRead.js"' in s:
    print('already split'); raise SystemExit
start=s.index('export type ManuscriptChapterForRead = {')
end=s.index('/** A chapter\'s digest for later chapters')
block=s[start:end]
# the two constants with their comments
m=re.search(r'\n(/\*\*[^\n]*\n(?: \*[^\n]*\n)*? \*/\n)?export const READ_MANUSCRIPT_PURPOSE = "read-manuscript";\n', s)
assert m, 'purpose const'
purpose=m.group(0)
m2=re.search(r'\n(/\*\*[^\n]*\n(?: \*[^\n]*\n)*? \*/\n)?export const MANUSCRIPT_READ_MAX_WORDS = 110_000;\n', s)
assert m2, 'max words const'
maxwords=m2.group(0)
s=s[:start]+s[end:]
s=s.replace(purpose,'\n',1).replace(maxwords,'\n',1)
s=s.replace('import { inferWritingMode } from "./styleContract.js";','import { inferWritingMode } from "./styleContract.js";\nexport {\n  MANUSCRIPT_READ_MAX_WORDS,\n  READ_MANUSCRIPT_PURPOSE,\n  manuscriptReadEditCap,\n  readManuscript,\n  type ManuscriptChapterForRead,\n  type ManuscriptReadResult\n} from "./manuscriptRead.js";',1)
open(p,'w').write(s)
header='''import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { isStopOrAbortError } from "../adapters/retry.js";
import { targetLanguageGenerationGuidance } from "../prompting/language.js";
import type { AuthorStance, BookPlan, CreateProjectInput } from "../schemas/book.js";
import { isNarrativeWritingMode } from "./authorStance.js";
import type { BookArc } from "./bookArc.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { countReadableWords } from "./proseShape.js";
import { inferWritingMode } from "./styleContract.js";

/**
 * The whole-manuscript read of the composed-chapters pass: one call over
 * every chapter after the line edits, returning notes (never prose) — which
 * chapters to cut, what recurs across the book, where the argument stops
 * developing, and under an arc where the answer was stated early. Split out
 * of `composedChapter.ts` on 2026-09-03 for the file-size budget; the
 * barrel still reaches it through that module's re-export.
 */
'''
open(root+'packages/core/src/generation/manuscriptRead.ts','w').write(header+purpose.strip()+'\n\n'+maxwords.strip()+'\n\n'+block.rstrip()+'\n')
print('split done')
