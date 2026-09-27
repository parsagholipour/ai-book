import { z } from "zod";

export const prohibitionCitationSchema = z.object({ pageIndex: z.number().int().positive(), quote: z.string().trim().min(1) });
const citation = prohibitionCitationSchema;
export const prohibitionAssessmentSchema = z.object({
  scope: z.literal("whole_manuscript"), complete: z.boolean(),
  checkedPageIndexes: z.array(z.number().int().positive()),
  entities: z.array(z.object({
    name: z.string().trim().min(1), aliases: z.array(z.string().trim().min(1)).default([]),
    role: z.enum(["main_character", "supporting_character", "place", "object", "other", "uncertain"]),
    reason: z.string().trim().min(1), evidence: z.array(citation).min(1), permissionQuote: z.string().trim().min(1).nullable(),
    // Legacy assessments can use an existing named role witness as their anchor.
    namingEvidence: citation.optional()
  })),
  counterexamples: z.array(citation)
});
export type ProhibitionAssessment = z.infer<typeof prohibitionAssessmentSchema>;
type Assessment = ProhibitionAssessment;
type Page = { index: number; markdown: string };
type Requirement = { kind: string; prohibitionScope?: string | undefined };

/** Compatibility for the exact independently labelled English obligation that
 * older inventories treated as content. Other wording uses the typed inventory;
 * a negative keyword alone must never waive ordinary prose evidence. */
export function normalizeCoverageProhibition<T extends Requirement & { text: string; quote: string }>(requirement: T, brief: string): T {
  const named = "(?:extra|additional|new) named (?:main|central) characters";
  const label = new RegExp(`^(?:avoid|no|without|do not (?:add|introduce|include)) (?:any )?${named}[.!]?$`, "iu");
  const source = new RegExp(`^(?:avoid|no|without|do not (?:add|introduce|include))\\b[^.!?;]*\\b${named}[.!]?$`, "iu");
  const quotedAt = requirement.quote ? brief.indexOf(requirement.quote) : -1;
  // Captured inventories may quote only the final item in an Avoid-list.
  // Recover its governing clause from the authoritative brief, never the label.
  const prefix = quotedAt < 0 ? "" : brief.slice(0, quotedAt).split(/[.!?;\n]/u).at(-1) ?? "";
  const clause = `${prefix}${requirement.quote}`.trim();
  if (["content", "character"].includes(requirement.kind) && label.test(requirement.text.trim()) && quotedAt >= 0 &&
    brief.indexOf(requirement.quote, quotedAt + requirement.quote.length) < 0 && source.test(clause) &&
    !/\b(?:but|unless|except|instead|allow)\b/iu.test(clause))
    return { ...requirement, kind: "prohibition", prohibitionScope: "named_main_characters" };
  return requirement;
}

