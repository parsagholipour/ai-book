root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
def patch(path, pairs):
    s=open(root+path).read()
    for old,new in pairs:
        assert old in s, (path, old[:80]); s=s.replace(old,new,1)
    open(root+path,'w').write(s)

# 1. one position per chapter, rotated
patch('packages/core/src/generation/authorStance.ts', [
('''export function authorStancePromptLines(stance: AuthorStance, mode: WritingMode): string[] {
  const kind = isNarrativeWritingMode(mode) ? "story" : "book";
  return [
    `You are this ${kind}'s author. What it argues underneath everything, which the prose never states outright: ${stance.thesis}`,
    ...(stance.positions.length > 0 ? [`What you hold to be true, and write from: ${stance.positions.join(" | ")}`] : []),''',
 '''/**
 * The position a chapter writes from. Shown all five, every chapter of
 * composed-7 restated all five — the technology-extends-reach line, the
 * economic-insufficiency move, the limits-of-evidence caveat — and the panel
 * named each one as a refrain; one lens per chapter, rotated, is a content
 * assignment rather than a rule about shape.
 */
export function chapterPosition(stance: AuthorStance, chapterIndex: number): string | undefined {
  if (stance.positions.length === 0) {
    return undefined;
  }
  const slot = ((Math.max(1, Math.floor(chapterIndex)) - 1) % stance.positions.length + stance.positions.length) % stance.positions.length;
  return stance.positions[slot];
}

export function authorStancePromptLines(
  stance: AuthorStance,
  mode: WritingMode,
  options: { chapterIndex?: number | undefined } = {}
): string[] {
  const kind = isNarrativeWritingMode(mode) ? "story" : "book";
  const position = options.chapterIndex === undefined ? undefined : chapterPosition(stance, options.chapterIndex);
  return [
    `You are this ${kind}'s author. What it argues underneath everything, which the prose never states outright: ${stance.thesis}`,
    ...(position
      ? [`What you hold to be true, and write this chapter from, without stating it as a sentence of its own: ${position}`]
      : stance.positions.length > 0
        ? [`What you hold to be true, and write from: ${stance.positions.join(" | ")}`]
        : []),'''),
])

