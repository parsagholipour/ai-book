import {
  inventoryManuscriptRequirements, manuscriptRequirementInventorySchema, manuscriptCoverageSchema,
  matchingRequirementInventory,
  reviewManuscriptCoverage, refreshManuscriptCoverageFacts, manuscriptCoverageIssues,
  type CoverageEvidenceContext, type CoverageChapter, type TextModelAdapter, type ManuscriptRequirementInventory,
  type ManuscriptCoverage, type PictureBookRequirementTarget
} from "@book-maker/core";
import { manuscriptCoverageFingerprint } from "../generation/manuscriptCoverageReview.js";
import { finalizationFingerprint, manuscriptFinalizationFingerprint, type openCompileFinalization } from "./compileFinalization.js";

type FinalizationOperation = Awaited<ReturnType<typeof openCompileFinalization>>;
type Operation = Pick<FinalizationOperation, "exportCheck"> & {
  readonly state: Pick<FinalizationOperation["state"], "key" | "inputFingerprint">;
};
type Page = Parameters<typeof manuscriptFinalizationFingerprint>[0][number];
const unavailableInventory = (brief: string): ManuscriptRequirementInventory => ({ brief, status: "unavailable", complete: false,
  requirements: [], unavailableReason: "Brief inventory was interrupted before its evidence could be saved." });

export function prepareFinalizationCoverageInventory(operation: Operation, brief: string, textModel: TextModelAdapter, prepared?: ManuscriptRequirementInventory) {
  const saved = matchingRequirementInventory(prepared, brief);
  if (saved) return Promise.resolve(saved);
  return operation.exportCheck({ slot: "inventory", fingerprint: finalizationFingerprint({ version: 5, brief }),
    parse: (value) => { const parsed = manuscriptRequirementInventorySchema.safeParse(value); return parsed.success && parsed.data.brief === brief ? parsed.data : undefined; },
    compute: () => inventoryManuscriptRequirements({ brief, textModel }), interrupted: () => unavailableInventory(brief)
  });
}

/** Reuse semantic evidence only inside the same leased operation and exact final manuscript. */
export async function finalizationCoverageForCompile(options: {
  requirementTargets?: readonly PictureBookRequirementTarget[] | undefined;
  inventory?: ManuscriptRequirementInventory | undefined;
  operation: Operation; brief: string; promises: readonly string[]; pages: readonly Page[];
  chapters: readonly CoverageChapter[]; evidenceContext: CoverageEvidenceContext; textModel: TextModelAdapter;
}) {
  const { operation, brief, pages, chapters, textModel } = options;
  const promises = [...new Set(options.promises)].sort();
  // Model review does not assess image likeness. Presence is finalized from actual assets below.
  const semanticContext = { ...options.evidenceContext, illustratedPageIndexes: [], mediaInventory: {} };
  const prepared = matchingRequirementInventory(options.inventory, brief);
  const fingerprint = finalizationFingerprint({ version: 16, inventory: prepared, requirementTargets: options.requirementTargets ?? [], operation: operation.state.key,
    configuration: operation.state.inputFingerprint, manuscript: manuscriptFinalizationFingerprint(pages),
    brief, promises, chapters, evidenceContext: semanticContext });
  const inventory = await prepareFinalizationCoverageInventory(operation, brief, textModel, prepared);
  const review = await operation.exportCheck<ManuscriptCoverage>({ slot: "coverage", fingerprint,
    parse: (value) => { const parsed = manuscriptCoverageSchema.safeParse(value); return parsed.success ? parsed.data : undefined; },
    compute: async () => manuscriptCoverageSchema.parse(await reviewManuscriptCoverage({ brief, promises, pages, chapters, textModel, evidenceContext: semanticContext, inventory, requirementTargets: options.requirementTargets })),
    interrupted: () => ({ status: "unavailable", requirements: [], unavailableReason: "Final manuscript coverage was interrupted before its evidence could be saved." })
  });
  const finalReview = refreshManuscriptCoverageFacts(review, options.evidenceContext, pages, brief);
  return { stored: { fingerprint: manuscriptCoverageFingerprint(brief, promises, pages, chapters, options.evidenceContext, options.requirementTargets, prepared), review: finalReview },
    issues: manuscriptCoverageIssues(finalReview) };
}
