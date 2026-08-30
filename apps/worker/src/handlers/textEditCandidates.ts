import {
  exactReplacementInstructionMatches,
  hasExactMatch,
  reviewAppliedBookEdit,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type EditAdherenceVerdict,
  type ExactReplacement,
  type PageDraft,
  type PageQualityReport,
  type PriorPageContext,
  type ProviderSet
} from "@book-maker/core";
import { EDIT_ADHERENCE_FAILED, ReaderEditFailure } from "@book-maker/core/editFailure";

import type { QualityGateContext } from "../generation/qualityEnrichment.js";
import { locallyPatchedPage, rewritePageForUserRequest } from "../generation/textEditRewrite.js";

export type TextEditSourcePage = {
  id: string;
  index: number;
  title: string;
  markdown: string;
  summary: string;
  imagePrompt: string | null;
  qualityReport: unknown;
  revision: number;
  storyDelta: unknown;
  chapterId: string | null;
  chapter?: { index: number; productionBrief: unknown } | null;
};

export type TextEditCandidate = {
  page: TextEditSourcePage;
  updated: PageDraft & { qualityReport: PageQualityReport };
};

export type TextEditAdherenceAudit = {
  verdict: EditAdherenceVerdict;
  attempts: number;
  missingRequirements: string[];
  checkedAt: string;
  proseApproved: boolean;
};

export type TextEditCandidateResult = {
  candidates: TextEditCandidate[];
  skippedPageIndexes: number[];
  audit: TextEditAdherenceAudit | null;
  satisfied: boolean;
};

/**
 * Builds an operation's candidate manuscript without writing Page rows. The
 * three-attempt budget belongs here, across the whole changed set, so later
 * attempts can act on the adherence verdict rather than blindly regenerating.
 */
