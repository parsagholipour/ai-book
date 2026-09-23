/**
 * Search summaries are orientation, not verbatim evidence. Apply one prompt-only
 * budget to compose, edit and acceptance; never charge dossier/correction passages
 * against it. Caller order is the chapter-specific retrieval ranking.
 */
export const CHAPTER_RESEARCH_CONTEXT_LIMITS = { notes: 18, noteChars: 2_000, jsonChars: 12_000 } as const;
export const CHAPTER_RESEARCH_CONTEXT_RULE =
  "researchNotes contains bounded background summaries, which may be shortened or omitted; they are research leads, not verbatim evidence. Use dossier, caseEvidence and factualCorrection passages for factual verification. A summary's omission does not itself establish that a claim is false. Do not quote a summary-shortening marker in the chapter.";

const SHORTENED = " [Summary shortened; consult source passages for evidence.]";
const OMITTED = "[Summary omitted; consult source passages for evidence.]";
const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
const jsonLength = (text: string) => JSON.stringify(text).length;

/** Preserve complete sentences, source labels and Unicode; never cut a qualifier mid-sentence. */
function fitSummary(note: string, budget: number): string {
  if (jsonLength(note) <= budget) return note;
  // Stored source notes are `title: summary`; an untitled research brief is plain prose.
  const label = note.match(/^[^\n]{1,400}?:\s+/u)?.[0] ?? "";
  let kept = label;
  for (const { segment } of sentences.segment(note.slice(label.length))) {
    const next = kept + segment;
    if (jsonLength(next.trimEnd() + SHORTENED) > budget) break;
    kept = next;
  }
  if (kept !== label) return kept.trimEnd() + SHORTENED;
  const omitted = label + OMITTED;
  return jsonLength(omitted) <= budget ? omitted : OMITTED;
}

export function chapterResearchNotesForPrompt(notes: readonly string[]): string[] {
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const note of notes) {
    const trimmed = note.trim();
    const key = trimmed.replace(/\s+/gu, " ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(trimmed);
    if (selected.length === CHAPTER_RESEARCH_CONTEXT_LIMITS.notes) break;
  }
  // Short notes release their unused allowance to longer ones. No early giant
  // summary can consume every source's slot. Include JSON escaping and separators.
  let remaining = CHAPTER_RESEARCH_CONTEXT_LIMITS.jsonChars - 2 - Math.max(0, selected.length - 1);
  const fitted = new Map<number, string>();
  const byLength = selected.map((note, index) => ({ note, index }))
    .sort((a, b) => jsonLength(a.note) - jsonLength(b.note));
  for (const [position, { note, index }] of byLength.entries()) {
    const budget = Math.min(CHAPTER_RESEARCH_CONTEXT_LIMITS.noteChars, Math.floor(remaining / (byLength.length - position)));
    const value = fitSummary(note, budget);
    fitted.set(index, value);
    remaining -= jsonLength(value);
  }
  return selected.map((_, index) => fitted.get(index)!);
}
