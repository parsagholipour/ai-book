import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PageReviewPromptModeControls,
  QualityTierFieldset,
  rebasePageReviewPromptModes,
  toggleQualityTier
} from "./GenerationQualityControls.js";
import {
  qualitySaveClaim,
  recoverQualitySave
} from "./GenerationQualityScreen.js";
import { generationQualityResponse as responseWith } from "./generationQualityTestFixtures.js";

describe("quality tier controls", () => {
  it("renders an observed unknown active tier and lets the shared toggle remove it", () => {
    const assigned = ["ultra", "glacial"];
    const markup = renderToStaticMarkup(
      createElement(QualityTierFieldset, {
        label: "Plan critic",
        assigned,
        disabled: true,
        onToggle: () => undefined
      })
    );

    expect(markup).toContain("Ultra");
    expect(markup).toContain("Unknown tier · glacial");
    expect(markup).toContain('aria-label="Plan critic"');
    expect(markup).toContain("disabled");
    expect(markup.match(/checked=""/g)).toHaveLength(2);
    expect(toggleQualityTier(assigned, "glacial")).toEqual(["ultra"]);
  });

  it("renders a Normal or Compact model-page-review mode alongside every tier", () => {
    const state = responseWith();
    state.pageReviewPromptModes.premium = "compact";
    const markup = renderToStaticMarkup(
      createElement(PageReviewPromptModeControls, {
        modes: state.pageReviewPromptModes,
        onChange: () => undefined
      })
    );

    expect(markup).toContain("Ultra model page review mode");
    expect(markup).toContain("Premium model page review mode");
    expect(markup).toContain("Balanced model page review mode");
    expect(markup).toContain("Quick draft model page review mode");
    expect(markup).toContain('<option value="normal">Normal</option>');
    expect(markup).toContain('<option value="compact" selected="">Compact</option>');
  });
});

describe("page-review prompt-mode conflict recovery", () => {
  it("keeps local changes while adopting a concurrent change to another tier", async () => {
    const loaded = responseWith();
    const head = responseWith();
    head.version = loaded.version + 1;
    head.pageReviewPromptModes.premium = "compact";
    const localModes = {
      ...loaded.pageReviewPromptModes,
      balanced: "compact" as const
    };

    expect(
      rebasePageReviewPromptModes(
        head.pageReviewPromptModes,
        loaded.pageReviewPromptModes,
        localModes
      )
    ).toEqual({
      ultra: "normal",
      premium: "compact",
      balanced: "compact",
      fast: "normal"
    });

    const recovery = await recoverQualitySave({
      error: new Error(JSON.stringify({
        error: "Generation quality changed concurrently",
        currentVersion: loaded.version
      })),
      loaded,
      draft: structuredClone(loaded.settings),
      modelDraft: loaded.models,
      draftPageReviewPromptModes: localModes,
      note: "",
      reload: () => Promise.resolve(head)
    });

    if (recovery.kind !== "rebase") {
      throw new Error(`expected a rebase, got ${recovery.kind}`);
    }
    expect(recovery.pageReviewPromptModeDraft).toEqual({
      ultra: "normal",
      premium: "compact",
      balanced: "compact",
      fast: "normal"
    });
    expect(qualitySaveClaim(
      recovery.state.settings,
      recovery.draft,
      "",
      recovery.state.models,
      recovery.modelDraft,
      recovery.state.pageReviewPromptModes,
      recovery.pageReviewPromptModeDraft
    )).toEqual({ pageReviewPromptModes: { balanced: "compact" } });
  });
});