# 2. composedChapter: rotation at both call sites; content-only editor; budget; cut pass; read prompt for cuts
patch('packages/core/src/generation/composedChapter.ts', [
('''      : { min: 400, target: 480, max: 600 };''',
 '''      : // composed-7 printed 107 PDF pages for 120 paid at 480 a page, before any cut.
        { min: 440, target: 540, max: 660 };'''),
('''    ...authorStancePromptLines(options.stance, mode),
    ...compositionWriterLines(options.composition, palette),
    "Keep every fact, name, date, number, place and quotation''',
 '''    ...authorStancePromptLines(options.stance, mode, { chapterIndex: options.chapter.index }),
    ...compositionWriterLines(options.composition, palette),
    "Keep every fact, name, date, number, place and quotation'''),
('''    "Reshape paragraphs wherever the draft is uniform: merge paragraphs that continue one movement into long ones of two hundred words or more, let a turn or a landing stand alone as a one- or two-sentence paragraph, and leave no run of paragraphs of the same length. Vary sentence length and openings the same way; no two consecutive paragraphs open on the same construction.",
    "Where the author holds a position, let the prose commit: delete the counterweight that hedges a stated position. Add no new claim, example, or source. Use one spelling convention throughout, the one the book's title and premise use.",
    narrative
      ? "Only the chapter's final paragraph may reflect; every other paragraph ends on action, speech, or an image."
      : "Only the chapter's final paragraph lands an idea; every other paragraph ends where its matter ends, and not on a placed object for effect.",
    "Cut the \\"It can show X. It cannot show Y.\\" pair wherever it appears more than three times in the chapter, cut runs of rhetorical questions to one, and cut any list of four or more items to the one detail that matters unless the section is a catalogue or a procedure.",''',
 '''    // No rule about paragraph shape or endings: every one that stood here was
    // performed on schedule ("let a landing stand alone as a one-sentence
    // paragraph" became the planted aphorism three blind readers named).
    "Where the author holds a position, let the prose commit: delete the counterweight that hedges a stated position. Add no new claim, example, or source. Use one spelling convention throughout, the one the book's title and premise use.",
    "Cut runs of rhetorical questions to one, and cut any list of four or more items to the one detail that matters unless the section is a catalogue or a procedure.",'''),
('''          `Set edit to true for at most ${cap} chapters, the ones a reader would notice most, and only for: repeating a case, scene, or conclusion another chapter already delivered (name both chapters); opening on the same move as another chapter or ending on the same shape as another chapter (quote both); restating the opening chapter's definitions or distinctions; a visibly uniform paragraph shape (every paragraph the same length, the same closing move, or the same opening construction); an ending that recaps; lists and abstract nouns standing where a developed example should be.`,
          "Each chapter carries measurements: deterministic counts with the sentences behind them. A chapter whose measurements are over their ceilings is a candidate, and your notes quote the sentences to change. Where a chapter carries expectedClaim, the plan's own statement of what it should establish, say in a note if the chapter does not establish it.",
          "notes are plain strings, one change each, never objects.",
          "notes name the paragraph by its opening words and say what to cut or change. Prefer cuts to additions. A chapter with edit false still gets an empty notes array.",
          "bookNotes: up to five observations about the book as a whole that no single chapter edit would fix.",''',
 '''          `Set edit to true for at most ${cap} chapters, the ones a reader would notice most, and only where deleting sentences or whole paragraphs would help: a case, scene, or conclusion another chapter already delivered (name both chapters); a claim of the book's restated in this chapter after an earlier chapter made it; a caveat about what the evidence cannot show, repeated after the chapter already made it; a closing paragraph that re-lists the chapter's cases or restates what the chapter showed; a one-sentence paragraph placed for effect. What follows the edit is deletion only, so do not flag what needs rewriting.`,
          "Each chapter carries measurements: deterministic counts with the sentences behind them, for orientation. Where a chapter carries expectedClaim, the plan's own statement of what it should establish, say in a note if the chapter does not establish it.",
          "notes are plain strings, one cut each, never objects.",
          "Each note quotes the first six to ten words of the sentence or paragraph to delete and says why in a few words. A chapter with edit false still gets an empty notes array.",
          "bookNotes: up to five sentences of the book's that recur across chapters in different words, each quoted once with the chapters that repeat it, for the cuts to act on.",'''),
('''export type EditedChapterText = ComposedChapterText & { changed: boolean };
''',
 '''export type EditedChapterText = ComposedChapterText & { changed: boolean };

export const CUT_CHAPTER_PURPOSE = "cut-chapter";

/** The cut may remove between half a percent and a quarter of the chapter. */
const CUT_MIN_KEPT_SHARE = 0.75;
const CUT_MAX_KEPT_SHARE = 0.995;

function cutParagraphs(markdown: string): string[] {
  return markdown
    .split(/\\n\\s*\\n/)
    .map((paragraph) => paragraph.replace(/\\s+/g, " ").trim())
    .filter(Boolean);
}

function cutSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?؟。][”"’')\\]]?)\\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Accepts a cut only if it is one: every kept paragraph is one of the draft's
 * paragraphs with zero or more whole sentences removed, in order, and the
 * chapter kept between 75% and 99.5% of its words. Anything else — a rewrite,
 * a merge, a fragment, a refusal, an over-cut — returns undefined and the draft
 * stands. Nothing the model writes can enter the book through this pass.
 */
export function deletionOnlyResult(draft: string, candidate: string): string | undefined {
  const draftParagraphs = cutParagraphs(draft);
  const keptParagraphs = cutParagraphs(candidate);
  if (keptParagraphs.length === 0 || keptParagraphs.length > draftParagraphs.length) {
    return undefined;
  }
  let cursor = 0;
  for (const kept of keptParagraphs) {
    const keptSentences = cutSentences(kept);
    let found = -1;
    for (let index = cursor; index < draftParagraphs.length; index += 1) {
      const source = cutSentences(draftParagraphs[index]!);
      let at = 0;
      for (const sentence of source) {
        if (at < keptSentences.length && sentence === keptSentences[at]) {
          at += 1;
        }
      }
      if (at === keptSentences.length) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      return undefined;
    }
    cursor = found + 1;
  }
  const draftWords = countReadableWords(draft);
  const keptWords = countReadableWords(candidate);
  const share = draftWords > 0 ? keptWords / draftWords : 0;
  if (share < CUT_MIN_KEPT_SHARE || share > CUT_MAX_KEPT_SHARE) {
    return undefined;
  }
  return keptParagraphs.join("\\n\\n");
}

/**
 * The manuscript read's second pass, as deletion. The line edit is a
 * paraphrase — it changed the negation rate of composed-7's drafts from 45 to
 * 43 per thousand sentences — and every reader's remedy was a cut: the recap
 * tails, the repeated caveats, the thesis restated in eight chapters. A pass
 * that can only delete cannot add a tic, and `deletionOnlyResult` is what
 * makes "can only delete" a property of the code rather than of the prompt.
 */
export async function cutChapter(
  options: EditChapterOptions & { notes: string[]; bookNotes?: string[] | undefined }
): Promise<EditedChapterText> {
  const draftWords = countReadableWords(options.markdown);
  const pages = options.chapterPageEnd - options.chapterPageStart + 1;
  const budget = chapterWordBudget(options.input, pages);
  const result = await options.textModel.generateText({
    purpose: CUT_CHAPTER_PURPOSE,
    temperature: Math.min(0.3, options.input.temperature),
    maxTokens: composeMaxTokens(budget),
    messages: [
      {
        role: "system",
        content: [
          `You are cutting chapter ${options.chapter.index}, "${options.chapter.title}", of "${options.plan.title}" after a reader's notes on the whole manuscript.`,
          "The only operation is deletion of whole sentences or whole paragraphs. Do not rewrite, reorder, merge or add a word; every sentence you keep stays exactly as written, in its paragraph. Delete what the notes name, and anything else that restates what this chapter or an earlier chapter already established, repeats a caveat the chapter already made, re-lists the chapter's cases at its end, or restates the book's argument in a sentence of its own.",
          "Never delete a sentence carrying a fact, name, date, number, place or quotation that appears nowhere else in the chapter, and never delete the chapter's first paragraph.",
          "Remove at least a few sentences and at most a quarter of the chapter.",
          "Return only the cut chapter as Markdown paragraphs, nothing else."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            draft: options.markdown,
            notes: options.notes,
            ...(options.bookNotes && options.bookNotes.length > 0 ? { bookNotes: options.bookNotes } : {})
          },
          null,
          2
        )
      }
    ]
  });
  const cut = deletionOnlyResult(options.markdown, normalizeChapterMarkdown(unfence(result.text), { chapterTitle: options.chapter.title }));
  if (!cut) {
    return { markdown: options.markdown, words: draftWords, attempts: 1, changed: false };
  }
  return { markdown: cut, words: countReadableWords(cut), attempts: 1, changed: true };
}
'''),
])
# compose call site (first occurrence, line ~231) — patch after the edit one so the unique edit anchor above was used first
s=open(root+'packages/core/src/generation/composedChapter.ts').read()
first=s.index('    ...authorStancePromptLines(options.stance, mode),\n')
s=s[:first]+'    ...authorStancePromptLines(options.stance, mode, { chapterIndex: options.chapter.index }),\n'+s[first+len('    ...authorStancePromptLines(options.stance, mode),\n'):]
open(root+'packages/core/src/generation/composedChapter.ts','w').write(s)

