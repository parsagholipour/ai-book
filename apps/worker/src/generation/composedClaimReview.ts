import {
  chapterCaseEvidence, reviewChapterCaseEvidence, reviewSourceClaims, supportsBookDevelopment, chapterEpisodeSchema,
  type BookPlan, type BookDossier, type ChapterPlan, type CreateProjectInput, type DossierExcerpt,
  type TextModelAdapter, type PrimarySourceSearch, type SourceClaimReview, type ChapterEditAcceptanceOptions
} from "@book-maker/core";
import { config } from "../runtime/config.js";
import type { RunLogger } from "../providers/runLogging.js";
import { repairChapterEvidence, parseEvidenceFinding, type ChapterEvidenceRepair } from "./composedEvidenceRepair.js";
import { mergeSourceDossiers, retrieveChapterSources } from "./sourceDossier.js";
import { sourceClaimDigest, type StoredSourceClaimReview } from "./sourceClaimState.js";
export { sourceClaimDigest, type StoredSourceClaimReview } from "./sourceClaimState.js";
export function sourceClaimReviewApplies(input: CreateProjectInput, plan: BookPlan): boolean {
  return !config.MOCK_AI && supportsBookDevelopment(input, plan);
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
  const review = async (markdown: string) => {
    if (!broad) return reviewChapterCaseEvidence({ markdown, packets, textModel: options.textModel });
    const result = await reviewSourceClaims({ markdown, excerpts, textModel: options.textModel });
    reviews.set(markdown, result);
    await trace("claim_coverage", { chapterIndex: options.chapter.index, ...result, textDigest: sourceClaimDigest(markdown) });
    return result;
  };
  let initial = await review(options.markdown);
  if (broad && options.searchSources) {
    const missing = reviews.get(options.markdown)?.claims.filter((claim) => claim.status === "insufficient_evidence" && claim.searchQuery.trim()).slice(0, 2) ?? [];
    if (missing.length) {
      supplement = await retrieveChapterSources({ ...options, evidence: true, deadline: Date.now() + 120_000,
        episodes: missing.map((claim) => chapterEpisodeSchema.parse({ title: claim.quote, kind: "document", why: claim.quote, searchQueries: [claim.searchQuery] })) });
      if (supplement.excerpts.length) {
        excerpts = mergeSourceDossiers({ documents: [], excerpts }, supplement).excerpts;
        await options.persistSources(supplement);
        initial = await review(options.markdown);
      }
    }
  }
  const repair = await repairChapterEvidence({ markdown: options.markdown,
    review: async (markdown) => markdown === options.markdown ? initial : review(markdown),
    edit: (markdown, notes) => options.edit(markdown, { instructions: notes, evidence: packets,
      ...(broad ? { sourcePassages: excerpts, unsupportedClaims: (reviews.get(markdown)?.issues ?? []).map(parseEvidenceFinding) } : {}) }),
    degenerate: options.degenerate,
    ...(broad ? { notes: (issues: readonly string[], last: boolean) => [
      `Repair only the quoted factual assertions. ${last ? "Remove unsupported specifics outright." : "Correct or narrow to what the supplied passages establish; remove specifics with no evidence."} Missing evidence is not proof of the opposite. Preserve unrelated explanations, worked examples, qualifications and argument. Never invent a replacement fact.`, ...issues
    ] } : {})
  });
  const sourceClaims = reviews.get(repair.markdown);
  await trace("evidence_unresolved", { chapterIndex: options.chapter.index, findings: repair.findings, repairs: repair.repairs, unresolved: repair.unresolved, dropped: repair.dropped });
  return { repair, ...(sourceClaims ? { sourceClaims: { ...sourceClaims, textDigest: sourceClaimDigest(repair.markdown) } } : {}), ...(supplement ? { supplement } : {}) };

  async function trace(event: string, detail: Record<string, unknown>) {
    try { await options.runLog?.append(`generation.composed_chapters.${event}`, { projectId: options.projectId, ...detail }); }
    catch { /* A diagnostic failure cannot change the verdict. */ }
  }
}
