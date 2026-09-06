import re
root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'

# 1. stanceLine: belief alias, never the rejected view
p=root+'packages/core/src/schemas/plan.ts'
s=open(p).read()
old='''  const believes = stringField(value, ["believes", "position", "claim", "stand", "text", "statement", "habit", "refusal"])?.trim();
  const rejects = stringField(value, ["rejects", "against", "rival", "rejectedView", "rejected_view", "alternative"])?.trim();
  if (believes && rejects) {
    return `${believes} Rejects: ${rejects}`;
  }
  if (believes || rejects) {
    return believes ?? rejects;
  }
  const strings = Object.values(value).filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return strings.length > 0 ? strings.map((entry) => entry.trim()).join(" ") : undefined;'''
new='''  // The view the author holds, and only that. A planner that answered
  // `{belief, rejects}` objects had `belief` missing from this list, so the
  // fallback handed the writer the *rejected* views as its positions and one
  // whole book was written rebutting them (composed-6).
  const believes = stringField(value, [
    "belief",
    "believes",
    "holds",
    "assertion",
    "position",
    "claim",
    "stand",
    "text",
    "statement",
    "habit",
    "refusal"
  ])?.trim();
  if (believes) {
    return believes;
  }
  const rejectedKeys = new Set(["rejects", "against", "rival", "rejectedview", "rejected_view", "alternative", "reason", "why"]);
  const strings = Object.entries(value)
    .filter(([key, entry]) => !rejectedKeys.has(key.toLowerCase()) && typeof entry === "string" && entry.trim().length > 0)
    .map(([, entry]) => (entry as string).trim());
  return strings.length > 0 ? strings.join(" ") : undefined;'''
assert old in s, "stanceLine"; s=s.replace(old,new,1)
open(p,'w').write(s)

# 2. planner guidance + fallback contract: plain assertions
p=root+'packages/core/src/generation/authorStance.ts'
s=open(p).read()
old='''  "Also return authorStance, the author this book is written by: thesis (one sentence the whole book argues, or for fiction what the story is about underneath its events), positions (three to five specific stands, required, each naming what the author believes on a question the book raises and the rival view they reject), refusals (two to four habits the author refuses, such as ending a section by balancing both sides, listing more than three examples in one sentence, or restating a point already made), and voiceSample (180 to 260 words written as this author on a subject adjacent to the book but not in it).",'''
new='''  "Also return authorStance, the author this book is written by: thesis (one sentence the whole book argues, or for fiction what the story is about underneath its events), positions (three to five plain assertions the author holds on questions the book raises, each a string stating a fact the author is prepared to defend, with no rejected alternative named), refusals (two to four habits the author refuses, such as ending a section by balancing both sides, listing more than three examples in one sentence, or restating a point already made), and voiceSample (180 to 260 words written as this author on a subject adjacent to the book but not in it).",'''
assert old in s, "planner guidance"; s=s.replace(old,new,1)
old='''              positions: ["Three to five stands, each with the rival view rejected."],'''
new='''              positions: ["Three to five plain assertions the author holds, each one string, no rejected alternative."],'''
assert old in s, "contract"; s=s.replace(old,new,1)
open(p,'w').write(s)

# 3. research query: the book, not the planning instruction
p=root+'packages/core/src/generation/planner.ts'
s=open(p).read()
old='''      [options.input.prompt, chapter.title, chapter.summary, ...chapter.keyBeats].filter(Boolean).join(" ")'''
new='''      // The plan's title, never `input.prompt`: for a chat-created book the
      // prompt is the app's planning instruction ("Create the best-fitting book
      // from the user's creation chat… Book type choice: Auto…"), and every
      // chapter's research came back about lead magnets.
      [options.plan.title, chapter.title, chapter.summary, ...chapter.keyBeats.slice(0, 2)].filter(Boolean).join(" ")'''
assert old in s, "research query"; s=s.replace(old,new,1)
open(p,'w').write(s)

# 4. composedChapter: key beats out of the payload; opening hook and last-chapter lines softened; second-draft variant; excerpted judge lives in chapterJudge
p=root+'packages/core/src/generation/composedChapter.ts'
s=open(p).read()
old='''    chapter: {
      index: options.chapter.index,
      title: options.chapter.title,
      summary: options.chapter.summary,
      keyBeats: options.chapter.keyBeats
    },'''
assert s.count(old)>=1, "chapter payload"
s=s.replace(old,'''    chapter: {
      index: options.chapter.index,
      title: options.chapter.title,
      summary: options.chapter.summary
    },''')