const normalizeName = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
function mentions(text: string, name: string): boolean {
  const escaped = normalizeName(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(normalizeName(text));
}
export function namesProhibitionEntity(text: string, entity: Pick<Assessment["entities"][number], "name" | "aliases">): boolean {
  return [entity.name, ...entity.aliases].some(name => mentions(text, name));
}
export function hasProhibitionNameAnchor(entity: Assessment["entities"][number], pages: readonly Page[]): boolean {
  const anchors = entity.namingEvidence ? [entity.namingEvidence] : entity.evidence;
  return anchors.some(item => pages.some(page => page.index === item.pageIndex && page.markdown.includes(item.quote)) &&
    namesProhibitionEntity(item.quote, entity));
}
function sameIndexes(actual: readonly number[], expected: readonly number[]): boolean {
  const unique = new Set(actual);
  return actual.length === expected.length && unique.size === actual.length && expected.every(index => unique.has(index));
}

/** The model assesses roles and exhaustiveness; code verifies scope, exact
 * entity witnesses and permission provenance. This is not deterministic NER. */
export function prohibitionCoverageVerdict(options: {
  requirement: Requirement; brief: string; pages: readonly Page[]; assessmentComplete: boolean;
  answer?: { status: string; prohibitionAssessment?: unknown } | undefined;
  expectedPageIndexes?: readonly number[] | undefined;
  knownCharacterNames?: readonly string[] | undefined;
  selectedCharacterNames?: readonly string[] | undefined;
}): { status: "fulfilled" | "missing" | "unverified"; reason: string; evidence: z.infer<typeof citation>[]; prohibitionAssessment?: Assessment } | undefined {
  if (options.requirement.kind !== "prohibition") return undefined;
  const parsed = prohibitionAssessmentSchema.safeParse(options.answer?.prohibitionAssessment);
  const assessment = parsed.success ? parsed.data : undefined;
  const unverified = (reason: string) => ({ status: "unverified" as const, reason,
    evidence: [], ...(assessment ? { prohibitionAssessment: assessment } : {}) });
  if (options.requirement.prohibitionScope !== "named_main_characters")
    return unverified("This prohibition has no supported, independently scoped assessment contract.");
  if (!assessment) return unverified("A complete manuscript-wide cast assessment is required; a local prose quotation cannot establish absence of extra named main characters.");
  const indexes = options.pages.map(page => page.index);
  if (!options.assessmentComplete || !assessment.complete || !indexes.length || new Set(indexes).size !== indexes.length ||
    options.pages.some(page => !page.markdown.trim()) || !sameIndexes(assessment.checkedPageIndexes, indexes) ||
    (options.expectedPageIndexes && !sameIndexes(indexes, options.expectedPageIndexes)))
    return unverified("The cast assessment did not inspect every page of the supplied final manuscript exactly once.");
  const pages = new Map(options.pages.map(page => [page.index, page.markdown]));
  const grounded = (item: z.infer<typeof citation>) => Boolean(pages.get(item.pageIndex)?.includes(item.quote));
  const names = new Set<string>();
  const extras: Assessment["entities"] = [];
  for (const entity of assessment.entities) {
    const aliases = [entity.name, ...entity.aliases];
    if (aliases.some(name => names.has(normalizeName(name))) || new Set(aliases.map(normalizeName)).size !== aliases.length)
      return unverified("The cast assessment contains duplicate or ambiguous entity names or aliases.");
    aliases.forEach(name => names.add(normalizeName(name)));
    if (!entity.evidence.every(grounded) || !hasProhibitionNameAnchor(entity, options.pages) ||
      !aliases.every(name => options.pages.some(page => mentions(page.markdown, name))))
      return unverified(`The role assigned to ${entity.name} lacks exact manuscript evidence naming that entity.`);
    if (entity.role === "uncertain") return unverified(`The role of ${entity.name} remains uncertain.`);
    if (entity.role !== "main_character") continue;
    if (entity.permissionQuote === null) { extras.push(entity); continue; }
    if (!options.brief.includes(entity.permissionQuote) || !(aliases.some(name => mentions(entity.permissionQuote!, name)) ||
      options.selectedCharacterNames?.some(name => aliases.some(alias => normalizeName(alias) === normalizeName(name)))))
      return unverified(`The permission for main character ${entity.name} is not grounded in the brief or selected character identities.`);
  }
  // Plan characters are candidates to account for, never permission to introduce
  // them. Only the original brief/selected identities can grant that permission.
  for (const name of [...(options.knownCharacterNames ?? []), ...(options.selectedCharacterNames ?? [])]) {
    if (options.pages.some(page => mentions(page.markdown, name)) && !names.has(normalizeName(name)))
      return unverified(`The cast assessment omitted the observed character ${name}.`);
  }
  if (!assessment.counterexamples.every(grounded)) return unverified("A reported prohibition counterexample has invalid manuscript evidence.");
  if (extras.length) {
    if (!extras.every(entity => assessment.counterexamples.some(item =>
      [entity.name, ...entity.aliases].some(name => mentions(item.quote, name)) &&
      entity.evidence.some(evidence => evidence.pageIndex === item.pageIndex && evidence.quote === item.quote))) ||
      !assessment.counterexamples.every(item => extras.some(entity => entity.evidence.some(evidence =>
        evidence.pageIndex === item.pageIndex && evidence.quote === item.quote))))
      return unverified("Every extra named main character needs an exact role-evidence counterexample; unrelated passages cannot establish a violation.");
    if (options.answer?.status === "unverified") return unverified("The reviewer remains uncertain about the reported extra named main characters.");
    return { status: "missing", reason: `The manuscript introduces extra named main characters: ${extras.map(entity => `${entity.name} — ${entity.reason}`).join("; ")}`,
      evidence: assessment.counterexamples, prohibitionAssessment: assessment };
  }
  if (assessment.counterexamples.length || options.answer?.status !== "fulfilled")
    return unverified("The prohibition verdict conflicts with its cast assessment or lacks a grounded counterexample.");
  return { status: "fulfilled", reason: `The complete ${indexes.length}-page cast assessment found no extra named main characters; observed entities have grounded roles and main-character permissions.`,
    evidence: [], prohibitionAssessment: assessment };
}

export const PROHIBITION_INVENTORY_GUIDANCE = "For a manuscript-wide prohibition of extra named main/central characters, use kind prohibition with prohibitionScope named_main_characters. Keep this independently labelled, even if it shares a brief sentence with other prohibitions. Do not apply this contract to positive character requirements, character growth, image restrictions, or other negative constraints; those retain their own evidence contracts.";
export const PROHIBITION_REVIEW_GUIDANCE = [
  "Use literal manuscript names or referring phrases in name and aliases, including for unnamed groups (for example, name:'the neighbors'). Put descriptive labels such as unnamed group in reason, never invent them as names or aliases.",
  "For kind prohibition, do not try to prove whole-book absence with a local quotation. Return prohibitionAssessment {scope:'whole_manuscript',complete,checkedPageIndexes,entities,counterexamples} in the SAME verification response; inspect every supplied page, including the ending. Incomplete or uncertain inspection is unverified.",
  "For prohibitionScope named_main_characters, inventory all observed named entities, consolidating aliases: each entity has name, aliases:[], role main_character|supporting_character|place|object|other|uncertain, reason, evidence:[{pageIndex,quote}], permissionQuote:string|null, and optional namingEvidence:{pageIndex,quote}. Supply at least one exact naming anchor: an existing role witness explicitly naming the entity or an alias suffices; add namingEvidence only when no role witness names it. Do not repeat a quote in both fields. evidence contains exact prose demonstrating that same entity's role or actions; pronouns are allowed only when context clearly identifies this entity. Supply at least one role witness. Do not attach another actor's action to an entity just because its name appears nearby. Main characters drive sustained action or consequential choices; an incidental helper is not automatically a main character. Objects, lantern colors, chapter/book titles and place names are not characters unless the actual prose makes them acting characters. Include late arrivals and distinguish unnamed groups from named individuals. Assess role against the entire story, not occurrence count alone.",
  "A permitted main character needs permissionQuote copied exactly from the ORIGINAL brief authorizing that character. Name/alias must occur in that clause, or match evidenceContext.selectedCharacterNames when the quoted clause authorizes the selected characters. evidenceContext.characters is a plan-derived candidate inventory, NOT permission to add protagonists. Use permissionQuote:null for unrequested main characters and for all other roles. Do not invent authorization from a plan, title or manuscript. If authorization is ambiguous, mark the assessment incomplete rather than inventing a violation.",
  "Counterexamples must be the same exact page/quote witnesses used for each extra named main character's role. A fully inspected story without violations returns status fulfilled, evidence:[], counterexamples:[] and the complete grounded entity inventory. A violation returns missing with counterexamples; an incomplete or unsupported assessment returns unverified. A positive requirement still needs its ordinary prose evidence even when a prohibition assessment is supplied. Role/exhaustiveness judgments are semantic assessments, not deterministic proof of absence."
].join(" ");
