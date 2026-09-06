root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
def patch(path, pairs):
    s=open(root+path).read()
    for old,new in pairs:
        assert old in s, (path, old[:70]); s=s.replace(old,new,1)
    open(root+path,'w').write(s)
patch('packages/core/src/generation/composedChapter.ts', [
('''  const systemLines = [
    `Write chapter ${options.chapter.index}, "${options.chapter.title}", of the book "${options.plan.title}" as its author, as one continuous piece of finished Markdown prose.`,
    ...stanceLinesFor(options),
    "Paragraphs only: no headings, no title line, no section labels, no page numbers or page breaks, no summary, no epigraph, no notes. Move between sections with a paragraph break and a change of register.",
    ...compositionWriterLines(options.composition, palette),
    ...shapeRules(narrative),''',
 '''  // The subtraction ablation (spec.md, "Fable opinion"): stance, forms,
  // material, budget and a handful of positive rules, none of the bans or
  // shape rules. Measured against the full prompt on one plan.
  const minimal = COMPOSE_PROMPT_MODE === "minimal";
  const systemLines = [
    `Write chapter ${options.chapter.index}, "${options.chapter.title}", of the book "${options.plan.title}" as its author, as one continuous piece of finished Markdown prose.`,
    ...stanceLinesFor(options),
    "Paragraphs only: no headings, no title line, no section labels, no page numbers or page breaks, no summary, no epigraph, no notes. Move between sections with a paragraph break and a change of register.",
    ...compositionWriterLines(options.composition, palette),
    ...(minimal ? [] : shapeRules(narrative)),'''),
('''    "Do not open the chapter with a general claim about a common noun (\\"A cannon was never only a cannon\\").",
    ...reconstructionRule(narrative),''',
 '''    ...(minimal ? [] : ["Do not open the chapter with a general claim about a common noun (\\"A cannon was never only a cannon\\")."]),
    ...(minimal ? [] : reconstructionRule(narrative)),'''),
('''export type EditedChapterText = ComposedChapterText & { changed: boolean };
''',
 '''export type EditedChapterText = ComposedChapterText & { changed: boolean };

/** "full" is the prompt every composed run to composed-18 wrote with; "minimal" is the subtraction ablation. */
export const COMPOSE_PROMPT_MODE: "full" | "minimal" = "minimal";
'''),
])
patch('apps/worker/src/generation/composedChaptersPass.ts', [
('''const SHAPE_NOTES_TO_EDITOR = true;''',
 '''const SHAPE_NOTES_TO_EDITOR = false;
/** Off for the subtraction ablation: the editor gets the draft and the content rules, no measured notes. */
const MEASUREMENT_NOTES_TO_EDITOR = false;'''),
('''        measurementNotes: [...notesForDraft(draftMarkdown), ...shapeNotes]''',
 '''        measurementNotes: MEASUREMENT_NOTES_TO_EDITOR ? [...notesForDraft(draftMarkdown), ...shapeNotes] : []'''),
])
print("prompt-subtraction ablation staged/applied")
