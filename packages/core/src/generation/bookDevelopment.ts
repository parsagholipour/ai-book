import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { authorStanceSchema, type AuthorStance, type BookPlan, type CreateProjectInput } from "../schemas/book.js";
import { bookDevelopmentSchema, type BookDevelopment } from "../schemas/bookDevelopment.js";
import type { CaseEvidencePacket, BookDossier } from "../schemas/episodes.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { targetLanguageGenerationGuidance } from "../prompting/language.js";
import { repairArcPages } from "./bookArc.js";
import { isNarrativeWritingMode, planAuthorStance } from "./authorStance.js";
import { inferWritingMode } from "./styleContract.js";

export { bookDevelopmentSchema, type BookDevelopment } from "../schemas/bookDevelopment.js";

export function supportsBookDevelopment(input: CreateProjectInput, plan: BookPlan): boolean {
  return input.category !== "KIDS" && !isNarrativeWritingMode(inferWritingMode(input, plan));
}

export function developmentCoverage(plan: BookPlan): BookDevelopment["coverage"] {
  return [
    ...plan.chapters.flatMap((chapter) => [
      { id: `chapter-${chapter.index}`, requirement: `${chapter.title}: ${chapter.summary}` },
      ...chapter.keyBeats.map((beat, index) => ({ id: `chapter-${chapter.index}-beat-${index + 1}`, requirement: beat }))
    ]),
    ...plan.promises.map((promise, index) => ({ id: `promise-${index + 1}`, requirement: promise }))
  ];
}

/** Structural acceptance is exact; semantic equivalence of contributions is checked separately. */
export function bookDevelopmentIssues(development: BookDevelopment, packets: readonly CaseEvidencePacket[], targetPages: number): string[] {
  const issues: string[] = [];
  if (!packets.length) issues.push("no reviewed case evidence is available");
  if (new Set(packets.map((packet) => packet.id)).size !== packets.length) issues.push("duplicate case IDs");
  const chapterIds = new Set<number>();
  const requirements = new Set(development.coverage.map((entry) => entry.id));
  const covered = new Set<string>();
  const caseIds = new Set(packets.map((packet) => packet.id));
  const owners = new Map<string, number>();
  const contributions = new Set<string>();
  for (const [offset, chapter] of development.chapters.entries()) {
    if (chapter.index !== offset + 1) issues.push("chapter indexes must be consecutive in reading order");
    if (chapter.requires.some((index) => !chapterIds.has(index))) issues.push(`chapter ${chapter.index} has a missing or forward prerequisite`);
    chapterIds.add(chapter.index);
    // A synthesis chapter reasons from its prerequisites' cases and owns none; one with nothing to reason from is the defect.
    if (packets.length && chapter.caseIds.length + chapter.callbacks.length === 0 && chapter.requires.length === 0) {
      issues.push(`chapter ${chapter.index} has no evidence assigned and no prerequisite chapter to reason from: add a callback to an earlier case with a new inference, name the chapters whose cases it synthesizes in requires, or merge it into a chapter with evidence`);
    }
    const contribution = chapter.contribution.toLowerCase().replace(/\s+/g, " ").trim();
    if (contributions.has(contribution)) issues.push(`chapter ${chapter.index} repeats another chapter's contribution`);
    contributions.add(contribution);
    for (const id of chapter.covers) {
      if (!requirements.has(id)) issues.push(`unknown coverage requirement ${id}`);
      covered.add(id);
    }
    for (const id of chapter.caseIds) {
      if (!caseIds.has(id)) issues.push(`unknown case ${id}`);
      if (owners.has(id)) issues.push(`case ${id} has more than one full treatment`);
      owners.set(id, chapter.index);
    }
    for (const callback of chapter.callbacks) {
      const owner = owners.get(callback.caseId);
      if (owner === undefined || owner >= chapter.index) issues.push(`callback ${callback.caseId} has no earlier owner`);
    }
  }
  for (const id of requirements) if (!covered.has(id)) issues.push(`missing requested coverage ${id}`);
  if (development.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0) !== targetPages) issues.push("chapter pages do not sum to the requested book length");
  return [...new Set(issues)];
}

const proposalSchema = bookDevelopmentSchema.omit({ version: true, coverage: true }).extend({ authorStance: authorStanceSchema });
const reviewSchema = z.object({ approved: z.boolean(), issues: z.array(z.string().min(1)).max(12) });