export async function draftTextEditCandidates(options: {
  projectId: string;
  pages: TextEditSourcePage[];
  input: CreateProjectInput;
  plan: BookPlan;
  strategy: BookGenerationStrategy;
  providers: ProviderSet;
  editInstruction: string;
  characterContext?: string | undefined;
  perPageInstructions?: Array<{ pageIndex: number; instruction: string }> | undefined;
  exactReplacement?: ExactReplacement | undefined;
  /** Validated router terms stored with the operation; null is a durable mismatch sentinel. */
  operationExactReplacement?: ExactReplacement | null | undefined;
  mode?: "exact" | undefined;
  quality: QualityGateContext;
  generationJobId?: string | undefined;
  onPhase?: ((page: TextEditSourcePage, offset: number, phase: "draft" | "review") => Promise<void>) | undefined;
}): Promise<TextEditCandidateResult> {
  // Queue JSON is not proof that this is a mechanical edit. The durable
  // instruction is the contract, and every delivery re-derives eligibility so
  // a legacy or stale replacement object cannot bypass generation or review.
  const operationCandidateAgrees =
    !Object.prototype.hasOwnProperty.call(options, "operationExactReplacement") ||
    (options.operationExactReplacement !== null &&
      options.operationExactReplacement !== undefined &&
      exactReplacementInstructionMatches(options.editInstruction, options.operationExactReplacement));
  // `mode: "exact"` is the reader's approval of a previewed, verified literal
  // swap, quoted at zero credits, and it is the only thing that may take the
  // model-free, self-approving patch. Without it the payload's replacement
  // rides a *charged* page rewrite, and answering that with a boundary-free
  // split/join gives the reader neither the prose they paid for nor a diff
  // anybody previewed.
  const exactMode = options.mode === "exact";
  const exactPatch =
    exactMode &&
    options.exactReplacement &&
    operationCandidateAgrees &&
    exactReplacementInstructionMatches(options.editInstruction, options.exactReplacement)
      ? options.exactReplacement
      : null;
  if (exactMode && !exactPatch) {
    // The re-derivation refused terms the reader approved at zero credits, and
    // the one answer this delivery may not give is a model rewrite of every
    // named page: that is the per-page regeneration `mode: "exact"` was made a
    // promise to stop. Nor is skipping — the skip card tells the reader the
    // literal is gone, which nothing here has checked. Every row queued before
    // `BookEditOperation.editInstruction` existed re-derives from the raw chat
    // message against a stricter parser than the one that quoted it, so this is
    // reachable rather than theoretical; the edit keeps the book, settles
    // through the ordinary refund path and asks for the change in other words.
    throw new ReaderEditFailure(EDIT_ADHERENCE_FAILED);
  }
  const instructionForPage = new Map(
    (options.perPageInstructions ?? []).map((entry) => [entry.pageIndex, entry.instruction])
  );
  const candidates = new Map<number, TextEditCandidate>();
  const skippedPageIndexes: number[] = [];

  for (const [offset, page] of options.pages.entries()) {
    await options.onPhase?.(page, offset, "draft");
    const patchable = Boolean(
      exactPatch &&
        (hasExactMatch(page.markdown, exactPatch) ||
          hasExactMatch(page.title, exactPatch) ||
          hasExactMatch(page.summary, exactPatch))
    );
    // The literal has gone from this page since the preview priced it. It is
    // skipped and settled as a no-op, never rewritten: `mode: "exact"` is a
    // promise the API makes on the strength of that preview, and the rewrite
    // is what silently turned a patch-priced edit into a per-page regeneration.
    if (exactMode && !patchable) {
      skippedPageIndexes.push(page.index);
      continue;
    }
    const pageEditGuidance = instructionForPage.get(page.index);
    const updated = exactPatch && patchable
      ? locallyPatchedPage(page, exactPatch)
      : await rewritePageForUserRequest({
          projectId: options.projectId,
          page,
          input: options.input,
          plan: options.plan,
          strategy: options.strategy,
          providers: options.providers,
          request: pageEditGuidance ?? options.editInstruction,
          editInstruction: options.editInstruction,
          ...(options.characterContext ? { characterContext: options.characterContext } : {}),
          ...(pageEditGuidance ? { pageEditGuidance } : {}),
          priorPageOverrides: priorDrafts(candidates),
          maxCandidates: 1,
          quality: options.quality,
          generationJobId: options.generationJobId,
          onPhase: async (phase) => {
            await options.onPhase?.(page, offset, phase);
          }
        });
    candidates.set(page.index, { page, updated });
  }

  if (candidates.size === 0) {
    return { candidates: [], skippedPageIndexes, audit: null, satisfied: true };
  }

  let verdict = await reviewCandidates(options, candidates, exactPatch);
  let attempts = 1;
  let proseApproved = everyCandidateApproved(candidates);

  while ((!verdict.satisfied || !proseApproved) && attempts < 3) {
    attempts += 1;
    // A review that never ran has no page-level finding and no repair order.
    // Re-ask it below, but let only page QA trigger a rewrite in this round.
    const unverified = verdict.basis === "unverified";
    const requested = new Set(unverified ? [] : verdict.pageIndexesToRevise);
    for (const candidate of candidates.values()) {
      if (!candidate.updated.qualityReport.approved) requested.add(candidate.page.index);
    }
    const repairIndexes = requested.size > 0
      ? requested
      : unverified
        ? new Set<number>()
        : new Set(candidates.keys());
    const adherenceRequirements = unverified
      ? []
      : [...verdict.missingRequirements, ...verdict.contradictions];

    for (const [offset, page] of options.pages.entries()) {
      const current = candidates.get(page.index);
      if (!current || !repairIndexes.has(page.index)) continue;
      await options.onPhase?.(page, offset, "draft");
      const pageEditGuidance = instructionForPage.get(page.index);
      const repairRequirements = uniqueRequirements([
        ...adherenceRequirements,
        ...(current.updated.qualityReport.requiredRevisions ?? []),
        ...(current.updated.qualityReport.issues ?? [])
      ]);
      const updated = await rewritePageForUserRequest({
        projectId: options.projectId,
        page: {
          ...page,
          title: current.updated.title,
          markdown: current.updated.markdown,
          summary: current.updated.summary,
          imagePrompt: current.updated.imagePrompt ?? page.imagePrompt
        },
        input: options.input,
        plan: options.plan,
        strategy: options.strategy,
        providers: options.providers,
        request: pageEditGuidance ?? options.editInstruction,
        editInstruction: options.editInstruction,
        ...(options.characterContext ? { characterContext: options.characterContext } : {}),
        ...(pageEditGuidance ? { pageEditGuidance } : {}),
        priorPageOverrides: priorDrafts(candidates),
        adherenceRepair: repairRequirements,
        maxCandidates: 1,
        quality: options.quality,
        generationJobId: options.generationJobId,
        onPhase: async (phase) => {
          await options.onPhase?.(page, offset, phase);
        }
      });
      candidates.set(page.index, { page, updated });
    }
    verdict = await reviewCandidates(options, candidates, exactPatch);
    proseApproved = everyCandidateApproved(candidates);
  }

  const audit: TextEditAdherenceAudit = {
    verdict,
    attempts,
    missingRequirements: verdict.missingRequirements,
    checkedAt: new Date().toISOString(),
    proseApproved
  };
  return {
    candidates: [...candidates.values()].sort((left, right) => left.page.index - right.page.index),
    skippedPageIndexes,
    audit,
    // Adherence only. `proseApproved` buys the repair rounds above and is kept
    // in the audit, but a page that still fails review after them is a
    // FAILED_QA page, not a failed edit: the publication saves it flagged for
    // the next full compile's repair pass. Folding it in here discarded — and
    // refunded — a whole hundred-page rewrite over one stubborn page, and told
    // the reader their change could not be applied as requested when it had.
    satisfied: verdict.satisfied
  };
}