old='''        ? `This is the book's opening chapter. Its first lines open exactly as the plan committed: ${options.plan.openingHook}`'''
new='''        ? `This is the book's opening chapter. The plan suggested an opening; take it or find a better one: ${options.plan.openingHook}`'''
assert old in s, "opening hook"; s=s.replace(old,new,1)
old='''      `This is the final chapter. Through one new case carried at length, draw the book's argument to its conclusion and state the author's own answer plainly, as a reasoned paragraph; do not re-list the earlier chapters and do not end on a question.${'''
new='''      `This is the final chapter. Its last section carries the book's resolution through one new case, and the chapter ends where that section ends; do not re-list the earlier chapters.${'''
assert old in s, "last chapter"; s=s.replace(old,new,1)
old='''  /** A second candidate samples hotter than the book's own temperature; the judge decides. */
  temperature?: number | undefined;
};'''
new='''  /** A second candidate samples hotter than the book's own temperature; the judge decides. */
  temperature?: number | undefined;
  /** The second of two drafts takes a different way in; the OpenAI adapter drops temperature under any reasoning effort, so the variation has to be in the prompt. */
  variant?: "second" | undefined;
};'''
assert old in s, "variant option"; s=s.replace(old,new,1)
old='''    ...reconstructionRule(narrative),
    ...positionLines({ plan: options.plan, chapter: options.chapter, input: options.input, narrative }),'''
new='''    ...reconstructionRule(narrative),
    ...(options.variant === "second"
      ? [
          "This is the second of two drafts of this chapter, to be judged against the first. Enter the first section by a different door than the obvious one, put the chapter's one sustained stretch in a different section than a first draft would, and let a different section carry the short paragraphs."
        ]
      : []),
    ...positionLines({ plan: options.plan, chapter: options.chapter, input: options.input, narrative }),'''
assert old in s, "variant line"; s=s.replace(old,new,1)
old='''          `Set edit to true for at most ${cap} chapters, the ones a reader would notice most, and only for: repeating a case, scene, or conclusion another chapter already delivered (name both chapters); opening on the same move as another chapter or ending on the same shape as another chapter (quote both); restating the opening chapter's definitions or distinctions; a visibly uniform paragraph shape (every paragraph the same length, the same closing move, or the same opening construction); an ending that recaps or generalises instead of ending on a particular; lists and abstract nouns standing where a developed example should be.`,'''
new='''          `Set edit to true for at most ${cap} chapters, the ones a reader would notice most, and only for: repeating a case, scene, or conclusion another chapter already delivered (name both chapters); opening on the same move as another chapter or ending on the same shape as another chapter (quote both); restating the opening chapter's definitions or distinctions; a visibly uniform paragraph shape (every paragraph the same length, the same closing move, or the same opening construction); an ending that recaps; lists and abstract nouns standing where a developed example should be.`,'''
assert old in s, "read criterion"; s=s.replace(old,new,1)
open(p,'w').write(s)

# 5. measurement notes: shape diagnostics only; no negation or closing-verdict notes to the editor
p=root+'packages/core/src/generation/proseMeasurements.ts'
s=open(p).read()
old='''  if (measurements.negationContrast.per1000Sentences > ceilings.negationContrastPer1000Sentences) {'''
new='''  // Negation and closing-verdict notes are diagnostics only: quoted into the
  // editor's prompt they were obeyed lexically, the two-sentence hedge fused
  // into the one-sentence antithesis, and "while" rose 20% across the edit.
  if (options.includeNegationNotes && measurements.negationContrast.per1000Sentences > ceilings.negationContrastPer1000Sentences) {'''
assert old in s, "neg note"; s=s.replace(old,new,1)
old='''  if (measurements.negationThenShort.per1000Sentences > ceilings.negationThenShortPer1000Sentences) {'''
new='''  if (options.includeNegationNotes && measurements.negationThenShort.per1000Sentences > ceilings.negationThenShortPer1000Sentences) {'''
assert old in s, "neg2 note"; s=s.replace(old,new,1)
old='''  if (measurements.closingGeneralises && countReadableWords(measurements.closingSentence) <= 16) {'''
new='''  if (options.includeNegationNotes && measurements.closingGeneralises && countReadableWords(measurements.closingSentence) <= 16) {'''
assert old in s, "closing note"; s=s.replace(old,new,1)
old='''export function measurementNotes(
  measurements: ProseMeasurements,
  ceilings: MeasurementCeilings = CHAPTER_MEASUREMENT_CEILINGS
): string[] {
  const notes: string[] = [];'''
new='''export function measurementNotes(
  measurements: ProseMeasurements,
  ceilings: MeasurementCeilings = CHAPTER_MEASUREMENT_CEILINGS,
  options: { includeNegationNotes?: boolean } = {}
): string[] {
  const notes: string[] = [];'''
assert old in s, "notes sig"; s=s.replace(old,new,1)
open(p,'w').write(s)

# 6. pass: provisional digest without the through-line
p=root+'apps/worker/src/generation/composedChaptersPass.ts'
s=open(p).read()
old='''    provisionalDigests.set(
      setup.chapter.index,
      chapterDigest([composition.throughLine, ...composition.sections.map((section) => section.subject)])
    );'''
new='''    // Subjects only: the through-line reached the next chapter's writer through
    // this digest and was quoted there.
    provisionalDigests.set(setup.chapter.index, chapterDigest(composition.sections.map((section) => section.subject)));'''
assert old in s, "digest"; s=s.replace(old,new,1)
open(p,'w').write(s)
print("fixes applied")
