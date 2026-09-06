root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
def patch(path, pairs):
    s=open(root+path).read()
    for old,new in pairs:
        assert old in s, (path, old[:80]); s=s.replace(old,new,1)
    open(root+path,'w').write(s)

# editor: restore composed-7's shape lines; the stripped editor measured worse on the same plan
patch('packages/core/src/generation/composedChapter.ts', [
('''    // No rule about paragraph shape or endings: every one that stood here was
    // performed on schedule ("let a landing stand alone as a one-sentence
    // paragraph" became the planted aphorism three blind readers named).
    "Where the author holds a position, let the prose commit: delete the counterweight that hedges a stated position. Add no new claim, example, or source. Use one spelling convention throughout, the one the book's title and premise use.",
    "Cut runs of rhetorical questions to one, and cut any list of four or more items to the one detail that matters unless the section is a catalogue or a procedure.",''',
 '''    // These three shape rules were removed for composed-8/9 on the theory that
    // every rule about shape becomes a shape; on the same plan the book scored
    // 6.73 against 7.73 with them, so they stand (spec.md, iterations 8-10).
    "Reshape paragraphs wherever the draft is uniform: merge paragraphs that continue one movement into long ones of two hundred words or more, let a turn or a landing stand alone as a one- or two-sentence paragraph, and leave no run of paragraphs of the same length. Vary sentence length and openings the same way; no two consecutive paragraphs open on the same construction.",
    "Where the author holds a position, let the prose commit: delete the counterweight that hedges a stated position. Add no new claim, example, or source. Use one spelling convention throughout, the one the book's title and premise use.",
    narrative
      ? "Only the chapter's final paragraph may reflect; every other paragraph ends on action, speech, or an image."
      : "Only the chapter's final paragraph lands an idea; every other paragraph ends where its matter ends, and not on a placed object for effect.",
    "Cut the \\"It can show X. It cannot show Y.\\" pair wherever it appears more than three times in the chapter, cut runs of rhetorical questions to one, and cut any list of four or more items to the one detail that matters unless the section is a catalogue or a procedure.",'''),
# rotation off: one position per chapter left the book "with nothing a reader could disagree with"
('''export type EditedChapterText = ComposedChapterText & { changed: boolean };
''',
 '''export type EditedChapterText = ComposedChapterText & { changed: boolean };

/**
 * One rotated position per chapter was tried on composed-8/9: the refrains
 * the panel named in composed-7 were the five positions restated, but shown one
 * each the chapters restated the thesis instead and the book lost its argument
 * ("nothing a reader could disagree with"), 6.73 against 7.73 on the same plan.
 */
const ROTATE_STANCE_POSITIONS = false;

function stanceLinesFor(options: ComposeChapterOptions): string[] {
  const mode = inferWritingMode(options.input, options.plan);
  return authorStancePromptLines(
    options.stance,
    mode,
    ROTATE_STANCE_POSITIONS ? { chapterIndex: options.chapter.index } : {}
  );
}
'''),
])
s=open(root+'packages/core/src/generation/composedChapter.ts').read()
old='    ...authorStancePromptLines(options.stance, mode, { chapterIndex: options.chapter.index }),\n'
assert s.count(old)==2, s.count(old)
s=s.replace(old,'    ...stanceLinesFor(options),\n')
open(root+'packages/core/src/generation/composedChapter.ts','w').write(s)

# pass: shape notes back on, read-driven cut off (kept for a later test on its own)
patch('apps/worker/src/generation/composedChaptersPass.ts', [
('''const READ_SECOND_EDITS = true;''', '''/** The read-driven deletion-only cut ran on composed-8/9 (6.73 on composed-7's plan); off until it is tested on its own. */
const READ_SECOND_EDITS = false;'''),
('''/** Paragraph-shape numbers quoted to the editor produced one planted one-sentence paragraph per chapter; diagnostics only. */
const SHAPE_NOTES_TO_EDITOR = false;''', '''/** Paragraph-shape numbers to the editor: off for composed-8/9, which scored lower on the same plan; back on with composed-7's editor. */
const SHAPE_NOTES_TO_EDITOR = true;'''),
])
print("iteration 10 applied")
