import { createHash } from "node:crypto";
import { z } from "zod";

import type { ChatMessage, TextModelAdapter } from "../adapters/types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

import type { EditAdherenceFindings, EditAdherencePage } from "./editAdherence.js";

/**
 * A byte is a conservative upper bound for a tokenizer token. Keeping the
 * serialized messages below 20 KiB therefore leaves ample room in a 32k-token
 * context for provider JSON/schema framing and the bounded output below.
 */
export const EDIT_ADHERENCE_MESSAGE_BUDGET_BYTES = 20 * 1024;

const MAX_LEAF_INPUTS_PER_CALL = 16;
const MAX_REDUCER_INPUTS_PER_CALL = 2;
const LEAF_REVIEW_CONCURRENCY = 4;
export const EDIT_ADHERENCE_EVIDENCE_CAPACITY = 8;
/**
 * One slot above the capacity the prompts advertise, and deliberately never
 * offered to the provider. A list clipped by its ceiling and a list that simply
 * used every slot it was given are otherwise the same length, so refusing both
 * refuses an edit that was applied correctly. Reaching this slot is the
 * observable overflow: the model needed more room than it was told it had, and
 * its evidence is incomplete however it filled `evidenceComplete` in.
 */
const EVIDENCE_OVERFLOW_CEILING = EDIT_ADHERENCE_EVIDENCE_CAPACITY + 1;
const MAX_EVIDENCE_ITEM_LENGTH = 180;
const MAX_LEAF_PAGE_INDEXES = 64;
/** One operation-level verdict's bounds, whichever call produced it. */
export const MAX_VERDICT_PROSE_ITEMS = 30;
export const MAX_VERDICT_PROSE_LENGTH = 500;
export const MAX_VERDICT_REVISION_INDEXES = 100;
const MAX_INPUT_ID_LENGTH = 160;
const POSITIVE_EVIDENCE_KINDS = ["observedChanges", "requirementEvidence"] as const;

/**
 * **A leaf that says it could not fit its evidence — by the flag or by the
 * overflow slot — is asking for less manuscript, not refusing the edit.** Every
 * throw here becomes a fail-closed verdict that refunds the reader, and the
 * capacity is per *call*, so halve the group and ask again — twice at most,
 * because a quarter of the smallest packing that still needs more than eight
 * facts a category is unsummarizable.
 */
const MAX_LEAF_SPLIT_DEPTH = 2;

/**
 * How many negative facts the final call may account for. Possible omissions
 * and contradictions never pass through a reducer, so this grows with the
 * manuscript at up to `EDIT_ADHERENCE_EVIDENCE_CAPACITY` of each per leaf. It
 * was 48, sized against an echo of 69-character ids at 40 output tokens apiece;
 * at the width below, 96 negatives *and* 96 resolved omissions measure 2,340
 * tokens rather than 3,783, so an oversized final call is refused by what
 * actually fits — `assertMessagesFit` — not by a count sized for a gone cost.
 */
const MAX_FINAL_NEGATIVE_FACTS = 96;

/**
 * **A fact id is transcribed character for character by the model that accepts
 * it, so its width is an output budget.** The id must be unique inside one
 * review and a function of the node, kind, text and lineage behind it; 64 bits
 * of the SHA-256 is both, and `assertUniqueFactIds` fails closed on the
 * collision truncation makes possible at around one in 10^16. The full digest
 * only bought price — measured against cl100k_base and o200k_base, which agree:
 * `"fact-<64 hex>",` costs 40 output tokens and `"fact-<16 hex>",` costs 13.
 */
const FACT_ID_HEX_LENGTH = 16;
/** One id, and one page index, quoted or not, and comma'd. */
const MAX_FACT_ID_CHARS = FACT_ID_HEX_LENGTH + 8;
const MAX_PAGE_INDEX_CHARS = 8;
/** Braces, key names, the booleans, the confidence and the two 64-hex digests. */
const REVIEW_RESPONSE_FRAME_CHARS = 400;

/**
 * **One output token per response character, because this schema can force
 * either of the two densest things a tokenizer sees.** A byte is the
 * conservative unit for a *request*; a character is it for a *response*,
 * measured rather than assumed — hex runs at 1.78 characters per token and
 * Hindi, Hebrew, Japanese and Chinese prose at 0.90-1.24, and this review's
 * evidence is written about the book, in the book's language. One shared 1,200
 * carried none of the four calls: a leaf at its advertised capacity measures
 * 1,534 tokens of Latin prose and some 6,500 of Devanagari, a reducer's
 * mandatory lineage echo 1,354, the final verdict 2,133 at 48 negatives alone,
 * and the undivided whole-set review 1,579 at six missing requirements and two
 * contradictions of a leaf's own 180 characters — that one being the call
 * nobody re-measured, and the common one, since everything under
 * `EDIT_ADHERENCE_MESSAGE_BUDGET_BYTES` takes it and most edits are one to
 * three pages. Truncation is a parse error that `repairAttempts: 0` turns into
 * `EDIT_ADHERENCE_FAILED`, refunding a reader whose edit may have been applied
 * correctly. `maxTokens` is a runaway fuse rather than a reservation, the
 * reading `pages.ts` asks 64,000 output tokens on, so the schema-derived fuse
 * costs nothing until output is actually spent.
 */