export async function developBookPlan(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  dossier: BookDossier;
  textModel: TextModelAdapter;
}): Promise<BookPlan> {
  const coverage = developmentCoverage(options.plan);
  const packets = options.dossier.evidencePackets ?? [];
  if (!packets.length) throw new Error("Book development needs research: no reviewed case evidence is available.");
  let feedback: string[] = [];
  let candidate: { development: BookDevelopment; authorStance: AuthorStance; issues: string[] } | undefined;
  for (let attempt = 0; attempt < DEVELOPMENT_ATTEMPTS; attempt += 1) {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: "develop-book-plan", temperature: Math.min(0.6, options.input.temperature), maxTokens: 16_000, schema: proposalSchema,
      messages: [
        { role: "system", content: [
          "Design this nonfiction book from its evidence and the reader's request. You may change chapter count, titles, order, scope and length, merge redundant chapters, or split an overloaded chapter. Preserve every coverage requirement and explicit user constraint, including an explicitly requested structure; the old outline itself is a coverage inventory, not a required architecture.",
          "Build progression in understanding. Each contribution states what the reader can understand after this chapter that earlier chapters could not establish. Different cases proving the same proposition are the same work: combine them or make their difference consequential. A case may complicate or overturn the provisional answer. Do not force a debate, scene, open question or rhetorical turn into every chapter. Update the provisional authorStance to follow the evidence: your answer becomes its thesis, so positions must remain compatible with the answer. Keep at least two concrete positions and a voiceSample of at least eighty words; retain the supplied sample when it already fits. Preserve the requested voice and constraints; do not retain a contradicted thesis just because it appeared in the first plan. Where the supported material cannot carry a requirement in full, keep the requirement, scope the chapter's beats to what its cases establish, and say in the summary what the evidence does not allow; never promise a comparison or survey the cases cannot carry.",
          "Use reviewed cases as the substantive material. caseIds gives full-treatment ownership, once per case across the book. callbacks permits a later return only with a specific newInference; it cannot retell the case. requires contains earlier chapter indexes needed to understand this chapter. covers contains IDs from the supplied coverage inventory; assigning an ID is a promise the chapter's beats actually fulfill. researchGaps describe missing cases in the OLD outline: combine or reorganize that coverage using supported material where it actually fits. A conceptual or synthesis chapter can reason from earlier cases without a new episode when it names those chapters in requires. Preserve requested coverage; a gap is never permission to invent facts or discuss an unsupported historical case.",
          `Return question, answer, authorStance (thesis, positions, refusals, voiceSample) and chapters (index, title, summary, targetPages, keyBeats, contribution, requires, covers, caseIds, callbacks). Indexes start at 1 in reading order. Choose chapter lengths appropriate to their work and make their sum ${options.input.targetPages}. Return JSON only.`,
          ...targetLanguageGenerationGuidance(options.input.language)
        ].join(" ") },
        { role: "user", content: JSON.stringify({
          request: options.input.prompt, audience: options.plan.audience, title: options.plan.title,
          coverage, originalChapters: options.plan.chapters, provisionalStance: options.plan.authorStance,
          evidence: packets.map(({ excerpts: _excerpts, ...packet }) => packet),
          researchGaps: options.dossier.researchGaps ?? [],
          researchNotes: packets.length ? undefined : options.plan.researchNotes,
          outputContract: { question: "", answer: "", authorStance: { thesis: "", positions: ["", ""], refusals: [], voiceSample: "" }, chapters: [{ index: 1, title: "", summary: "", targetPages: options.input.targetPages, keyBeats: [""], contribution: "", requires: [], covers: [coverage[0]!.id], caseIds: [packets[0]!.id], callbacks: [] }] },
          outputInstructions: "Return a filled data object with these exact keys, never a JSON Schema. Example values are placeholders, not content or a suggested chapter count.",
          feedback
        }) }
      ]
    });
    const { authorStance: proposed, ...proposal } = result.data;
    let development: BookDevelopment = { ...proposal, version: 1, coverage };
    const sum = development.chapters.reduce((total, chapter) => total + chapter.targetPages, 0);
    if (sum !== options.input.targetPages) {
      const pages = repairArcPages(development.chapters.map((chapter) => chapter.targetPages), options.input.targetPages);
      if (pages) development = { ...development, chapters: development.chapters.map((chapter, index) => ({ ...chapter, targetPages: pages[index]! })) };
    }
    // The thesis is the answer by construction: asked to copy a paragraph verbatim, the writer paraphrases it.
    const authorStance: AuthorStance = { ...proposed, thesis: development.answer };
    feedback = bookDevelopmentIssues(development, packets, options.input.targetPages);
    if (!planAuthorStance({ ...options.plan, authorStance })) feedback.push("the revised stance needs at least two positions and an eighty-word voice sample");
    if (feedback.length) continue;
    const review = await generateJsonWithRetry(options.textModel, {
      purpose: "review-book-development", temperature: 0.1, maxTokens: 5000, schema: reviewSchema,
      messages: [
        { role: "system", content: "Audit this proposal against the user's request, coverage inventory and evidence. Return JSON {approved,issues}. Check actual beats, not merely coverage labels. Check that the revised author stance follows the evidence and that its positions do not contradict the developed answer. Reject lost requested coverage, invented support, and chapters whose contributions restate the same inference using new people or periods. A requirement scoped to the supported material, with its gap stated, is preserved coverage: reject coverage that is dropped or promised as developed without support, not coverage that is honestly narrowed. The voiceSample is a stylistic sample about a subject outside the book and is never evidence. Cases with different IDs can still describe the same event: reject duplicate full treatments under aliases. Check that later chapters change understanding and callbacks add their claimed new inference. Do not require a particular chapter count, order, shape or dramatic arc. Prefer a small number of concrete consequential issues. approved is true only if issues is empty." },
        { role: "user", content: JSON.stringify({ request: options.input.prompt, development, authorStance, evidence: packets.map(({ excerpts: _excerpts, ...packet }) => packet), researchGaps: options.dossier.researchGaps ?? [], outputContract: { approved: false, issues: ["A concrete defect, or [] when approved"] }, outputInstructions: "Adjudicate independently and return the filled result object, not a JSON Schema." }) }
      ]
    });
    feedback = review.data.issues;
    if (review.data.approved && feedback.length === 0) return applyBookDevelopment(options.plan, development, options.dossier, authorStance);
    if (feedback.length === 0) feedback = ["the content plan did not pass its coverage and progression review"];
    candidate = { development, authorStance, issues: feedback };
  }
  // The deterministic contract is the gate. The model review is editorial judgement about how much the
  // verified material can carry; after the bounded attempts it is recorded for the developmental edit,
  // never the reason a book with a complete evidence stage produces no pages.
  if (candidate) return applyBookDevelopment(options.plan, { ...candidate.development, reviewNotes: candidate.issues }, options.dossier, candidate.authorStance);
  throw new Error(`Book development needs a new plan: ${feedback.join("; ")}`);
}