# 3. pass: shape notes off, one draft, read-driven cut
patch('apps/worker/src/generation/composedChaptersPass.ts', [
('''const READ_SECOND_EDITS = false;''',
 '''const READ_SECOND_EDITS = true;
/** Two drafts and a judge settled 2 of composed-7's 15 chapters at double the compose spend; the code path stays for a tier that earns it. */
const COMPOSE_CANDIDATES = 1;
/** Paragraph-shape numbers quoted to the editor produced one planted one-sentence paragraph per chapter; diagnostics only. */
const SHAPE_NOTES_TO_EDITOR = false;'''),
('''      const shapeNotes = paragraphShapeNotes(draftMarkdown);''',
 '''      const shapeNotes = SHAPE_NOTES_TO_EDITOR ? paragraphShapeNotes(draftMarkdown) : [];'''),
('''    const candidates = judgeTextModel
      ? await Promise.all([''',
 '''    const candidates = judgeTextModel && COMPOSE_CANDIDATES > 1
      ? await Promise.all(['''),
('''        message: READ_SECOND_EDITS
          ? `Second edit of chapter ${setup.chapter.index}/${setups.length} from the manuscript read`
          : `Recording the manuscript read's notes on chapter ${setup.chapter.index}/${setups.length}`
      });
      const edited: EditedChapterText = READ_SECOND_EDITS
        ? await editChapter({
            ...(await composeOptionsFor(setup, new Map())),
            markdown: current,
            readerNotes: entry.notes,
            measurementNotes: notesForDraft(current)
          })
        : { markdown: current, words: countReadableWords(current), attempts: 0, changed: false };''',
 '''        message: READ_SECOND_EDITS
          ? `Cutting chapter ${setup.chapter.index}/${setups.length} from the manuscript read`
          : `Recording the manuscript read's notes on chapter ${setup.chapter.index}/${setups.length}`
      });
      // Deletion only: the read names the sentences, the cut removes them, and
      // `deletionOnlyResult` refuses anything the model wrote.
      const edited: EditedChapterText = READ_SECOND_EDITS
        ? await cutChapter({
            ...(await composeOptionsFor(setup, new Map())),
            markdown: current,
            notes: entry.notes,
            bookNotes: read.bookNotes
          })
        : { markdown: current, words: countReadableWords(current), attempts: 0, changed: false };'''),
])
s=open(root+'apps/worker/src/generation/composedChaptersPass.ts').read()
assert 'cutChapter,' not in s
s=s.replace('  type EditedChapterText\n} from "@book-maker/core";','  type EditedChapterText,\n  cutChapter\n} from "@book-maker/core";',1)
open(root+'apps/worker/src/generation/composedChaptersPass.ts','w').write(s)