const REVIEW_MIN_OUTPUT_TOKENS = 1200;

/** Both operation-level verdicts are one object, so one budget answers both. */
const VERDICT_PROSE_CHARS =
  2 * jsonStringChars(MAX_VERDICT_PROSE_ITEMS, MAX_VERDICT_PROSE_LENGTH) +
  MAX_VERDICT_REVISION_INDEXES * MAX_PAGE_INDEX_CHARS + REVIEW_RESPONSE_FRAME_CHARS;
export const WHOLE_SET_REVIEW_MAX_TOKENS = reviewMaxTokens(VERDICT_PROSE_CHARS);

const EVIDENCE_SYSTEM_MESSAGE = [
  "You collect bounded evidence for an instruction-adherence review of an approved book edit.",
  "Inspect every supplied manuscript segment and report concrete facts relevant to the approved instruction.",
  "Do not make the operation-level satisfied or missing judgment: a requirement may be fulfilled in another segment.",
  "Preserve evidence of performed changes, possible omissions or softening, and contradictions for the global reviewer.",
  `Each evidence list has capacity ${EDIT_ADHERENCE_EVIDENCE_CAPACITY}; set evidenceComplete=false rather than omitting, sampling, or truncating a material fact, and a smaller slice of the same manuscript will be sent back to you.`,
  "Copy every supplied segment id into acceptedInputIds exactly once. Return only the required JSON object."
].join(" ");

const REDUCER_SYSTEM_MESSAGE = [
  "You merge complete bounded evidence for an instruction-adherence review of an approved book edit.",
  "Summarize the supplied positive facts without inventing or dropping any of them.",
  "Combine complementary evidence because one requirement may be distributed across nodes.",
  "Every output fact must list the exact sourceFactIds it summarizes; across each category, those ids must reproduce every supplied fact id exactly once and in order.",
  `Each output list has capacity ${EDIT_ADHERENCE_EVIDENCE_CAPACITY}: name more source facts in one summary rather than omitting, sampling, or truncating any of them, and set evidenceComplete=false only if you could not name every supplied fact id.`,
  "Do not make the operation-level satisfied judgment. Copy every supplied node id into acceptedInputIds exactly once.",
  "Return only the required JSON object."
].join(" ");

const FINAL_SYSTEM_MESSAGE = [
  "You are the final instruction-adherence checker for an already approved book edit.",
  "The evidence covers the complete before/after candidate set. Make one operation-level judgment over all of it.",
  "Judge only whether the after pages fully perform the approved instruction when compared with the before pages.",
  "Do not judge morality, safety, taste, advisability, writing style, or whether you would have chosen this edit.",
  "Requirements may be distributed across evidence nodes, but a material omission, contradiction, substitution, or silent softening means satisfied is false.",
  "Copy every supplied negative fact id into acceptedNegativeFactIds exactly once and in order.",
  "A possible omission may appear in resolvedPossibleOmissionIds only when the complete positive evidence proves that exact concern was fulfilled elsewhere; preserve order and never include a contradiction id.",
  "missingRequirements, contradictions and pageIndexesToRevise are the repair order a satisfied=false verdict carries: name the concrete unmet requirements, the contradictions, and the after pages that can repair them. Leave all three empty when satisfied is true — nothing else is read from a satisfied verdict, and this review has no field for optional improvements.",
  "Copy the supplied evidence id, coverage digest, and evidence digest exactly. Return only the required JSON object."
].join(" ");

const evidenceStringSchema = z.string().trim().min(1).max(MAX_EVIDENCE_ITEM_LENGTH);
const factIdSchema = z.string().regex(new RegExp(`^fact-[a-f0-9]{${FACT_ID_HEX_LENGTH}}$`));
const finalProseSchema = z.string().trim().min(1).max(MAX_VERDICT_PROSE_LENGTH);
const inputIdSchema = z.string().trim().min(1).max(MAX_INPUT_ID_LENGTH);

const leafEvidenceResponseSchema = z
  .object({
    acceptedInputIds: z.array(inputIdSchema).min(1).max(MAX_LEAF_INPUTS_PER_CALL),
    evidenceComplete: z.boolean(),
    observedChanges: evidenceStringsSchema(),
    requirementEvidence: evidenceStringsSchema(),
    possibleOmissions: evidenceStringsSchema(),
    contradictions: evidenceStringsSchema(),
    pageIndexes: z.array(z.number().int()).max(MAX_LEAF_PAGE_INDEXES)
  })
  .strict();

