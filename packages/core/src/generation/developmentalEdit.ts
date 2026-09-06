import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { chapterDegeneracy } from "./chapterIntegrity.js";
import { countReadableWords } from "./proseShape.js";
import { hasFigureFence } from "./figures/figureBlocks.js";

export type DevelopmentChapter = { index: number; title: string; markdown: string };
export type DevelopmentWordBudget = { min: number; target: number; max: number };
const changeSchema = z.object({
  id: z.string().min(1), chapterIndex: z.number().int().positive(),
  startParagraph: z.number().int().positive(), deleteCount: z.number().int().nonnegative(),
  targetWords: z.number().int().nonnegative(), instruction: z.string().min(1),
  /** Existing paragraphs to assemble verbatim, in this order, without a rewrite call. */
  sourceParagraphs: z.array(z.object({ chapterIndex: z.number().int().positive(), paragraph: z.number().int().positive() })).min(1).max(100).optional()
});
const editPlanSchema = z.object({
  groups: z.array(z.object({
    id: z.string().min(1), reason: z.string().min(1), changes: z.array(changeSchema).min(1).max(8),
    retainedCaseParagraphs: z.array(z.object({ chapterIndex: z.number().int().positive(), paragraph: z.number().int().positive() })).min(1).max(100).optional()
  })).max(6)
});
export type DevelopmentEditPlan = z.infer<typeof editPlanSchema>;
export type DevelopmentChange = z.infer<typeof changeSchema>;
export type DevelopmentEditResult = {
  chapters: DevelopmentChapter[];
  plan: DevelopmentEditPlan;
  appliedGroups: string[];
  rejectedGroups: Array<{ id: string; reason: string }>;
  beforeWords: number;
  afterWords: number;
};

