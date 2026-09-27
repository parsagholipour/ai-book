import { createHash } from "node:crypto";
import {
  buildCoverageMediaInventory, coverageStoryPageWordCounts, libraryCharactersFromMediaSettings, manuscriptCoverageIssues, manuscriptCoverageSchema, refreshManuscriptCoverageFacts, reviewManuscriptCoverage,
  type PictureBookRequirementTarget, type BookPlan, type CreateProjectInput, type CoverageEvidenceContext, type CoveragePage, type CoverageChapter, type ManuscriptCoverage, type ManuscriptQualityIssue, type TextModelAdapter
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { isStopRequestedError } from "../runtime/jobTypes.js";

export type StoredManuscriptCoverage = { fingerprint: string; review: ManuscriptCoverage };

export function manuscriptCoverageFingerprint(brief: string, promises: readonly string[], pages: readonly CoveragePage[], chapters?: readonly CoverageChapter[], evidenceContext?: CoverageEvidenceContext, requirementTargets: readonly PictureBookRequirementTarget[] = []): string {
  return createHash("sha256").update(JSON.stringify({ version: 15, brief, promises, requirementTargets, evidenceContext: evidenceContext ?? null, chapters: chapters === undefined ? null : [...chapters]
    .sort((a, b) => a.index - b.index).map(({ index, title, startPageIndex, endPageIndex }) => ({ index, title, startPageIndex, endPageIndex })), pages: [...pages]
    .sort((a, b) => a.index - b.index).map(({ index, markdown }) => ({ index, markdown })) })).digest("hex");
}

/** Recompiles reuse only evidence for exactly the same brief, promises, final page text and current chapter structure. */
export async function manuscriptCoverageForCompile(options: {
  projectId: string; brief: string; promises: readonly string[]; pages: readonly CoveragePage[];
  requirementTargets?: readonly PictureBookRequirementTarget[] | undefined;
  textModel: TextModelAdapter; allowModelReview: boolean; chapters?: readonly CoverageChapter[] | undefined; evidenceContext?: CoverageEvidenceContext | undefined;
}): Promise<{ issues: ManuscriptQualityIssue[]; stored: StoredManuscriptCoverage }> {
  const promises = [...new Set(options.promises)].sort();
  const fingerprint = manuscriptCoverageFingerprint(options.brief, promises, options.pages, options.chapters, options.evidenceContext, options.requirementTargets);
  try {
    const cached = await prisma.generationJob.findFirst({
      where: { projectId: options.projectId, type: "COMPILE_EXPORT", qualityReport: { path: ["briefCoverage", "fingerprint"], equals: fingerprint } },
      orderBy: { createdAt: "desc" }, select: { qualityReport: true }
    });
    const report = cached?.qualityReport;
    const stored = report && typeof report === "object" && !Array.isArray(report) ? report.briefCoverage : null;
    const review = manuscriptCoverageSchema.safeParse(stored && typeof stored === "object" && !Array.isArray(stored) ? stored.review : null);
    if (stored && typeof stored === "object" && !Array.isArray(stored) && stored.fingerprint === fingerprint && review.success && (review.data.status === "reviewed" || (review.data.status === "incomplete" && review.data.requirements.length > 0))) {
      // Reuse the prose assessment, but let current deterministic checks settle
      // recognized delivery wording in older cached judgments too.
      const refreshed = options.evidenceContext ? refreshManuscriptCoverageFacts(review.data, options.evidenceContext) : review.data;
      return { stored: { fingerprint, review: refreshed }, issues: manuscriptCoverageIssues(refreshed) };
    }
  } catch (error) {
    if (isStopRequestedError(error)) throw error;
    // A cache miss never prevents the review or grants an unverified pass.
  }
  const result = options.allowModelReview
    ? await reviewManuscriptCoverage({ brief: options.brief, promises, pages: options.pages, chapters: options.chapters, evidenceContext: options.evidenceContext, requirementTargets: options.requirementTargets, textModel: options.textModel })
    : { status: "unavailable" as const, unavailableReason: "Model coverage review was not enabled for this compile.", requirements: [] };
  const review: ManuscriptCoverage = { status: result.status, requirements: result.requirements,
    ...("assessmentComplete" in result && result.assessmentComplete !== undefined ? { assessmentComplete: result.assessmentComplete } : {}),
    ...(result.unavailableReason ? { unavailableReason: result.unavailableReason } : {}) };
  return { stored: { fingerprint, review }, issues: "issues" in result ? result.issues : manuscriptCoverageIssues(review) };
}

export function buildManuscriptCoverageContext(options: {
  input: CreateProjectInput; plan: BookPlan;
  pages: readonly (CoveragePage & { images?: readonly { type?: string }[] })[];
  images: readonly { id: string; type: string; path: string; metadata: unknown }[];
  expectedIllustratedPageIndexes?: number[];
}): CoverageEvidenceContext {
  const saved = libraryCharactersFromMediaSettings(options.input.mediaSettings);
  return {
    title: options.plan.title,
    targetStoryPages: options.input.targetPages,
    storyPageIndexes: options.pages.map((page) => page.index).sort((a, b) => a - b),
    storyPageWordCounts: coverageStoryPageWordCounts(options.pages),
    illustratedPageIndexes: options.pages.filter((page) => page.images?.some((image) =>
      image.type === "SCENE_ILLUSTRATION" || image.type === "DIAGRAM")).map((page) => page.index).sort((a, b) => a - b),
    expectedIllustratedPageIndexes: options.expectedIllustratedPageIndexes ?? [],
    selectedCharacterNames: saved.map(character => character.name),
    mediaInventory: buildCoverageMediaInventory(options.pages, options.images.filter((image) => image.type === "COVER").length,
      options.images.filter((image) => image.type === "CHARACTER_REFERENCE").length),
    characters: (options.plan.characters ?? []).map((character) => {
      const snapshot = saved.find((candidate) => candidate.name === character.name);
      return { name: character.name, description: snapshot?.description ?? character.description,
        traits: character.traits, visualRules: character.visualRules,
        ...(snapshot?.appearance ? { appearance: snapshot.appearance } : {}),
        ...(snapshot ? { fields: snapshot.fields } : {}),
        ...(snapshot?.portraitFile ? { referenceVersion: snapshot.portraitFile } : {}) };
    }),
    referenceProvenance: options.images.filter((image) => image.type === "CHARACTER_REFERENCE").map((image) => {
      const metadata = image.metadata && typeof image.metadata === "object" && !Array.isArray(image.metadata) ? image.metadata as Record<string, unknown> : {};
      return { id: image.id, path: image.path,
        ...(typeof metadata.characterName === "string" ? { characterName: metadata.characterName } : {}),
        ...(typeof metadata.libraryCharacterId === "string" ? { libraryCharacterId: metadata.libraryCharacterId } : {}) };
    }).sort((a, b) => a.id.localeCompare(b.id))
  };
}
