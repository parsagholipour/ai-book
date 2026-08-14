import {
  modelTierForInput,
  parseQualityFeatureSettings,
  qualityFeatureEnabled,
  type CreateProjectInput,
  type QualityFeatureId,
  type QualityFeatureSettings,
  type TextModelAdapter
} from "@book-maker/core";
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