export function developmentParagraphs(markdown: string): string[] {
  return markdown.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

export function developmentEditPlanIssues(chapters: readonly DevelopmentChapter[], plan: DevelopmentEditPlan): string[] {
  const issues: string[] = [];
  const byChapter = new Map(chapters.map((chapter) => [chapter.index, developmentParagraphs(chapter.markdown)]));
  const occupied = new Map<number, Array<{ start: number; end: number }>>();
  const ids = new Set<string>();
  const groups = new Set<string>();
  let touchedWords = 0;
  const totalWords = chapters.reduce((sum, chapter) => sum + countReadableWords(chapter.markdown), 0);
  for (const group of plan.groups) {
    if (groups.has(group.id)) issues.push("duplicate group ID");
    groups.add(group.id);
    let groupWords = 0;
    for (const change of group.changes) {
      if (ids.has(change.id)) issues.push("duplicate change ID");
      ids.add(change.id);
      const paragraphs = byChapter.get(change.chapterIndex);
      const start = change.startParagraph - 1;
      const end = start + change.deleteCount;
      if (!paragraphs || start > paragraphs.length || end > paragraphs.length) { issues.push(`invalid range ${change.id}`); continue; }
      if (change.deleteCount === 0 && change.targetWords === 0) issues.push(`empty operation ${change.id}`);
      const ranges = occupied.get(change.chapterIndex) ?? [];
      if (ranges.some((range) => start === range.start || (start < range.end && end > range.start))) issues.push(`overlapping range ${change.id}`);
      ranges.push({ start, end });
      occupied.set(change.chapterIndex, ranges);
      const original = paragraphs.slice(start, end).join("\n\n");
      // A figure stays anchored to its paragraph; edits around it are still allowed.
      if (/\[Figure:/i.test(original) || hasFigureFence(original)) issues.push(`range ${change.id} contains a protected figure`);
      let replacementWords = change.targetWords;
      if (change.sourceParagraphs) {
        replacementWords = 0;
        if (change.targetWords === 0) issues.push(`deletion ${change.id} also selects source paragraphs`);
        for (const source of change.sourceParagraphs) {
          const text = byChapter.get(source.chapterIndex)?.[source.paragraph - 1];
          if (text === undefined) { issues.push(`invalid source paragraph ${change.id}`); continue; }
          if (/\[Figure:/i.test(text) || hasFigureFence(text)) issues.push(`source ${change.id} contains a protected figure`);
          replacementWords += countReadableWords(text);
        }
      }
      const words = Math.max(countReadableWords(original), replacementWords);
      touchedWords += words;
      groupWords += words;
    }
    if (groupWords > 8000) issues.push(`group ${group.id} exceeds the section rewrite budget`);
  }
  if (occupied.size > Math.min(6, chapters.length)) issues.push("too many chapters selected for developmental rewriting");
  if (touchedWords > Math.max(600, totalWords * 0.3)) issues.push("developmental edits exceed thirty percent of the manuscript");
  return [...new Set(issues)];
}

export function applyDevelopmentChanges(
  chapters: readonly DevelopmentChapter[], changes: readonly DevelopmentChange[], replacements: ReadonlyMap<string, string>
): DevelopmentChapter[] {
  return chapters.map((chapter) => {
    const edits = changes.filter((change) => change.chapterIndex === chapter.index);
    if (!edits.length) return { ...chapter };
    const paragraphs = developmentParagraphs(chapter.markdown);
    for (const edit of [...edits].sort((a, b) => b.startParagraph - a.startParagraph)) {
      const text = replacements.get(edit.id);
      if (text === undefined) throw new Error(`Missing replacement ${edit.id}`);
      paragraphs.splice(edit.startParagraph - 1, edit.deleteCount, ...developmentParagraphs(text));
    }
    return { ...chapter, markdown: paragraphs.join("\n\n") };
  });
}

export async function editManuscriptDevelopment(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  chapters: DevelopmentChapter[];
  wordBudget: DevelopmentWordBudget;
  textModel: TextModelAdapter;
  /** Extractive edits copy existing paragraphs or delete; no prose-generation calls. */
  mode?: "rewrite" | "extractive";
  /** Other chapters remain context, but no group may change them. */
  editableChapterIndexes?: readonly number[];
  /** Restrict the experiment to repeated case treatments across different chapters. */
  crossChapterCasesOnly?: boolean;
}): Promise<DevelopmentEditResult> {
  const beforeWords = options.chapters.reduce((sum, chapter) => sum + countReadableWords(chapter.markdown), 0);
  const empty: DevelopmentEditResult = { chapters: options.chapters, plan: { groups: [] }, appliedGroups: [], rejectedGroups: [], beforeWords, afterWords: beforeWords };
  if (beforeWords > 110_000) return { ...empty, rejectedGroups: [{ id: "plan", reason: "manuscript exceeds the full-text review budget" }] };
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "plan-developmental-edit", temperature: 0.2, maxTokens: 10_000, schema: editPlanSchema,
    messages: [
      { role: "system", content: [
        "Read the complete nonfiction manuscript and propose a bounded developmental edit. Identify sections whose cases, explanation or inference overlap, even with different names and wording. Preserve the requested coverage and useful recurrence that changes understanding. You may delete, move, combine, or replace sections, and develop an unanswered question using the available evidence. Do not prescribe uniform openings, closings, paragraph shapes or rhetorical moves.",
        "Return JSON {groups:[{id,reason,changes:[{id,chapterIndex,startParagraph,deleteCount,targetWords,instruction,sourceParagraphs?:[{chapterIndex,paragraph}]}]}]}. Paragraph indexes are one-based against the supplied original text. deleteCount 0 inserts before startParagraph (length+1 appends); targetWords 0 deletes with no replacement. sourceParagraphs assembles those original paragraphs verbatim in order, without rewriting; use a positive targetWords estimate for that selection. A move has linked source and destination changes in ONE group: both apply or neither does. Instructions must explain the concrete contribution the replacement adds and which evidence supports it.",
        options.mode === "extractive" ? "This is an extractive edit: every non-deletion MUST specify sourceParagraphs. You cannot write or paraphrase prose. Keep an awkward paragraph when removing it would lose a distinct explanation, source attribution or necessary uncertainty." : "Prefer copying existing paragraphs when a change only needs to relocate or consolidate material.",
        options.crossChapterCasesOnly ? "Only address a repeated treatment of the same case across DIFFERENT chapters. Do not cut within-chapter summaries or syntheses: they may connect evidence into an argument. Each group MUST include retainedCaseParagraphs:[{chapterIndex,paragraph}] pointing to the existing treatment that remains in a different chapter from every deletion. Preserve all distinct details in a duplicated treatment, including dates, biographical facts, source attribution, and mechanisms. Keep the original paragraph if it combines duplication with unique material. A comparison must not precede the supporting material it assumes. Return no groups when these requirements cannot be met." : "",
        "For each cut, identify in its reason the retained paragraph locations carrying the same substantive contribution. Repeated names alone do not establish duplication: preserve distinct mechanisms, temporal distinctions, conditional examples, and limits that change the conclusion. No cuts are required.",
        "At most six groups and six affected chapters, no overlapping ranges. Sum of max(original range words,targetWords) across changes must stay within thirty percent of manuscript words (600-word minimum budget), and within 8000 per group. Never select a paragraph containing a figure stand-in. All unselected prose stays unchanged.",
        "The word budget belongs to the whole book. Stay within its min/max after each independent group; link changes that need each other to meet that budget. The target is not a refill instruction: do not pad a cut with a recap or invent details. Use empty groups when no substantive improvement is warranted.",
        "development.reviewNotes, when present, lists coverage the plan reviewer judged thinner than requested. Do not let prose claim a comparison or survey the evidence does not carry, and do not invent material to fill it; narrowing an overclaim is a valid edit."
      ].join(" ") },
      { role: "user", content: JSON.stringify({
        request: options.input.prompt, coverage: options.plan.bookDevelopment?.coverage ?? options.plan.promises,
        development: options.plan.bookDevelopment, wordBudget: options.wordBudget, currentWords: beforeWords,
        editableChapterIndexes: options.editableChapterIndexes,
        evidence: options.plan.dossier?.evidencePackets?.map(({ excerpts: _excerpts, ...packet }) => packet),
        chapters: options.chapters.map((chapter) => ({ index: chapter.index, title: chapter.title, paragraphs: developmentParagraphs(chapter.markdown).map((text, index) => ({ index: index + 1, text })) }))
      }) }
    ]
  });
  const replacements = new Map<string, string>();
  const accepted: DevelopmentChange[] = [];
  const acceptedGroups: DevelopmentEditPlan["groups"] = [];
  const appliedGroups: string[] = [];
  const rejectedGroups: DevelopmentEditResult["rejectedGroups"] = [];
  for (const group of result.data.groups) {
    const issues = developmentEditPlanIssues(options.chapters, { groups: [...acceptedGroups, group] });
    if (options.crossChapterCasesOnly) {
      const retained = group.retainedCaseParagraphs ?? [];
      for (const change of group.changes.filter((change) => change.deleteCount > 0)) {
        if (!retained.some((source) => source.chapterIndex !== change.chapterIndex)) issues.push("cross-chapter edit needs a retained case treatment in another chapter");
      }
      for (const source of retained) {
        if (!options.chapters.find((chapter) => chapter.index === source.chapterIndex) || developmentParagraphs(options.chapters.find((chapter) => chapter.index === source.chapterIndex)!.markdown)[source.paragraph - 1] === undefined) issues.push("invalid retained case paragraph");
      }
    }
    if (options.editableChapterIndexes && group.changes.some((change) => !options.editableChapterIndexes!.includes(change.chapterIndex))) issues.push("group changes a chapter outside the editable scope");
    const generatedChanges = group.changes.filter((change) => change.targetWords > 0 && !change.sourceParagraphs);
    if (options.mode === "extractive" && generatedChanges.length) issues.push("extractive mode requires source paragraphs for every non-deletion");
    if (issues.length) { rejectedGroups.push({ id: group.id, reason: issues.join("; ") }); continue; }
    const byId = new Map<string, string>();
    for (const change of group.changes) {
      if (change.sourceParagraphs) byId.set(change.id, change.sourceParagraphs.map((source) => developmentParagraphs(options.chapters.find((chapter) => chapter.index === source.chapterIndex)!.markdown)[source.paragraph - 1]!).join("\n\n"));
      else if (change.targetWords === 0) byId.set(change.id, "");
    }
    let complete = true;
    if (generatedChanges.length) {
      const response = await generateJsonWithRetry(options.textModel, {
      purpose: "rewrite-developmental-sections", temperature: Math.min(0.6, options.input.temperature),
      maxTokens: Math.min(30_000, Math.max(4000, group.changes.reduce((sum, change) => sum + change.targetWords, 0) * 3 + 2000)),
      schema: z.object({ replacements: z.array(z.object({ id: z.string(), text: z.string() })).max(8) }),
      messages: [
        { role: "system", content: "Execute the generatedChanges in this linked group of developmental section edits. Return JSON {replacements:[{id,text}]} with exactly one replacement for every generatedChanges ID. Other changes are assembled by code. Return only the replacement section in text, not a whole chapter. Preserve distinct explanations, mechanisms, useful conditional examples, attribution and uncertainty in a move or combination. Use the supplied evidence for factual additions. Do not invent scene details, quotes, sources or claims. Follow the book's language and voice. Target each requested word count within twenty percent. Do not introduce headings, commentary, figure blocks or figure stand-ins. All prose outside these ranges is preserved by code." },
        { role: "user", content: JSON.stringify({
          language: options.input.language, voiceGuide: options.plan.voiceGuide, group, generatedChanges,
          chapters: options.chapters.filter((chapter) => group.changes.some((change) => change.chapterIndex === chapter.index)),
          caseEvidence: options.plan.dossier?.evidencePackets,
          wordBudget: options.wordBudget
        }) }
      ]
      });
      const seen = new Set<string>();
      for (const entry of response.data.replacements) {
        const text = entry.text.trim();
        if (seen.has(entry.id) || !group.changes.some((change) => change.id === entry.id) || (byId.has(entry.id) && byId.get(entry.id) !== text)) complete = false;
        seen.add(entry.id);
        if (!byId.has(entry.id)) byId.set(entry.id, text);
      }
    }
    complete &&= byId.size === group.changes.length && group.changes.every((change) => byId.has(change.id));
    const valid = complete && group.changes.every((change) => {
      const text = byId.get(change.id)!;
      if (change.targetWords === 0) return text === "";
      if (change.sourceParagraphs) return true;
      const words = countReadableWords(text);
      return words >= Math.max(1, change.targetWords * 0.6) && words <= change.targetWords * 1.4 &&
        !hasFigureFence(text) && !/\[Figure:/i.test(text) && !chapterDegeneracy(text, { maxWords: Math.ceil(change.targetWords * 1.4), language: options.input.language }).degenerate;
    });
    if (!valid) { rejectedGroups.push({ id: group.id, reason: "replacement IDs, lengths or prose integrity failed; linked changes kept together" }); continue; }
    const candidateReplacements = new Map([...replacements, ...byId]);
    const candidate = applyDevelopmentChanges(options.chapters, [...accepted, ...group.changes], candidateReplacements);
    const current = applyDevelopmentChanges(options.chapters, accepted, replacements);
    if (candidate.some((chapter) => !chapter.markdown.trim()) || candidate.every((chapter, index) => chapter.markdown === current[index]!.markdown)) {
      rejectedGroups.push({ id: group.id, reason: "edit empties a chapter or makes no textual change" });
      continue;
    }
    if (options.crossChapterCasesOnly) {
      const candidateParagraphs = new Set(candidate.flatMap((chapter) => developmentParagraphs(chapter.markdown)));
      const retained = [...acceptedGroups, group].flatMap((entry) => entry.retainedCaseParagraphs ?? []);
      const lostAnchor = retained.some((source) => !candidateParagraphs.has(developmentParagraphs(options.chapters.find((chapter) => chapter.index === source.chapterIndex)!.markdown)[source.paragraph - 1]!));
      const numbers = (chapters: readonly DevelopmentChapter[]) => new Set(chapters.flatMap((chapter) => chapter.markdown.match(/\b\d[\d,.]*(?:[–-]\d[\d,.]*)?\b/g) ?? []));
      const beforeNumbers = numbers(options.chapters);
      const afterNumbers = numbers(candidate);
      if (lostAnchor || [...beforeNumbers].some((number) => !afterNumbers.has(number))) {
        rejectedGroups.push({ id: group.id, reason: lostAnchor ? "edit removes a retained case paragraph" : "edit removes a numeric detail with no surviving occurrence" });
        continue;
      }
    }
    const candidateWords = candidate.reduce((sum, chapter) => sum + countReadableWords(chapter.markdown), 0);
    if (candidateWords < options.wordBudget.min || candidateWords > options.wordBudget.max) {
      rejectedGroups.push({ id: group.id, reason: "linked changes violate the whole-book word budget" });
      continue;
    }
    for (const [id, text] of byId) replacements.set(id, text);
    accepted.push(...group.changes);
    acceptedGroups.push(group);
    appliedGroups.push(group.id);
  }
  const chapters = applyDevelopmentChanges(options.chapters, accepted, replacements);
  const afterWords = chapters.reduce((sum, chapter) => sum + countReadableWords(chapter.markdown), 0);
  return { chapters, plan: result.data, appliedGroups, rejectedGroups, beforeWords, afterWords };
}
