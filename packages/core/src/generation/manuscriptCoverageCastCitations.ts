import { exactCoverageCitationResolver } from "./manuscriptCoverageCitations.js";
import { namesProhibitionEntity, type ProhibitionAssessment } from "./manuscriptCoverageProhibitions.js";

type Page = { index: number; markdown: string };
type Entity = ProhibitionAssessment["entities"][number];
const fold = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

/** Repair source coordinates and a legacy unnamed-group label, never roles or cast membership. */
export function recoverCastCitationCoordinates(assessment: ProhibitionAssessment, pages: readonly Page[]): ProhibitionAssessment {
  const resolve = exactCoverageCitationResolver(pages);
  const corrections = new Map<string, { pageIndex: number; quote: string }>();
  const recover = (citation: { pageIndex: number; quote: string }, entity: Entity) => {
    // Moving pronoun-only actions could silently attach a different actor's role.
    if (!namesProhibitionEntity(citation.quote, entity)) return citation;
    const resolved = resolve(citation);
    if (!resolved) return citation;
    corrections.set(JSON.stringify(citation), resolved);
    return resolved;
  };
  const entities = assessment.entities.map(entity => {
    const next = { ...entity, evidence: entity.evidence.map(citation => recover(citation, entity)),
      ...(entity.namingEvidence ? { namingEvidence: recover(entity.namingEvidence, entity) } : {}) };
    // Older reviewers put "unnamed neighbors" in name and the literal "the neighbors"
    // in aliases. Canonicalize only that explicit wrapper on role=other, with a
    // grounded role witness. Unknown labels and individual character roles stay strict.
    const label = /^unnamed (.+)$/u.exec(fold(next.name))?.[1];
    if (next.role !== "other" || next.permissionQuote !== null || !label ||
      new Set(next.aliases.map(fold)).size !== next.aliases.length ||
      pages.some(page => namesProhibitionEntity(page.markdown, { name: next.name, aliases: [] }))) return next;
    const alias = next.aliases.find(name => fold(name).replace(/^the /u, "") === label &&
      next.evidence.some(citation => pages.some(page => page.index === citation.pageIndex && page.markdown.includes(citation.quote)) &&
        namesProhibitionEntity(citation.quote, { name, aliases: [] })));
    return alias ? { ...next, name: alias, aliases: next.aliases.filter(name => name !== alias) } : next;
  });
  return { ...assessment, entities, counterexamples: assessment.counterexamples.map(citation => corrections.get(JSON.stringify(citation)) ?? citation) };
}