const DEVELOPMENT_ATTEMPTS = 3;

export function applyBookDevelopment(plan: BookPlan, development: BookDevelopment, dossier: BookDossier, stance: AuthorStance | undefined = plan.authorStance): BookPlan {
  const packets = dossier.evidencePackets ?? [];
  const byId = new Map(packets.map((packet) => [packet.id, packet]));
  const excerpts = development.chapters.flatMap((chapter) =>
    [...new Set([...chapter.caseIds, ...chapter.callbacks.map((callback) => callback.caseId)])].flatMap((id) =>
      (byId.get(id)?.excerpts ?? []).map((excerpt) => ({ ...excerpt, chapterIndex: chapter.index }))
    )
  );
  const { bookArc: _arc, episodes: _episodes, dossier: _dossier, ...base } = plan;
  return {
    ...base, bookDevelopment: development, ...(stance ? { authorStance: stance } : {}),
    chapters: development.chapters.map(({ index, title, summary, targetPages, keyBeats }) => ({ index, title, summary, targetPages, keyBeats })),
    episodes: { chapters: development.chapters.map((chapter) => ({ index: chapter.index, episodes: chapter.caseIds.flatMap((id) => byId.get(id)?.episode ?? []) })) },
    dossier: { ...dossier, excerpts, documents: excerpts.map((excerpt) => ({ title: excerpt.documentTitle, url: excerpt.documentUrl, host: excerpt.host, chapterIndex: excerpt.chapterIndex, words: excerpt.words })) }
  };
}

type DevelopedChapter = BookDevelopment["chapters"][number];

/** A synthesis chapter owns no case and names the chapters whose cases it reasons from. */
function inheritsEvidence(chapter: DevelopedChapter): boolean {
  return chapter.caseIds.length + chapter.callbacks.length === 0 && chapter.requires.length > 0;
}

/** The packets a chapter is written and reviewed against: its own cases, or its prerequisites' when it owns none. */
export function chapterCaseEvidence(plan: BookPlan, chapterIndex: number): CaseEvidencePacket[] {
  const packets = plan.dossier?.evidencePackets ?? [];
  const chapters = plan.bookDevelopment?.chapters ?? [];
  const chapter = chapters.find((entry) => entry.index === chapterIndex);
  if (!chapter) return packets.filter((packet) => packet.sourceChapterIndex === chapterIndex);
  const owners = inheritsEvidence(chapter) ? chapters.filter((entry) => chapter.requires.includes(entry.index)) : [chapter];
  const ids = new Set(owners.flatMap((owner) => [...owner.caseIds, ...owner.callbacks.map((callback) => callback.caseId)]));
  return packets.filter((packet) => ids.has(packet.id));
}

export function chapterDevelopmentLines(plan: BookPlan, chapterIndex: number): string[] {
  const chapter = plan.bookDevelopment?.chapters.find((entry) => entry.index === chapterIndex);
  if (!chapter) return [];
  return [
    `This chapter's new contribution: ${chapter.contribution}. Its prerequisite chapters are ${chapter.requires.join(", ") || "none"}. Develop that contribution through the material; do not re-prove the book's general premise. These are editorial assignments, not prose to print or a required paragraph pattern.`,
    ...(chapter.callbacks.length ? [`Earlier cases may return only for these new inferences, without re-narrating their events: ${chapter.callbacks.map((callback) => `${callback.caseId}: ${callback.newInference}`).join("; ")}.`] : []),
    ...(inheritsEvidence(chapter) ? ["This chapter owns no verified case: the caseEvidence supplied belongs to its prerequisite chapters. Reason from those cases without re-narrating their events, and introduce no new named historical case, document or figure as evidence."] : [])
  ];
}
