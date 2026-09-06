import re, sys
root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'

# ---- authorStance.ts: positions as assertions, exemplar instead of sample, refusals off the writer
p=root+'packages/core/src/generation/authorStance.ts'
s=open(p).read()
old='''export function authorStancePromptLines(stance: AuthorStance, mode: WritingMode): string[] {
  const kind = isNarrativeWritingMode(mode) ? "story" : "book";
  return [
    `You are this ${kind}'s author. What it argues underneath everything, which the prose never states outright: ${stance.thesis}`,
    ...(stance.positions.length > 0 ? [`Positions you hold and write from: ${stance.positions.join(" | ")}`] : []),
    ...(stance.refusals.length > 0 ? [`Habits you refuse: ${stance.refusals.join(" | ")}`] : []),
    `Voice sample, a reference for diction and stance only. Never reuse any of its sentences, its opening move, or its closing move; its subject is not the book's: "${stance.voiceSample}"`
  ];
}'''
new='''/**
 * A fixed passage, on nothing the book is about, showing how paragraphs and
 * sentences can move: a long narrated stretch, a two-sentence paragraph, a
 * plain assertion, particulars throughout, no sentence that balances two
 * sides. The generated voice sample was a third to a half contrastive
 * antitheses, and the writer imitated the sample's move rather than its
 * diction (composed-1's aphorisms, composed-3's antitheses). Written for this
 * purpose; not a quotation.
 */
export const RHYTHM_EXEMPLAR = [
  "The pump on the green at Little Wenlock was cast in 1836 by a foundry in Coalbrookdale, and for sixty years it was the only water most of the village drank. Women came to it at first light with two pails on a yoke, the older ones in clogs, and waited their turn along the wall of the smithy while the handle rose and fell. The iron was cold enough in January to take the skin off a wet palm. Children were sent for the second pail after school and stopped at the churchyard gate on the way back to look at the sexton's cart, which was always there, because the sexton was also the carrier and kept his horse in the churchyard for want of anywhere else. In summer the flow slowed to a thread by the end of August, and the waiting line grew quiet, and the vicar's wife, who kept a diary, wrote down each year the day the pump first ran dry.",
  "It ran dry on the ninth of September in 1868. The diary says nothing else about that week.",
  "The village had a piped supply by 1897, paid for by a subscription the squire started and the chapel finished, and the pump stayed where it was because nobody would pay to take it away. Its handle is chained now. The chain was put on in 1911 after a boy called Thomas Pryce broke his wrist on it, and the parish minutes record the cost of the chain, one shilling and fourpence, and the name of the man who fitted it.",
  "Nobody recorded the boy's side of it."
].join("\\n\\n");

export function authorStancePromptLines(stance: AuthorStance, mode: WritingMode): string[] {
  const kind = isNarrativeWritingMode(mode) ? "story" : "book";
  return [
    `You are this ${kind}'s author. What it argues underneath everything, which the prose never states outright: ${stance.thesis}`,
    ...(stance.positions.length > 0 ? [`What you hold to be true, and write from: ${stance.positions.join(" | ")}`] : []),
    `A passage unrelated to this book, showing how paragraphs and sentences can move — a long narrated stretch, a two-sentence paragraph, a plain assertion, particulars throughout. Take its movement, never its subject or its sentences: "${RHYTHM_EXEMPLAR}"`
  ];
}'''
assert old in s, "stance lines"; s=s.replace(old,new,1)
old='''    "positions: three to five specific stands, each naming what the author believes on a question the book raises and the strongest rival explanation they reject, with the reason in a clause."'''
new='''    "positions: three to five plain assertions the author holds on questions the book raises, each stated as a fact the author is prepared to defend, without naming a rejected alternative."'''
assert old in s, "positions rule"; s=s.replace(old,new,1)
open(p,'w').write(s)

