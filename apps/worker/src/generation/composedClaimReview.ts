import {
  chapterCaseEvidence, reviewChapterCaseEvidence, createSourceClaimReviewer, supportsBookDevelopment,
  type BookPlan, type BookDossier, type ChapterPlan, type CreateProjectInput, type DossierExcerpt,
  type TextModelAdapter, type PrimarySourceSearch, type SourceClaimReview, type ChapterEditAcceptanceOptions
} from "@book-maker/core";
import { config } from "../runtime/config.js";
import type { RunLogger } from "../providers/runLogging.js";
import { repairChapterEvidence, parseEvidenceFinding, type ChapterEvidenceRepair } from "./composedEvidenceRepair.js";
import { recoverSourceClaimEvidence } from "./sourceClaimRetrieval.js";
import { SOURCE_CLAIM_REVIEW, sourceClaimDigest, type StoredSourceClaimReview } from "./sourceClaimState.js";
export { SOURCE_CLAIM_REVIEW, sourceClaimDigest, type StoredSourceClaimReview } from "./sourceClaimState.js";

export function sourceClaimReviewApplies(input: CreateProjectInput, plan: BookPlan): boolean {
  return SOURCE_CLAIM_REVIEW && !config.MOCK_AI && supportsBookDevelopment(input, plan);
}
export function chapterSourcePassages(plan: BookPlan, chapterIndex: number): DossierExcerpt[] {
  const excerpts = [...plan.dossier?.excerpts.filter((excerpt) => excerpt.chapterIndex === chapterIndex) ?? [],
    ...chapterCaseEvidence(plan, chapterIndex).flatMap((packet) => packet.excerpts)];
  return [...new Map(excerpts.map((excerpt) => [excerpt.id, excerpt])).values()];
}

/** Factual claims use exact passages in every nonfiction tier; historical case packets remain supported. */
export async function repairComposedClaims(options: {
  projectId: string; input: CreateProjectInput; plan: BookPlan; chapter: ChapterPlan; markdown: string;
  textModel: TextModelAdapter; searchSources?: PrimarySourceSearch | undefined;
  runLog?: Pick<RunLogger, "append"> | undefined;
  edit: (markdown: string, correction: NonNullable<ChapterEditAcceptanceOptions["factualCorrection"]>) => Promise<string>;
  degenerate: (markdown: string) => boolean;
  persistSources: (supplement: BookDossier) => Promise<void>;
}): Promise<{ repair?: ChapterEvidenceRepair; sourceClaims?: StoredSourceClaimReview; supplement?: BookDossier }> {
  const packets = chapterCaseEvidence(options.plan, options.chapter.index);
  const broad = sourceClaimReviewApplies(options.input, options.plan);
  if (!broad && !packets.length) return {};
  let excerpts = chapterSourcePassages(options.plan, options.chapter.index);
  let supplement: BookDossier | undefined;
  const reviews = new Map<string, SourceClaimReview>();
  const reviewClaims = createSourceClaimReviewer(options.textModel, trace);
  let searchedClaims = new Set<string>();
  const review = async (markdown: string) => {
    if (!broad) return reviewChapterCaseEvidence({ markdown, packets, textModel: options.textModel });
    const result = await reviewClaims({ markdown, excerpts });
    reviews.set(markdown, result);
    await trace("claim_coverage", { chapterIndex: options.chapter.index, ...result, textDigest: sourceClaimDigest(markdown) });
    return result;
  };
  let initial = await review(options.markdown);
  if (broad && options.searchSources) {
    const recovered = await recoverSourceClaimEvidence({ ...options, initial: reviews.get(options.markdown)!, excerpts,
      review: async (passages) => {
        excerpts = passages;
        return reviewClaims({ markdown: options.markdown, excerpts });
      }, trace
    });
    excerpts = recovered.excerpts;
    supplement = recovered.supplement;
    searchedClaims = recovered.searchedClaims;
    initial = recovered.review;
    reviews.set(options.markdown, recovered.review);
    await trace("claim_coverage", { chapterIndex: options.chapter.index, ...recovered.review, textDigest: sourceClaimDigest(options.markdown) });
  }
  const actionableClaims = (markdown: string) => {
    const current = reviews.get(markdown);
    return current?.coverage.status === "reviewed" ? current.claims.filter((claim) =>
      claim.status === "contradicted" || (claim.status === "insufficient_evidence" && searchedClaims.has(claim.quote))) : [];
  };
  const repair = await repairChapterEvidence({ markdown: options.markdown,
    review: async (markdown) => markdown === options.markdown ? initial : review(markdown),
    edit: (markdown, notes) => {
      const actionable = actionableClaims(markdown);
      const issues = actionable.map((claim) => `“${claim.quote}”: ${claim.reason}`);
      return options.edit(markdown, { instructions: broad ? [notes[0]!, ...issues] : notes, evidence: packets,
        ...(broad ? { sourcePassages: excerpts, unsupportedClaims: issues.map(parseEvidenceFinding) } : {}) });
    },
    degenerate: options.degenerate,
    ...(broad ? { canRepair: (markdown: string) => actionableClaims(markdown).length > 0 } : {}),
    ...(broad ? { notes: (issues: readonly string[], last: boolean) => [
      `Repair only the quoted factual assertions. ${last ? "Remove unsupported specifics outright." : "Correct or narrow to what the supplied passages establish; remove specifics with no evidence."} Missing evidence is not proof of the opposite. Preserve unrelated explanations, worked examples, qualifications and argument. Never invent a replacement fact.`, ...issues
    ] } : {})
  });
  const sourceClaims = reviews.get(repair.markdown);
  await trace("evidence_unresolved", { chapterIndex: options.chapter.index, findings: repair.findings, repairs: repair.repairs, unresolved: repair.unresolved, dropped: repair.dropped });
  return { repair, ...(sourceClaims ? { sourceClaims: { ...sourceClaims, textDigest: sourceClaimDigest(repair.markdown) } } : {}), ...(supplement ? { supplement } : {}) };

  async function trace(event: string, detail: Record<string, unknown>) {
    try { await options.runLog?.append(`generation.composed_chapters.${event}`, { projectId: options.projectId, chapterIndex: options.chapter.index, ...detail }); }
    catch { /* A diagnostic failure cannot change the verdict. */ }
  }
}