const reducedEvidenceFactSchema = z
  .object({
    text: evidenceStringSchema,
    // Every accepted node holds at most the advertised capacity per category,
    // because an overflowing one never becomes a node, so a summary of both
    // reducer inputs can name at most twice that many source facts.
    sourceFactIds: z.array(factIdSchema).min(1).max(EDIT_ADHERENCE_EVIDENCE_CAPACITY * 2)
  })
  .strict();

const reducerEvidenceResponseSchema = z
  .object({
    acceptedInputIds: z.array(inputIdSchema).min(2).max(MAX_REDUCER_INPUTS_PER_CALL),
    evidenceComplete: z.boolean(),
    observedChanges: z.array(reducedEvidenceFactSchema).max(EVIDENCE_OVERFLOW_CEILING),
    requirementEvidence: z.array(reducedEvidenceFactSchema).max(EVIDENCE_OVERFLOW_CEILING)
  })
  .strict();

const finalResponseSchema = z
  .object({
    satisfied: z.boolean(),
    confidence: z.number().min(0).max(1),
    missingRequirements: z.array(finalProseSchema).max(MAX_VERDICT_PROSE_ITEMS),
    contradictions: z.array(finalProseSchema).max(MAX_VERDICT_PROSE_ITEMS),
    pageIndexesToRevise: z.array(z.number().int().positive()).max(MAX_VERDICT_REVISION_INDEXES),
    acceptedEvidenceId: inputIdSchema,
    coverageDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    acceptedNegativeFactIds: z.array(factIdSchema).max(MAX_FINAL_NEGATIVE_FACTS),
    resolvedPossibleOmissionIds: z.array(factIdSchema).max(MAX_FINAL_NEGATIVE_FACTS)
  })
  .strict();

type AdherenceSide = "before" | "after";

type ManuscriptSegment = {
  id: string;
  ordinal: number;
  side: AdherenceSide;
  pagePosition: number;
  pageIndex: number;
  part: number;
  charStart: number;
  charEnd: number;
  byteStart: number;
  byteEnd: number;
  content: string;
};

type EvidenceKind = "observedChanges" | "requirementEvidence" | "possibleOmissions" | "contradictions";
type PositiveEvidenceKind = Extract<EvidenceKind, "observedChanges" | "requirementEvidence">;
type NegativeEvidenceKind = Exclude<EvidenceKind, PositiveEvidenceKind>;

type EvidenceFact<K extends EvidenceKind = EvidenceKind> = {
  id: string;
  kind: K;
  text: string;
};

type LeafEvidence = z.infer<typeof leafEvidenceResponseSchema>;
type ReducerEvidence = z.infer<typeof reducerEvidenceResponseSchema>;
type NodeEvidence = {
  observedChanges: EvidenceFact<"observedChanges">[];
  requirementEvidence: EvidenceFact<"requirementEvidence">[];
  possibleOmissions: EvidenceFact<"possibleOmissions">[];
  contradictions: EvidenceFact<"contradictions">[];
  pageIndexes: number[];
};

type EvidenceNode = {
  id: string;
  level: number;
  coverageStart: number;
  coverageEnd: number;
  coverageCount: number;
  coverageDigest: string;
  evidenceDigest: string;
  evidence: NodeEvidence;
};

/** One leaf group's answer, before node ids exist to hash its facts under. */
type CollectedLeaf = { segments: ManuscriptSegment[]; evidence: LeafEvidence };

export type HierarchicalAdherenceReviewOptions = {
  instruction: string;
  beforePages: EditAdherencePage[];
  afterPages: EditAdherencePage[];
  textModel: TextModelAdapter;
};

