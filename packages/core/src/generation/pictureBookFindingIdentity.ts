import { z } from "zod";
import { pageFindingProvenance } from "./manuscriptQualityProvenance.js";
import type { StoryExtractResult } from "./storyState.js";

type Finding = { domain: string; category: string; message: string; quote: string; requirementQuote: string | null;
  relatedEvidence: { pageIndex: number; quote: string }[] };
export function pictureBookFindingDiagnosis(pageIndex: number, finding: Finding): string {
  return [finding.message, `Evidence on page ${pageIndex}: “${finding.quote}”`,
    ...finding.relatedEvidence.map(e => `Related page ${e.pageIndex}: “${e.quote}”`),
    ...(finding.requirementQuote ? [`Requested requirement: “${finding.requirementQuote}”`] : [])].join(" ");
}
const linksSchema = z.array(z.strictObject({ contradiction: z.string(), findingIndex: z.number().int().nonnegative() })).max(8);
export function linkContinuityFindings(extract: StoryExtractResult | null, pageIndex: number, findings: readonly Finding[], links: unknown): StoryExtractResult | null {
  const parsed = linksSchema.safeParse(links);
  if (!extract || !parsed.success) return extract;
  const identities = Object.fromEntries(parsed.data.flatMap(link => {
    const finding = findings[link.findingIndex];
    if (!extract.contradictions.includes(link.contradiction) || finding?.domain !== "prose" || finding.category !== "continuity" ||
      parsed.data.filter(other => other.contradiction === link.contradiction).length !== 1) return [];
    return [[link.contradiction, pageFindingProvenance(pageIndex, pictureBookFindingDiagnosis(pageIndex, finding)).findingId!]];
  }));
  return Object.keys(identities).length ? { ...extract, findingIdsByContradiction: identities } : extract;
}