export type StoredExactReplacementCandidate = {
  present: boolean;
  replacement: ExactReplacement | null;
};

/**
 * Reads the router's corroborating terms from the durable classifier. Invalid
 * or explicit-null data is still present: it must disable, not disappear into,
 * the legacy instruction-only fallback.
 */
export function storedExactReplacementCandidate(classifier: unknown): StoredExactReplacementCandidate {
  if (!classifier || typeof classifier !== "object" || Array.isArray(classifier)) {
    return { present: false, replacement: null };
  }
  const record = classifier as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "exactReplacement")) {
    return { present: false, replacement: null };
  }
  const raw = record.exactReplacement;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { present: true, replacement: null };
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.from !== "string" || typeof candidate.to !== "string") {
    return { present: true, replacement: null };
  }
  const from = candidate.from.trim();
  const to = candidate.to.trim();
  if (!from || !to || (candidate.preserveCase !== undefined && typeof candidate.preserveCase !== "boolean")) {
    return { present: true, replacement: null };
  }
  return {
    present: true,
    replacement: {
      from,
      to,
      ...(typeof candidate.preserveCase === "boolean" ? { preserveCase: candidate.preserveCase } : {})
    }
  };
}

async function reviewCandidates(
  options: Parameters<typeof draftTextEditCandidates>[0],
  candidates: Map<number, TextEditCandidate>,
  exactPatch: ExactReplacement | null
): Promise<EditAdherenceVerdict> {
  const changed = [...candidates.values()].sort((left, right) => left.page.index - right.page.index);
  return reviewAppliedBookEdit({
    instruction: options.editInstruction,
    beforePages: changed.map(({ page }) => ({
      index: page.index,
      title: page.title,
      markdown: page.markdown,
      summary: page.summary
    })),
    afterPages: changed.map(({ page, updated }) => ({
      index: page.index,
      title: updated.title,
      markdown: updated.markdown,
      summary: updated.summary
    })),
    textModel: options.providers.text,
    ...(exactPatch ? { exactReplacement: exactPatch } : {})
  });
}

function priorDrafts(candidates: Map<number, TextEditCandidate>): PriorPageContext[] {
  return [...candidates.values()].map(({ page, updated }) => ({
    index: page.index,
    title: updated.title,
    markdown: updated.markdown,
    summary: updated.summary
  }));
}

function everyCandidateApproved(candidates: Map<number, TextEditCandidate>): boolean {
  return [...candidates.values()].every((candidate) => candidate.updated.qualityReport.approved);
}

function uniqueRequirements(requirements: string[]): string[] {
  return [...new Set(requirements.map((requirement) => requirement.trim()).filter(Boolean))];
}
