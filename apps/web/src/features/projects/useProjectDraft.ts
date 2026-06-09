import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, RuntimeInfo } from "../../api.js";
import {
  DEFAULT_GENERATION_STRATEGIES,
  DEFAULT_IMAGE_MODEL_OPTIONS,
  DEFAULT_TEXT_MODEL_OPTIONS,
  draftFromSavedInputs,
  imageModelSelectionFromOption,
  initialDraft,
  resolveImageModelOption,
  resolveTextModelOption,
  sameImageModel,
  sameTextModel,
  textModelSelectionFromOption,
  type DraftProject
} from "./draft.js";

export function useProjectDraft(args: { runtime: RuntimeInfo | null; selectedProject: Project | null | undefined }) {
  const [draft, setDraft] = useState<DraftProject>(initialDraft);
  const hydratedDraftSourceRef = useRef<string | null>(null);

  const textModelOptions = useMemo(
    () => (args.runtime?.textModelOptions?.length ? args.runtime.textModelOptions : DEFAULT_TEXT_MODEL_OPTIONS),
    [args.runtime?.textModelOptions]
  );
  const imageModelOptions = useMemo(
    () => (args.runtime?.imageModelOptions?.length ? args.runtime.imageModelOptions : DEFAULT_IMAGE_MODEL_OPTIONS),
    [args.runtime?.imageModelOptions]
  );
  const strategyOptions = useMemo(
    () =>
      args.runtime?.generationStrategies?.length
        ? args.runtime.generationStrategies
        : DEFAULT_GENERATION_STRATEGIES,
    [args.runtime?.generationStrategies]
  );

  useEffect(() => {
    if (!args.selectedProject) {
      hydratedDraftSourceRef.current = null;
      return;
    }

    const sourceKey = `${args.selectedProject.id}:${args.selectedProject.currentPlan?.id ?? "project"}`;
    if (hydratedDraftSourceRef.current === sourceKey) {
      return;
    }

    setDraft(draftFromSavedInputs(args.selectedProject));
    hydratedDraftSourceRef.current = sourceKey;
  }, [args.selectedProject]);

  useEffect(() => {
    const fallback = textModelOptions[0];
    if (!fallback) {
      return;
    }
    setDraft((current) =>
      textModelOptions.some((option) => sameTextModel(option, current.textModel))
        ? current
        : { ...current, textModel: textModelSelectionFromOption(fallback) }
    );
  }, [textModelOptions]);

  useEffect(() => {
    const fallback = imageModelOptions[0];
    if (!fallback) {
      return;
    }
    setDraft((current) =>
      imageModelOptions.some((option) => sameImageModel(option, current.imageModel))
        ? current
        : { ...current, imageModel: imageModelSelectionFromOption(fallback) }
    );
  }, [imageModelOptions]);

  const selectedStrategy =
    strategyOptions.find((strategy) => strategy.id === draft.generationStrategy) ?? strategyOptions[0];
  const selectedTextModel = resolveTextModelOption(textModelOptions, draft.textModel);
  const selectedImageModel = resolveImageModelOption(imageModelOptions, draft.imageModel);
  const showImageModelControls = draft.fullIllustrations || draft.includeCover;

  return {
    draft,
    setDraft,
    textModelOptions,
    imageModelOptions,
    strategyOptions,
    selectedStrategy,
    selectedTextModel,
    selectedImageModel,
    showImageModelControls
  };
}
