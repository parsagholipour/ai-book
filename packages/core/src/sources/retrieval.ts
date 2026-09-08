import type { SourcePassage } from "./types.js";

/** Same reciprocal-rank fusion as manuscript memory; both arms share candidates. */
export function rankSourcePassages(
  rows: Array<SourcePassage & { embedding?: number[] | undefined }>, query: string, vector?: number[]
): SourcePassage[] {
  const fold = (text: string) => text.normalize("NFKC").toLowerCase().replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[\u200c\u200d]/g, " ");
  const terms = [...new Set(fold(query).match(/[\p{L}\p{N}]+/gu) ?? [])].filter((word) => word.length > 1);
  const documents = rows.map((row) => ({ row, text: fold(`${row.name}\n${row.locator}\n${row.content}`) }));
  const frequencies = new Map(terms.map((term) => [term, documents.reduce((count, document) => count + (document.text.includes(term) ? 1 : 0), 0)]));
  const lexical = documents.map(({ row, text }) => ({
    row,
    // Rare names and numbers outweigh generic terms in long generation prompts.
    score: terms.reduce((sum, term) => sum + (text.includes(term) ? Math.log(1 + rows.length / ((frequencies.get(term) ?? 0) + 0.5)) : 0), 0)
  })).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score);
  const semantic = vector?.length ? rows.map((row) => ({ row, score: cosine(vector, row.embedding) }))
    .filter((hit) => hit.score > 0.25).sort((a, b) => b.score - a.score) : [];
  const scores = new Map<SourcePassage, number>();
  for (const ranking of [lexical, semantic]) ranking.slice(0, 40).forEach(({ row }, index) => scores.set(row, (scores.get(row) ?? 0) + 1 / (60 + index + 1)));
  // Stable tie-breaking is source order, never newest-upload priority.
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([row]) => {
    const { embedding: _embedding, ...passage } = row as SourcePassage & { embedding?: number[] };
    return passage;
  });
}
function cosine(a: number[], b?: number[]): number {
  if (!b || b.length !== a.length || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