export function serializedAdherenceMessageBytes(messages: ChatMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

export function adherenceMessagesFit(messages: ChatMessage[]): boolean {
  return serializedAdherenceMessageBytes(messages) <= EDIT_ADHERENCE_MESSAGE_BUDGET_BYTES;
}

export function canonicalAdherencePageText(page: EditAdherencePage): string {
  return [
    `TITLE UTF-8 BYTES ${Buffer.byteLength(page.title, "utf8")}\n`,
    page.title,
    `\nMARKDOWN UTF-8 BYTES ${Buffer.byteLength(page.markdown, "utf8")}\n`,
    page.markdown,
    `\nSUMMARY UTF-8 BYTES ${Buffer.byteLength(page.summary, "utf8")}\n`,
    page.summary
  ].join("");
}

export async function reviewHierarchically(
  options: HierarchicalAdherenceReviewOptions
): Promise<EditAdherenceFindings> {
  const segments = buildSegments(options);
  if (segments.length === 0) {
    throw new Error("The complete manuscript produced no adherence-review coverage.");
  }
  let nodes = await collectLeafEvidence(options, segments);
  while (nodes.length > 1) {
    const reduced = await reduceEvidenceLevel(options, nodes);
    if (reduced.length >= nodes.length) {
      throw new Error("The adherence evidence could not be reduced within the input budget.");
    }
    nodes = reduced;
  }
  return decideGlobalVerdict(options, nodes[0]!, segments.length);
}

function evidenceStringsSchema() {
  return z.array(evidenceStringSchema).max(EVIDENCE_OVERFLOW_CEILING);
}

function buildSegments(options: HierarchicalAdherenceReviewOptions): ManuscriptSegment[] {
  const segments: ManuscriptSegment[] = [];
  for (const side of ["before", "after"] as const) {
    const pages = side === "before" ? options.beforePages : options.afterPages;
    for (const [pagePosition, page] of pages.entries()) {
      segments.push(...segmentPage(options.instruction, side, pagePosition, page, segments.length));
    }
  }
  return segments.map((segment, ordinal) => ({ ...segment, ordinal }));
}

function segmentPage(
  instruction: string,
  side: AdherenceSide,
  pagePosition: number,
  page: EditAdherencePage,
  firstOrdinal: number
): ManuscriptSegment[] {
  const text = canonicalAdherencePageText(page);
  const segments: ManuscriptSegment[] = [];
  let charStart = 0;
  let byteStart = 0;
  let part = 0;
  do {
    const template = (content: string, charEnd: number, byteEnd: number): ManuscriptSegment => ({
      id: segmentId(side, pagePosition, page.index, part),
      ordinal: firstOrdinal + part,
      side,
      pagePosition,
      pageIndex: page.index,
      part,
      charStart,
      charEnd,
      byteStart,
      byteEnd,
      content
    });
    const charEnd = largestFittingEnd(text, charStart, (candidateEnd) => {
      const content = text.slice(charStart, candidateEnd);
      const byteEnd = byteStart + Buffer.byteLength(content, "utf8");
      return adherenceMessagesFit(
        leafMessages(instruction, [template(content, candidateEnd, byteEnd)], Number.MAX_SAFE_INTEGER)
      );
    });
    if (charEnd < charStart || (charEnd === charStart && text.length > 0)) {
      throw new Error("The approved instruction leaves no room for one complete manuscript code point.");
    }
    const content = text.slice(charStart, charEnd);
    const byteEnd = byteStart + Buffer.byteLength(content, "utf8");
    segments.push(template(content, charEnd, byteEnd));
    charStart = charEnd;
    byteStart = byteEnd;
    part += 1;
  } while (charStart < text.length);
  return segments;
}

function largestFittingEnd(text: string, start: number, fits: (end: number) => boolean): number {
  if (text.length === 0) {
    return fits(0) ? 0 : -1;
  }
  const firstEnd = nextCodePointEnd(text, start);
  if (!fits(firstEnd)) {
    return start;
  }
  let best = firstEnd;
  let low = firstEnd;
  let high = text.length;
  while (low <= high) {
    const rawMidpoint = Math.floor((low + high) / 2);
    const midpoint = safeBoundaryAtOrBefore(text, rawMidpoint);
    if (midpoint <= best) {
      low = rawMidpoint + 1;
      continue;
    }
    if (fits(midpoint)) {
      best = midpoint;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

function nextCodePointEnd(text: string, start: number): number {
  const code = text.charCodeAt(start);
  return start + (code >= 0xd800 && code <= 0xdbff && start + 1 < text.length ? 2 : 1);
}

function safeBoundaryAtOrBefore(text: string, index: number): number {
  if (
    index > 0 &&
    index < text.length &&
    text.charCodeAt(index) >= 0xdc00 &&
    text.charCodeAt(index) <= 0xdfff &&
    text.charCodeAt(index - 1) >= 0xd800 &&
    text.charCodeAt(index - 1) <= 0xdbff
  ) {
    return index - 1;
  }
  return index;
}

async function collectLeafEvidence(
  options: HierarchicalAdherenceReviewOptions,
  segments: ManuscriptSegment[]
): Promise<EvidenceNode[]> {
  const groups = packContiguous(segments, MAX_LEAF_INPUTS_PER_CALL, (group) =>
    leafMessages(options.instruction, group, segments.length)
  );
  const collected = await mapWithConcurrency(groups, LEAF_REVIEW_CONCURRENCY, (group) =>
    collectGroupEvidence(options, group, segments.length, MAX_LEAF_SPLIT_DEPTH)
  );
  // `mapWithConcurrency` preserves order and every split yields contiguous
  // halves, so the flattened leaves still run the manuscript front to back.
  return collected.flat().map((leaf, groupIndex) => nodeFromLeaf(groupIndex, leaf.segments, leaf.evidence));
}

/**
 * One packed group's evidence, halved again while the provider says its bounded
 * lists could not hold what it found. A group that cannot be split — one
 * segment, or `MAX_LEAF_SPLIT_DEPTH` deep — fails closed.
 */
async function collectGroupEvidence(
  options: HierarchicalAdherenceReviewOptions,
  group: ManuscriptSegment[],
  totalSegments: number,
  splitsLeft: number
): Promise<CollectedLeaf[]> {
  const messages = leafMessages(options.instruction, group, totalSegments);
  const evidence = await generateLeafEvidence(options.textModel, messages, group);
  assertExactCoverage(evidence.acceptedInputIds, group.map((segment) => segment.id));
  if (evidence.evidenceComplete && !evidenceOverflowed(evidence)) {
    return [{ segments: group, evidence }];
  }
  if (splitsLeft <= 0 || group.length < 2) {
    throw new Error("The adherence evidence stayed incomplete over the smallest reviewable manuscript slice.");
  }
  const middle = Math.ceil(group.length / 2);
  const halves = [group.slice(0, middle), group.slice(middle)];
  const collected = await mapWithConcurrency(halves, LEAF_REVIEW_CONCURRENCY, (half) =>
    collectGroupEvidence(options, half, totalSegments, splitsLeft - 1)
  );
  return collected.flat();
}

async function reduceEvidenceLevel(
  options: HierarchicalAdherenceReviewOptions,
  nodes: EvidenceNode[]
): Promise<EvidenceNode[]> {
  const groups = packContiguous(
    nodes,
    MAX_REDUCER_INPUTS_PER_CALL,
    (group) => reducerMessages(options.instruction, group)
  );
  return mapWithConcurrency(groups, LEAF_REVIEW_CONCURRENCY, async (group, groupIndex) => {
    if (group.length === 1) {
      return group[0]!;
    }
    assertContiguousNodes(group);
    const messages = reducerMessages(options.instruction, group);
    const evidence = await generateReducerEvidence(options.textModel, messages, group);
    assertExactCoverage(evidence.acceptedInputIds, group.map((node) => node.id));
    assertReducerLineage(evidence, group);
    return nodeFromReduction(groupIndex, group, evidence);
  });
}

async function decideGlobalVerdict(
  options: HierarchicalAdherenceReviewOptions,
  root: EvidenceNode,
  expectedCoverageCount: number
): Promise<EditAdherenceFindings> {
  if (root.coverageStart !== 0 || root.coverageEnd !== expectedCoverageCount - 1 || root.coverageCount !== expectedCoverageCount) {
    throw new Error("The final adherence evidence does not cover the complete manuscript.");
  }
  const negativeFacts = negativeEvidenceFacts(root.evidence);
  if (negativeFacts.length > MAX_FINAL_NEGATIVE_FACTS) {
    throw new Error("The complete negative adherence evidence exceeds the bounded final-review capacity.");
  }
  const messages = finalMessages(options.instruction, root);
  assertMessagesFit(messages);
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "review-edit-adherence",
    temperature: 0,
    maxTokens: reviewMaxTokens(finalResponseChars(root)),
    repairAttempts: 0,
    schema: finalResponseSchema,
    messages
  });
  const parsed = finalResponseSchema.parse(result.data);
  if (
    parsed.acceptedEvidenceId !== root.id ||
    parsed.coverageDigest !== root.coverageDigest ||
    parsed.evidenceDigest !== root.evidenceDigest
  ) {
    throw new Error("The final adherence verdict did not accept the complete evidence coverage.");
  }
  assertExactCoverage(parsed.acceptedNegativeFactIds, negativeFacts.map((fact) => fact.id));
  const omissionFacts = root.evidence.possibleOmissions;
  assertOrderedSubset(
    parsed.resolvedPossibleOmissionIds,
    omissionFacts.map((fact) => fact.id)
  );
  const resolvedOmissionIds = new Set(parsed.resolvedPossibleOmissionIds);
  const unresolvedOmissions = omissionFacts.filter((fact) => !resolvedOmissionIds.has(fact.id));
  const immutableContradictions = root.evidence.contradictions;
  const missingRequirements = uniqueStrings([
    ...parsed.missingRequirements,
    ...unresolvedOmissions.map((fact) => fact.text)
  ]);
  const contradictions = uniqueStrings([
    ...parsed.contradictions,
    ...immutableContradictions.map((fact) => fact.text)
  ]);
  const {
    acceptedEvidenceId: _accepted,
    coverageDigest: _coverageDigest,
    evidenceDigest: _evidenceDigest,
    acceptedNegativeFactIds: _acceptedNegativeFactIds,
    resolvedPossibleOmissionIds: _resolvedPossibleOmissionIds,
    ...providerVerdict
  } = parsed;
  return {
    ...providerVerdict,
    // Only the facts *code* carries may outrank the boolean: an omission this
    // call declined to resolve by id, and a contradiction it was never offered
    // a way to clear. Its own volunteered prose may not — that is one model's
    // remark vetoing the same model's answer in the same response, and
    // `normalizeVerdict` settles it for both review paths.
    satisfied: providerVerdict.satisfied && unresolvedOmissions.length === 0 && immutableContradictions.length === 0,
    missingRequirements,
    contradictions
  };
}

async function generateLeafEvidence(
  textModel: TextModelAdapter,
  messages: ChatMessage[],
  group: ManuscriptSegment[]
): Promise<LeafEvidence> {
  assertMessagesFit(messages);
  const result = await generateJsonWithRetry(textModel, {
    purpose: "review-edit-adherence",
    temperature: 0,
    maxTokens: reviewMaxTokens(leafResponseChars(group)),
    repairAttempts: 0,
    schema: leafEvidenceResponseSchema,
    messages
  });
  return leafEvidenceResponseSchema.parse(result.data);
}

async function generateReducerEvidence(
  textModel: TextModelAdapter,
  messages: ChatMessage[],
  nodes: EvidenceNode[]
): Promise<ReducerEvidence> {
  assertMessagesFit(messages);
  const result = await generateJsonWithRetry(textModel, {
    purpose: "review-edit-adherence",
    temperature: 0,
    maxTokens: reviewMaxTokens(reducerResponseChars(nodes)),
    repairAttempts: 0,
    schema: reducerEvidenceResponseSchema,
    messages
  });
  const evidence = reducerEvidenceResponseSchema.parse(result.data);
  // `assertReducerLineage` names every source fact whatever this bit says, so
  // an incomplete *reduction* is a summary that could not name them — refused
  // next anyway — never the leaf's honest "give me less to read".
  if (!evidence.evidenceComplete || evidenceOverflowed(evidence)) {
    throw new Error("The adherence evidence reduction could not name every supplied fact.");
  }
  return evidence;
}

function leafMessages(instruction: string, segments: ManuscriptSegment[], totalSegments: number): ChatMessage[] {
  return [
    { role: "system", content: EVIDENCE_SYSTEM_MESSAGE },
    {
      role: "user",
      content: JSON.stringify({
        reviewPhase: "collect-evidence",
        approvedInstruction: instruction,
        completeCoverage: { totalSegments },
        segments
      })
    }
  ];
}

function reducerMessages(instruction: string, nodes: EvidenceNode[]): ChatMessage[] {
  return [
    { role: "system", content: REDUCER_SYSTEM_MESSAGE },
    {
      role: "user",
      content: JSON.stringify({
        reviewPhase: "reduce-evidence",
        approvedInstruction: instruction,
        evidenceNodes: nodes.map(reducerInputNode)
      })
    }
  ];
}

function finalMessages(instruction: string, root: EvidenceNode): ChatMessage[] {
  return [
    { role: "system", content: FINAL_SYSTEM_MESSAGE },
    {
      role: "user",
      content: JSON.stringify({
        reviewPhase: "global-verdict",
        approvedInstruction: instruction,
        completeCoverage: {
          evidenceId: root.id,
          segmentCount: root.coverageCount,
          digest: root.coverageDigest,
          evidenceDigest: root.evidenceDigest
        },
        evidence: {
          observedChanges: root.evidence.observedChanges,
          requirementEvidence: root.evidence.requirementEvidence,
          pageIndexes: root.evidence.pageIndexes
        },
        negativeEvidence: {
          possibleOmissions: root.evidence.possibleOmissions,
          contradictions: root.evidence.contradictions
        }
      })
    }
  ];
}

function packContiguous<T>(
  items: T[],
  maxInputs: number,
  messagesFor: (group: T[]) => ChatMessage[]
): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (candidate.length <= maxInputs && adherenceMessagesFit(messagesFor(candidate))) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new Error("One adherence-review input exceeds the message budget.");
    }
    groups.push(current);
    current = [item];
    if (!adherenceMessagesFit(messagesFor(current))) {
      throw new Error("One adherence-review input exceeds the message budget.");
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

function nodeFromLeaf(groupIndex: number, segments: ManuscriptSegment[], evidence: LeafEvidence): EvidenceNode {
  const id = `evidence-0-${groupIndex}`;
  const nodeEvidence = evidenceFromLeaf(id, evidence);
  return {
    id,
    level: 0,
    coverageStart: segments[0]!.ordinal,
    coverageEnd: segments.at(-1)!.ordinal,
    coverageCount: segments.length,
    coverageDigest: digestSegments(segments),
    evidenceDigest: digestEvidence(nodeEvidence),
    evidence: nodeEvidence
  };
}

function nodeFromReduction(groupIndex: number, nodes: EvidenceNode[], evidence: ReducerEvidence): EvidenceNode {
  const level = Math.max(...nodes.map((node) => node.level)) + 1;
  const id = `evidence-${level}-${groupIndex}-${nodes[0]!.coverageStart}`;
  const nodeEvidence = evidenceFromReduction(id, nodes, evidence);
  return {
    id,
    level,
    coverageStart: nodes[0]!.coverageStart,
    coverageEnd: nodes.at(-1)!.coverageEnd,
    coverageCount: nodes.reduce((sum, node) => sum + node.coverageCount, 0),
    coverageDigest: digestNodes(nodes),
    evidenceDigest: digestEvidence(nodeEvidence),
    evidence: nodeEvidence
  };
}

function reducerInputNode(node: EvidenceNode) {
  return {
    id: node.id,
    level: node.level,
    coverageStart: node.coverageStart,
    coverageEnd: node.coverageEnd,
    coverageCount: node.coverageCount,
    coverageDigest: node.coverageDigest,
    evidenceDigest: node.evidenceDigest,
    evidence: {
      observedChanges: node.evidence.observedChanges,
      requirementEvidence: node.evidence.requirementEvidence
    }
  };
}

function evidenceFromLeaf(sourceNodeId: string, evidence: LeafEvidence): NodeEvidence {
  const result: NodeEvidence = {
    observedChanges: factsFromStrings(sourceNodeId, "observedChanges", evidence.observedChanges),
    requirementEvidence: factsFromStrings(sourceNodeId, "requirementEvidence", evidence.requirementEvidence),
    possibleOmissions: factsFromStrings(sourceNodeId, "possibleOmissions", evidence.possibleOmissions),
    contradictions: factsFromStrings(sourceNodeId, "contradictions", evidence.contradictions),
    pageIndexes: uniqueNumbers(evidence.pageIndexes)
  };
  assertUniqueFactIds(allEvidenceFacts(result));
  return result;
}

function evidenceFromReduction(sourceNodeId: string, nodes: EvidenceNode[], evidence: ReducerEvidence): NodeEvidence {
  const result: NodeEvidence = {
    observedChanges: factsFromSummaries(sourceNodeId, "observedChanges", evidence.observedChanges),
    requirementEvidence: factsFromSummaries(sourceNodeId, "requirementEvidence", evidence.requirementEvidence),
    possibleOmissions: nodes.flatMap((node) => node.evidence.possibleOmissions),
    contradictions: nodes.flatMap((node) => node.evidence.contradictions),
    pageIndexes: uniqueNumbers(nodes.flatMap((node) => node.evidence.pageIndexes))
  };
  assertUniqueFactIds(allEvidenceFacts(result));
  return result;
}

function factsFromStrings<K extends EvidenceKind>(sourceNodeId: string, kind: K, values: string[]): EvidenceFact<K>[] {
  return factsFromSummaries(sourceNodeId, kind, values.map((text) => ({ text, sourceFactIds: [] })));
}

function factsFromSummaries<K extends EvidenceKind>(
  sourceNodeId: string,
  kind: K,
  values: Array<{ text: string; sourceFactIds: string[] }>
): EvidenceFact<K>[] {
  return uniqueFacts(
    values.map(({ text, sourceFactIds }) => ({ id: evidenceFactId(sourceNodeId, kind, text, sourceFactIds), kind, text }))
  );
}

/**
 * A fact id is the handle the final reviewer echoes back, so no two facts may
 * share one. A model that reported the same observation twice said nothing
 * twice: collapse it rather than refusing an edit that was applied. The id
 * hashes the node, kind, text and lineage, so only an identical fact collapses,
 * and a reducer that repeated a summarized fact is already refused by
 * assertReducerLineage before any of this runs.
 */
function uniqueFacts<K extends EvidenceKind>(facts: EvidenceFact<K>[]): EvidenceFact<K>[] {
  return [...new Map(facts.map((fact) => [fact.id, fact])).values()];
}

function evidenceFactId(sourceNodeId: string, kind: EvidenceKind, text: string, sourceFactIds: string[]): string {
  return `fact-${createHash("sha256")
    .update(JSON.stringify({ sourceNodeId, kind, text, sourceFactIds }))
    .digest("hex")
    .slice(0, FACT_ID_HEX_LENGTH)}`;
}

function assertReducerLineage(evidence: ReducerEvidence, nodes: EvidenceNode[]): void {
  for (const kind of POSITIVE_EVIDENCE_KINDS) {
    const expected = nodes.flatMap((node): EvidenceFact[] => node.evidence[kind]).map((fact) => fact.id);
    const actual = evidence[kind].flatMap((fact) => fact.sourceFactIds);
    assertExactCoverage(actual, expected);
  }
}

/**
 * **The overflow slot is the second spelling of "give me less to read", so a
 * leaf gets the same answer to it.** A list past the advertised capacity and
 * `evidenceComplete: false` report one condition — this slice held more facts
 * than one call may carry — and the group is halved and re-asked for both. It
 * was backpressure through one signal and a fail-closed refund through the
 * other, which refused the model for saying so in the way that leaves the
 * evidence itself readable. A reducer has no smaller slice to be given, so
 * there it stays fatal.
 */
function evidenceOverflowed(evidence: LeafEvidence | ReducerEvidence): boolean {
  const negatives = "possibleOmissions" in evidence ? [evidence.possibleOmissions, evidence.contradictions] : [];
  return [evidence.observedChanges, evidence.requirementEvidence, ...negatives].some(
    (list) => list.length > EDIT_ADHERENCE_EVIDENCE_CAPACITY
  );
}

function assertUniqueFactIds(facts: EvidenceFact[]): void {
  const ids = facts.map((fact) => fact.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("The adherence evidence contains duplicate or colliding fact ids.");
  }
}

function assertOrderedSubset(actual: string[], expected: string[]): void {
  if (new Set(actual).size !== actual.length) {
    throw new Error("The adherence verdict repeated a negative evidence fact id.");
  }
  let cursor = 0;
  for (const id of actual) {
    const index = expected.indexOf(id, cursor);
    if (index < 0) {
      throw new Error("The adherence verdict resolved an unknown or reordered negative evidence fact id.");
    }
    cursor = index + 1;
  }
}

function allEvidenceFacts(evidence: NodeEvidence): EvidenceFact[] {
  return [
    ...evidence.observedChanges,
    ...evidence.requirementEvidence,
    ...evidence.possibleOmissions,
    ...evidence.contradictions
  ];
}

function negativeEvidenceFacts(evidence: NodeEvidence): EvidenceFact<NegativeEvidenceKind>[] {
  return [...evidence.possibleOmissions, ...evidence.contradictions];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function assertExactCoverage(actual: string[], expected: string[]): void {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error("The adherence evidence did not accept every input exactly once and in order.");
  }
}

function assertContiguousNodes(nodes: EvidenceNode[]): void {
  for (let index = 1; index < nodes.length; index += 1) {
    if (nodes[index]!.coverageStart !== nodes[index - 1]!.coverageEnd + 1) {
      throw new Error("The adherence evidence coverage is not contiguous.");
    }
  }
}

/** The widest response this call's own schema and payload can force. */
function reviewMaxTokens(worstCaseResponseChars: number): number {
  return Math.max(REVIEW_MIN_OUTPUT_TOKENS, worstCaseResponseChars);
}

/** JSON string elements: their own characters, two quotes and a comma each. */
function jsonStringChars(count: number, maxLength: number): number {
  return count * (maxLength + 3);
}

/** Four evidence lists at the overflow ceiling, the accepted ids, the pages. */
function leafResponseChars(group: ManuscriptSegment[]): number {
  return (
    jsonStringChars(group.length, MAX_INPUT_ID_LENGTH) +
    4 * jsonStringChars(EVIDENCE_OVERFLOW_CEILING, MAX_EVIDENCE_ITEM_LENGTH) +
    MAX_LEAF_PAGE_INDEXES * MAX_PAGE_INDEX_CHARS + REVIEW_RESPONSE_FRAME_CHARS
  );
}

/** Two summary lists, plus the lineage echo of every fact they must name. */
function reducerResponseChars(nodes: EvidenceNode[]): number {
  const lineage = nodes.reduce((sum, { evidence }) => sum + evidence.observedChanges.length + evidence.requirementEvidence.length, 0);
  return (
    jsonStringChars(nodes.length, MAX_INPUT_ID_LENGTH) +
    2 * jsonStringChars(EVIDENCE_OVERFLOW_CEILING, MAX_EVIDENCE_ITEM_LENGTH) +
    lineage * MAX_FACT_ID_CHARS + REVIEW_RESPONSE_FRAME_CHARS
  );
}

/** Every negative id accepted, each omission possibly resolved too, and prose. */
function finalResponseChars(root: EvidenceNode): number {
  const echoed = negativeEvidenceFacts(root.evidence).length + root.evidence.possibleOmissions.length;
  return echoed * MAX_FACT_ID_CHARS + VERDICT_PROSE_CHARS;
}

function assertMessagesFit(messages: ChatMessage[]): void {
  if (!adherenceMessagesFit(messages)) {
    throw new Error("An adherence-review provider request exceeded its deterministic input budget.");
  }
}

function digestSegments(segments: ManuscriptSegment[]): string {
  const hash = createHash("sha256");
  for (const segment of segments) {
    hash.update(JSON.stringify(segment));
  }
  return hash.digest("hex");
}

function digestNodes(nodes: EvidenceNode[]): string {
  const hash = createHash("sha256");
  for (const node of nodes) {
    hash.update(
      `${node.coverageStart}:${node.coverageEnd}:${node.coverageCount}:${node.coverageDigest}:${node.evidenceDigest}\n`
    );
  }
  return hash.digest("hex");
}

function digestEvidence(evidence: NodeEvidence): string {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

function segmentId(side: AdherenceSide, pagePosition: number, pageIndex: number, part: number): string {
  return `${side}-page-${pagePosition}-index-${pageIndex}-part-${part}`;
}
