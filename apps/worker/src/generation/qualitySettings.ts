// Both subpaths, not the barrel: this module is `vi.mock`ed, and every runtime
// symbol it wants already lives in a leaf. Through `@book-maker/core` the two
// lookups below dragged puppeteer, sharp, openai and md-to-pdf in behind them.
import { modelTierForInput } from "@book-maker/core/modelTiers";
import {
  parseQualityFeatureSettings,
  qualityFeatureEnabled,
  type QualityFeatureId,
  type QualityFeatureSettings
} from "@book-maker/core/qualityGates";
import type { CreateProjectInput, TextModelAdapter } from "@book-maker/core";
import { prisma } from "@book-maker/db";

export async function loadQualitySettings(): Promise<QualityFeatureSettings> {
  const row = await prisma.generationQualityRevision.findFirst({
    orderBy: { version: "desc" },
    select: { settings: true }
  });
  return parseQualityFeatureSettings(row?.settings);
}

export async function loadQualityContext(input: CreateProjectInput) {
  const settings = await loadQualitySettings();
  const tier = modelTierForInput(input);
  return {
    settings,
    tier,
    enabled: (feature: QualityFeatureId) => qualityFeatureEnabled(settings, feature, tier)
  };
}

export function applyPlanThinkingBoost(adapter: TextModelAdapter, enabled: boolean): void {
  // Worker call sites pass LoggingTextModelAdapter, which wraps the router.
  // Duck-type the toggle so a live Quality-tab deselect actually drops
  // plan/page-map thinking instead of no-op'ing on `instanceof`.
  const candidate = adapter as { setPurposeOverridesEnabled?: (value: boolean) => void };
  if (typeof candidate.setPurposeOverridesEnabled === "function") {
    candidate.setPurposeOverridesEnabled(enabled);
  }
}
