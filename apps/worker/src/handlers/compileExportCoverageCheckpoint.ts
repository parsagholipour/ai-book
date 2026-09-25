import {
  inventoryManuscriptRequirements, manuscriptRequirementInventorySchema, manuscriptCoverageSchema,
  reviewManuscriptCoverage, refreshManuscriptCoverageFacts, manuscriptCoverageIssues,
  type CoverageEvidenceContext, type CoverageChapter, type TextModelAdapter, type ManuscriptRequirementInventory,
  type ManuscriptCoverage
} from "@book-maker/core";
import { manuscriptCoverageFingerprint } from "../generation/manuscriptCoverageReview.js";
import { finalizationFingerprint, manuscriptFinalizationFingerprint, type openCompileFinalization } from "./compileFinalization.js";

type Operation = Awaited<ReturnType<typeof openCompileFinalization>>;
type Page = Parameters<typeof manuscriptFinalizationFingerprint>[0][number];
const unavailableInventory = (brief: string): ManuscriptRequirementInventory => ({ brief, status: "unavailable", complete: false,
  requirements: [], unavailableReason: "Brief inventory was interrupted before its evidence could be saved." });

export function prepareFinalizationCoverageInventory(operation: Operation, brief: string, textModel: TextModelAdapter) {
  return operation.exportCheck({ slot: "inventory", fingerprint: finalizationFingerprint({ version: 2, brief }),
    parse: (value) => { const parsed = manuscriptRequirementInventorySchema.safeParse(value); return parsed.success && parsed.data.brief === brief ? parsed.data : undefined; },
    compute: () => inventoryManuscriptRequirements({ brief, textModel }), interrupted: () => unavailableInventory(brief)
  });
}

/** Reuse semantic evidence only inside the same leased operation and exact final manuscript. */
export async function finalizationCoverageForCompile(options: {
  operation: Operation; brief: string; promises: readonly string[]; pages: readonly Page[];
  chapters: readonly CoverageChapter[]; evidenceContext: CoverageEvidenceContext; textModel: TextModelAdapter;
}) {
  const { operation, brief, pages, chapters, textModel } = options;
  const promises = [...new Set(options.promises)].sort();
  // Model review does not assess image likeness. Presence is finalized from actual assets below.
  const semanticContext = { ...options.evidenceContext, illustratedPageIndexes: [], mediaInventory: {} };
  const fingerprint = finalizationFingerprint({ version: 3, operation: operation.state.key,
    configuration: operation.state.inputFingerprint, manuscript: manuscriptFinalizationFingerprint(pages),
    brief, promises, chapters, evidenceContext: semanticContext });
  const inventory = await prepareFinalizationCoverageInventory(operation, brief, textModel);
  const review = await operation.exportCheck<ManuscriptCoverage>({ slot: "coverage", fingerprint,
    parse: (value) => { const parsed = manuscriptCoverageSchema.safeParse(value); return parsed.success ? parsed.data : undefined; },
    compute: async () => manuscriptCoverageSchema.parse(await reviewManuscriptCoverage({ brief, promises, pages, chapters, textModel, evidenceContext: semanticContext, inventory })),
    interrupted: () => ({ status: "unavailable", requirements: [], unavailableReason: "Final manuscript coverage was interrupted before its evidence could be saved." })
  });
  const finalReview = refreshManuscriptCoverageFacts(review, options.evidenceContext);
  return { stored: { fingerprint: manuscriptCoverageFingerprint(brief, promises, pages, chapters, options.evidenceContext), review: finalReview },
    issues: manuscriptCoverageIssues(finalReview) };
}