# 4. fake adapter
patch('packages/core/src/adapters/fake.ts', [
('''      options.purpose === "detemplate-chapter"
        ? fakeDetemplatedChapter(options)
        : options.purpose === "compose-chapter" || options.purpose === "edit-chapter"''',
 '''      options.purpose === "detemplate-chapter"
        ? fakeDetemplatedChapter(options)
        : options.purpose === "cut-chapter"
          ? fakeCutChapter(options)
          : options.purpose === "compose-chapter" || options.purpose === "edit-chapter"'''),
])
s=open(root+'packages/core/src/adapters/fake.ts').read()
import re
m=re.search(r'import \{([^}]*)\} from "\./fakeComposedChapters\.js";', s)
assert m, "fake import"
if 'fakeCutChapter' not in m.group(1):
    s=s.replace(m.group(0), m.group(0).replace('fakeDetemplatedChapter', 'fakeCutChapter, fakeDetemplatedChapter'),1)
open(root+'packages/core/src/adapters/fake.ts','w').write(s)
s=open(root+'packages/core/src/adapters/fakeComposedChapters.ts').read()
s+='''
/** The canned cut: the draft with its last paragraph removed, so the deletion check passes and the path is exercised. */
export function fakeCutChapter(options: GenerateTextOptions): string {
  const user = options.messages.find((message) => message.role === "user")?.content ?? "";
  let draft = "";
  try {
    const parsed = JSON.parse(user) as { draft?: unknown };
    draft = typeof parsed.draft === "string" ? parsed.draft : "";
  } catch {
    draft = "";
  }
  const paragraphs = draft.split(/\\n\\s*\\n/).filter((paragraph) => paragraph.trim().length > 0);
  return paragraphs.length > 1 ? paragraphs.slice(0, -1).join("\\n\\n") : draft;
}
'''
open(root+'packages/core/src/adapters/fakeComposedChapters.ts','w').write(s)

# 5. registries
patch('packages/core/src/adapters/textRouting.test.ts', [
('''  "detemplate-chapter",
  "read-manuscript"''', '''  "detemplate-chapter",
  "read-manuscript",
  "cut-chapter"'''),
])
patch('packages/core/src/generation/pipelineStages.ts', [
('''    purposes: ["read-manuscript"],''', '''    purposes: ["read-manuscript", "cut-chapter"],'''),
])
patch('apps/api/src/admin/qualityGateCosts.ts', [
('''  manuscriptReadPass: new Set(["read-manuscript"])''', '''  manuscriptReadPass: new Set(["read-manuscript", "cut-chapter"])'''),
])

# 6. tests
patch('packages/core/src/generation/composedChapter.test.ts', [
('''    expect(chapterWordBudget(input, 8)).toEqual({ perPage: 480, min: 3200, target: 3840, max: 4800 });''',
 '''    expect(chapterWordBudget(input, 8)).toEqual({ perPage: 540, min: 3520, target: 4320, max: 5280 });'''),
])
print("iteration 8 applied")
