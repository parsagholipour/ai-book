import {
  applyPagePatches,
  composedPageQualityReport,
  generateJsonWithRetry,
  PAGE_PATCH_PURPOSE,
  pagePatchDecision,
  pagePatchMaxTokens,
  pagePatchMessages,
  pagePatchResponseSchema,
  pageQualityReportSchema,
  reviewPageDraftLocally,
  type BookPlan,
  type CreateProjectInput,
  type PageDraft,
  type PagePatchFailure,
  type PageQualityReport,
  type ProviderSet
} from "@book-maker/core";

import { pageFigureRewrite } from "./composedFigures.js";

/**
 * The surgical tier of a reader-requested page edit: exact replacements the
 * model names and code applies, on the page as it is stored.
 *
 * Runs before `rewritePageForUserRequest` for every model-backed text edit and
 * hands over to it only when the model itself says the request needs a whole
 * page, or when two replies in a row named spans that are not on the page.
 * A patched page keeps the quality report it already had: nothing outside
 * the replaced spans changed, so the reviewer's standing verdict on the rest
 * still holds and the page QA loop — the thing that rewrote whole pages on
 * complaints about prose the edit never touched — never sees it. The two
 * integrity checks that can fail any page (a placeholder, a prompt leak) still
 * run on the result, and a page they refuse falls through to the full path.
 */

const PATCH_ASK_ATTEMPTS = 2;

export type TextEditPatchOutcome =
  | { kind: "patched"; draft: PageDraft & { qualityReport: PageQualityReport }; applied: number }
  | { kind: "unchanged"; reason: string }
  | { kind: "whole_page"; reason: string };

export async function patchPageForUserRequest(options: {
  page: {
    index: number;
    title: string;
    markdown: string;
    summary: string;
    imagePrompt: string | null;
    qualityReport: unknown;
  };
  input: CreateProjectInput;
  plan: BookPlan;
  providers: Pick<ProviderSet, "text">;
  editInstruction: string;
  pageEditGuidance?: string | undefined;
  characterContext?: string | undefined;
  adherenceRepair?: readonly string[] | undefined;
}): Promise<TextEditPatchOutcome> {
  // The model reads a stored figure as its stand-in and never a figure's JSON,
  // exactly as the whole-page path does; `restore` puts the block back beside
  // the paragraph it followed once the patches are in.
  const rewrite = pageFigureRewrite(options.page.markdown, options.editInstruction);
  let patchRepair: PagePatchFailure[] = [];
  for (let attempt = 1; attempt <= PATCH_ASK_ATTEMPTS; attempt += 1) {
    const result = await generateJsonWithRetry(options.providers.text, {
      purpose: PAGE_PATCH_PURPOSE,
      temperature: 0.2,
      maxTokens: pagePatchMaxTokens(rewrite.prose),
      repairAttempts: 1,
      schema: pagePatchResponseSchema,
      messages: pagePatchMessages({
        input: options.input,
        plan: options.plan,
        editInstruction: options.editInstruction,
        ...(options.pageEditGuidance ? { pageEditGuidance: options.pageEditGuidance } : {}),
        ...(options.characterContext ? { characterContext: options.characterContext } : {}),
        ...(options.adherenceRepair?.length ? { adherenceRepair: options.adherenceRepair } : {}),
        ...(patchRepair.length > 0 ? { patchRepair } : {}),
        page: {
          index: options.page.index,
          title: options.page.title,
          summary: options.page.summary,
          markdown: rewrite.prose
        }
      })
    });
    const decision = pagePatchDecision(result.data);
    if (decision.kind !== "patched") {
      return { kind: decision.kind, reason: decision.reason };
    }
    const application = applyPagePatches(rewrite.prose, decision.patches);
    if (application.failures.length > 0) {
      patchRepair = application.failures;
      continue;
    }
    const restored = rewrite.restore({ markdown: application.markdown });
    const draft: PageDraft = {
      title: options.page.title,
      markdown: restored.markdown,
      summary: decision.summary ?? options.page.summary,
      continuityNotes: [],
      ...(options.page.imagePrompt ? { imagePrompt: options.page.imagePrompt } : {})
    };
    const integrity = composedPageQualityReport(
      reviewPageDraftLocally({
        input: options.input,
        plan: options.plan,
        pageIndex: options.page.index,
        draft,
        previousPages: [],
        continuityNotes: []
      })
    );
    if (!integrity.approved) {
      return {
        kind: "whole_page",
        reason: `The patched page failed an integrity check: ${integrity.issues.join(" ") || "unspecified"}`
      };
    }
    return {
      kind: "patched",
      applied: application.applied,
      draft: { ...draft, qualityReport: inheritedQualityReport(options.page.qualityReport, application.applied) }
    };
  }
  return {
    kind: "whole_page",
    reason: `The model named spans that are not on the page (${patchRepair.map((failure) => failure.reason).join(", ")}).`
  };
}

/**
 * The page's standing report, annotated. A page that was FAILED_QA before the
 * edit stays FAILED_QA after it — the patch changed nothing the verdict was
 * about — and a page with no readable report gets the same self-approval a
 * verified literal replacement does.
 */
function inheritedQualityReport(stored: unknown, applied: number): PageQualityReport {
  const note = `Applied a targeted user edit (${applied} replacement${applied === 1 ? "" : "s"}); the rest of the page is unchanged.`;
  const parsed = pageQualityReportSchema.safeParse(stored);
  if (parsed.success) {
    return { ...parsed.data, notes: [parsed.data.notes, note].filter(Boolean).join(" ") };
  }
  return {
    approved: true,
    score: 90,
    issues: [],
    requiredRevisions: [],
    notes: note,
    groundedOk: true,
    unsupportedClaims: [],
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk: true,
      progressionOk: true,
      styleNatural: true
    }
  };
}
