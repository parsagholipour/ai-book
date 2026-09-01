import type { ImageModelSelection, Project, TextModelSelection } from "../../api.js";
import { formatStrategyLabel } from "./draft.js";
import {
  DEFAULT_GENERATION_STRATEGY_ID,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TONE_PROFILE,
  TONE_PROFILE_OPTIONS,
  imageModelSelectionFromOption,
  imageModelSelectionFromValue,
  resolveGenerationStrategy,
  sameImageModel,
  resolveCoverArtSource,
  toneProfileFromValue,
  type GenerationStrategyOption,
  type ImageModelOption
} from "./draft.js";

export type ProjectHoverState = {
  project: Project;
  x: number;
  y: number;
} | null;

export function projectPopoverPoint(clientX: number, clientY: number): { x: number; y: number } {
  const offset = 14;
  const popoverWidth = 260;
  const popoverHeight = 238;
  const viewportPadding = 8;

  return {
    x: Math.max(viewportPadding, Math.min(clientX + offset, window.innerWidth - popoverWidth - viewportPadding)),
    y: Math.max(viewportPadding, Math.min(clientY + offset, window.innerHeight - popoverHeight - viewportPadding))
  };
}

export function projectStrategyLabel(project: Project, strategies: GenerationStrategyOption[]): string {
  const strategyId = project.mediaSettings?.generationStrategy ?? DEFAULT_GENERATION_STRATEGY_ID;
  return resolveGenerationStrategy(strategies, strategyId).label;
}

export function projectToneLabel(project: Project): string {
  const toneProfile = toneProfileFromValue(project.mediaSettings?.toneProfile ?? DEFAULT_TONE_PROFILE);
  return TONE_PROFILE_OPTIONS.find((tone) => tone.id === toneProfile)?.label ?? formatStrategyLabel(toneProfile);
}

export function formatProjectAiModels(
  project: Project,
  imageModelOptions: ImageModelOption[]
): string {
  const labels = ["Text Quality routing"];
  if (projectUsesImageModel(project)) {
    labels.push(`Image ${projectImageModelLabel(project, imageModelOptions)}`);
  }
  return labels.join(" · ");
}

export function projectImageModelLabel(project: Project, options: ImageModelOption[]): string {
  const mediaSettings = projectSavedMediaSettings(project);
  const selection = mediaSettings.imageModel
    ? imageModelSelectionFromValue(mediaSettings.imageModel)
    : options[0]
      ? imageModelSelectionFromOption(options[0])
      : DEFAULT_IMAGE_MODEL;
  const option = options.find((candidate) => sameImageModel(candidate, selection));
  return option?.label ?? modelSelectionLabel(selection);
}

export function projectUsesImageModel(project: Project): boolean {
  const mediaSettings = projectSavedMediaSettings(project);
  const fullIllustrations =
    typeof mediaSettings.fullIllustrations === "boolean"
      ? mediaSettings.fullIllustrations
      : true;
  // A bundled design draws itself, so only generated cover art needs a model.
  const generatedCover = resolveCoverArtSource(mediaSettings) === "ai";
  return fullIllustrations || generatedCover;
}

export function projectSavedMediaSettings(project: Project): NonNullable<Project["mediaSettings"]> {
  return {
    ...project.mediaSettings,
    ...project.currentPlan?.inputSnapshot?.mediaSettings
  };
}

export function modelSelectionLabel(selection: TextModelSelection | ImageModelSelection): string {
  if (
    "thinkingEffort" in selection &&
    (selection.provider === "deepseek" ||
      selection.provider === "deepinfra" ||
      selection.provider === "openrouter" ||
      selection.provider === "gemini" ||
      selection.provider === "openai") &&
    selection.thinkingEffort
  ) {
    if (selection.thinkingEffort === "none") {
      return `${modelProviderLabel(selection.provider)} ${selection.model}`;
    }
    return `${modelProviderLabel(selection.provider)} ${selection.model} (${thinkingEffortLabel(selection.thinkingEffort)} Effort)`;
  }
  if (
    "thinkingEnabled" in selection &&
    (selection.provider === "deepseek" || selection.provider === "deepinfra") &&
    selection.thinkingEnabled
  ) {
    return `${modelProviderLabel(selection.provider)} ${selection.model} (Thinking)`;
  }
  if ("thinkingBudget" in selection && selection.provider === "gemini" && selection.thinkingBudget === 0) {
    return `${modelProviderLabel(selection.provider)} ${selection.model} (No Thinking)`;
  }
  return `${modelProviderLabel(selection.provider)} ${selection.model}`;
}

function thinkingEffortLabel(effort: NonNullable<TextModelSelection["thinkingEffort"]>): string {
  if (effort === "xhigh") return "Extra High";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function modelProviderLabel(provider: TextModelSelection["provider"] | ImageModelSelection["provider"]): string {
  if (provider === "deepseek") {
    return "DeepSeek";
  }
  if (provider === "deepinfra") {
    return "DeepInfra";
  }
  if (provider === "openrouter") {
    return "OpenRouter";
  }
  if (provider === "gemini") {
    return "Gemini";
  }
  if (provider === "openai") {
    return "OpenAI";
  }
  if (provider === "openai-compatible") {
    return "Local";
  }
  return "Alibaba";
}

export function formatProjectPages(project: Project): string {
  const pageCount = project._count?.pages;
  return typeof pageCount === "number" ? `${pageCount}/${project.targetPages}` : `${project.targetPages}`;
}