# ---- chapterForms.ts: a writer's view of the composition without landing, handoff, through-line, avoid
p=root+'packages/core/src/generation/chapterForms.ts'
s=open(p).read()
old='''/** The composition as prompt lines for the writer and the editor. */
export function compositionPromptLines(composition: ChapterComposition, palette: readonly SectionForm[]): string[] {'''
new='''/**
 * The composition as the writer sees it: forms, subjects and owned cases
 * only. The through-line, the landing and the handoffs stayed in the plan and
 * reached the read; shown to the writer they were pasted into the prose at
 * 76–100% and became the chapter endings and the seam questions the blind
 * panel quoted. `compositionPromptLines` keeps the full view for the read.
 */
export function compositionWriterLines(composition: ChapterComposition, palette: readonly SectionForm[]): string[] {
  const rules = new Map(palette.map((form) => [form.id, form.rule]));
  return composition.sections.map((section, index) => {
    const owns = section.owns.length > 0 ? ` Its material: ${section.owns.join("; ")}.` : "";
    const note = section.note ? ` Note: ${section.note}` : "";
    return `Section ${index + 1}, form "${section.form}" (${rules.get(section.form) ?? "as its name says"}): ${section.subject}.${owns}${note}`;
  });
}

/** The composition as prompt lines for the read and the plan's own consumers. */
export function compositionPromptLines(composition: ChapterComposition, palette: readonly SectionForm[]): string[] {'''
assert old in s, "composition lines"; s=s.replace(old,new,1)
open(p,'w').write(s)

# ---- composedChapter.ts: writer view, no closings, no conclusion rule, no handoff rule
p=root+'packages/core/src/generation/composedChapter.ts'
s=open(p).read()
s=s.replace('import { compositionPromptLines, formPaletteFor, type ChapterComposition } from "./chapterForms.js";',
            'import { compositionPromptLines, compositionWriterLines, formPaletteFor, type ChapterComposition } from "./chapterForms.js";',1)
assert 'compositionWriterLines' in s
# compose system lines
old='''    ...compositionPromptLines(options.composition, palette),
    ...shapeRules(narrative),
    "Do not open the chapter with a general claim about a common noun (\\"A cannon was never only a cannon\\") or with a sentence from the voice sample.",
    ...reconstructionRule(narrative),
    ...edgesLines(options),'''
new='''    ...compositionWriterLines(options.composition, palette),
    ...shapeRules(narrative),
    "Do not open the chapter with a general claim about a common noun (\\"A cannon was never only a cannon\\").",
    ...reconstructionRule(narrative),'''
assert old in s, "compose lines"; s=s.replace(old,new,1)
# shape rules: drop conclusion + handoff-as-question lines, replace with 'ends where its last section ends'
old='''    narrative
      ? "The chapter's last paragraph is the last thing that happens, not a reflection on it."
      : "The chapter's final paragraph is the author's conclusion, argued from the chapter as a whole in the author's voice. It does not name the chapter's cases again in sequence, does not restate the book's thesis, and does not end on a balanced two-clause sentence, a one-line verdict, an object placed for effect, or a question.",
    "A section's handoff is carried as a fact or a tension the next section takes up, never written into the text as a question. A catalogue is written in sentences, never as labelled entries.",'''
new='''    "The chapter ends where its last section ends. A catalogue is written in sentences, never as labelled entries.",'''
assert old in s, "conclusion rule"; s=s.replace(old,new,1)
old='''      : "The sections are movements of one argument, not separate essays: carry each section's handoff into the next, point back to an earlier case in a clause when it bears on the current one, and let the chapter's claim accumulate. Do not open every section on a place-and-date stamp, and do not close sections on a placed object for effect: a reed marker, a file on a table, dust on a path. Once a chapter is a texture; every section is a tic.",'''
new='''      : "The sections are movements of one argument, not separate essays: let each grow out of the one before, point back to an earlier case in a clause when it bears on the current one, and let the chapter's claim accumulate. Do not open every section on a place-and-date stamp, and do not close sections on a placed object for effect: a reed marker, a file on a table, dust on a path. Once a chapter is a texture; every section is a tic.",'''
assert old in s, "movements rule"; s=s.replace(old,new,1)
# compose user payload: composition → writer view object
old='''    composition: options.composition,
    ...(options.previousChapterTail ? { previousChapterTail } : {}),'''
new='''    composition: {
      sections: options.composition.sections.map((section) => ({ form: section.form, subject: section.subject, owns: section.owns, ...(section.note ? { note: section.note } : {}) }))
    },
    ...(options.previousChapterTail ? { previousChapterTail } : {}),'''
assert old in s, "compose payload"; s=s.replace(old,new,1)
# editor: writer view + no keep-conclusion rule + no edges
old='''    ...authorStancePromptLines(options.stance, mode),
    ...compositionPromptLines(options.composition, palette),
    "Keep every fact, name, date, number, place and quotation, and the order of sections. Keep the opening section's material, though you may and should rewrite an opening sentence that makes a general claim about a common noun. Keep the chapter's conclusion; if the draft ends on a one-sentence verdict, an object placed for effect, a question, or the book's thesis restated, write the conclusion as a reasoned paragraph in the author's voice instead.",'''
new='''    ...authorStancePromptLines(options.stance, mode),
    ...compositionWriterLines(options.composition, palette),
    "Keep every fact, name, date, number, place and quotation, and the order of sections. Keep the opening section's material, though you may and should rewrite an opening sentence that makes a general claim about a common noun. The chapter ends where its last section ends.",'''
assert old in s, "editor keep rule"; s=s.replace(old,new,1)
old='''    ...(options.readerNotes && options.readerNotes.length > 0
      ? [`A reader of the whole manuscript left these notes on this chapter; they outrank every keep-rule above, so act on each one: ${options.readerNotes.join(" | ")}`]
      : []),
    ...edgesLines(options),'''
new='''    ...(options.readerNotes && options.readerNotes.length > 0
      ? [`A reader of the whole manuscript left these notes on this chapter; they outrank every keep-rule above, so act on each one: ${options.readerNotes.join(" | ")}`]
      : []),'''
assert old in s, "editor edges"; s=s.replace(old,new,1)
# read: give it the plan's landing per chapter as a check
old='''export type ManuscriptChapterForRead = {
  index: number;
  title: string;
  markdown: string;'''
new='''export type ManuscriptChapterForRead = {
  index: number;
  title: string;
  markdown: string;
  /** What the plan said this chapter establishes; the read checks the chapter against it, the writer never sees it. */
  expectedClaim?: string | undefined;'''
assert old in s, "read type"; s=s.replace(old,new,1)
old='''            chapters: options.chapters.map((chapter) => ({
              chapterIndex: chapter.index,
              title: chapter.title,
              ...(chapter.measurements && chapter.measurements.length > 0 ? { measurements: chapter.measurements } : {}),
              text: chapter.markdown
            })),'''
new='''            chapters: options.chapters.map((chapter) => ({
              chapterIndex: chapter.index,
              title: chapter.title,
              ...(chapter.expectedClaim ? { expectedClaim: chapter.expectedClaim } : {}),
              ...(chapter.measurements && chapter.measurements.length > 0 ? { measurements: chapter.measurements } : {}),
              text: chapter.markdown
            })),'''
assert old in s, "read payload"; s=s.replace(old,new,1)
old='''          "Each chapter carries measurements: deterministic counts with the sentences behind them. A chapter whose measurements are over their ceilings is a candidate, and your notes quote the sentences to change.",'''
new='''          "Each chapter carries measurements: deterministic counts with the sentences behind them. A chapter whose measurements are over their ceilings is a candidate, and your notes quote the sentences to change. Where a chapter carries expectedClaim, the plan's own statement of what it should establish, say in a note if the chapter does not establish it.",'''
assert old in s, "read rule"; s=s.replace(old,new,1)
# drop now-unused edgesLines function if unreferenced
if s.count('edgesLines(')==1:
    i=s.index('function edgesLines('); j=s.index('\n}\n', i)+3
    s=s[:i]+s[j:]
open(p,'w').write(s)

# ---- worker pass: expectedClaim into the read; earlierClosings no longer needed (harmless)
p=root+'apps/worker/src/generation/composedChaptersPass.ts'
s=open(p).read()
old='''      return { index: setup.chapter.index, title: setup.chapter.title, markdown, measurements: notesForDraft(markdown) };'''
new='''      return {
        index: setup.chapter.index,
        title: setup.chapter.title,
        markdown,
        expectedClaim: compositionFor(setup).landing,
        measurements: notesForDraft(markdown)
      };'''
assert old in s, "pass read"; s=s.replace(old,new,1)
open(p,'w').write(s)
print("run A patch applied")
