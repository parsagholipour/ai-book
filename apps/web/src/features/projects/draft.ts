import type {
  AudienceAgeRange,
  ImageModelSelection,
  Project,
  ProjectInputSnapshot,
  RuntimeInfo
} from "../../api.js";
import { firstString, formatUsd } from "../shared/formatters.js";

/**
 * Mirrors `CoverArtSource` in `packages/core`, which apps/web cannot import.
 * "design" is the free bundled catalog; "none" is the only genuinely
 * cover-less state, and this console is the only surface that can set it.
 */
export type CoverArtSource = "ai" | "design" | "none";

export type ProjectCategory =
  | "KIDS"
  | "SCIENCE"
  | "STORY"
  | "EDUCATION"
  | "BUSINESS"
  | "SELF_HELP"
  | "HEALTH"
  | "BIOGRAPHY"
  | "HISTORY"
  | "SOCIETY"
  | "ARTS"
  | "CUSTOM";
export type ToneProfile = "neutral" | "confident" | "skeptical" | "scholarly" | "conversational" | "narrative";
export type CoverTemplateId = "auto" | "kids" | "science" | "fiction" | "minimal" | "business" | "self-help" | "romance";

export type DraftProject = {
  title: string;
  subtitle: string;
  authorName: string;
  coverTagline: string;
  prompt: string;
  category: ProjectCategory;
  subcategory: string;
  customSubcategory: string;
  generationStrategy: string;
  imageModel: ImageModelSelection;
  coverTemplate: CoverTemplateId;
  audienceAgeRange: AudienceAgeRange;
  targetPages: number;
  complexity: number;
  temperature: number;
  fullIllustrations: boolean;
  /** "ai" draws the cover, "design" picks a bundled one, "none" has no cover. */
  coverArtSource: CoverArtSource;
  finalReview: boolean;
  toneProfile: ToneProfile;
  draftCandidates: number;
};

export type GenerationStrategyOption = RuntimeInfo["generationStrategies"][number];
export type ImageModelOption = RuntimeInfo["imageModelOptions"][number];

export const CUSTOM_SUBCATEGORY_VALUE = "__custom";
export const DEFAULT_GENERATION_STRATEGY_ID = "auto";
export const DEFAULT_TONE_PROFILE: ToneProfile = "neutral";
export const DEFAULT_IMAGE_MODEL: ImageModelSelection = { provider: "gemini", model: "gemini-2.5-flash-image" };

export const CATEGORY_OPTIONS: Array<{ value: ProjectCategory; label: string }> = [
  { value: "KIDS", label: "Kids' books" },
  { value: "SCIENCE", label: "Science & nature" },
  { value: "STORY", label: "Fiction & stories" },
  { value: "EDUCATION", label: "Education & how-to" },
  { value: "BUSINESS", label: "Business & career" },
  { value: "SELF_HELP", label: "Self-help & relationships" },
  { value: "HEALTH", label: "Health & wellness" },
  { value: "BIOGRAPHY", label: "Biography & memoir" },
  { value: "HISTORY", label: "History" },
  { value: "SOCIETY", label: "Society & culture" },
  { value: "ARTS", label: "Arts & poetry" },
  { value: "CUSTOM", label: "General / custom" }
];
const PROJECT_CATEGORY_VALUES = CATEGORY_OPTIONS.map((category) => category.value);
const CATEGORY_LABELS = Object.fromEntries(
  CATEGORY_OPTIONS.map((category) => [category.value, category.label])
) as Record<ProjectCategory, string>;

export const SUBCATEGORY_OPTIONS: Record<ProjectCategory, string[]> = {
  KIDS: [
    "Picture book",
    "Early reader",
    "Bedtime story",
    "Learning & school",
    "Adventure",
    "Friendship & feelings",
    "Folktale & fairy tale",
    "Middle grade"
  ],
  SCIENCE: [
    "Space & astronomy",
    "Biology & nature",
    "Physics",
    "Climate & environment",
    "Technology",
    "Health science education",
    "Mathematics",
    "Earth science"
  ],
  STORY: [
    "Literary fiction",
    "Romance",
    "Fantasy",
    "Mystery & thriller",
    "Science fiction",
    "Horror",
    "Historical fiction",
    "Adventure"
  ],
  EDUCATION: [
    "How-to guide",
    "Study guide",
    "Workbook",
    "Language learning",
    "Parenting & teaching",
    "Reference",
    "Career skills",
    "DIY & crafts"
  ],
  BUSINESS: [
    "Entrepreneurship",
    "Marketing & sales",
    "Leadership",
    "Career development",
    "Personal finance education",
    "Investing education",
    "Product & startups",
    "Management"
  ],
  SELF_HELP: [
    "Personal growth",
    "Productivity",
    "Mindfulness",
    "Relationships",
    "Communication",
    "Creativity",
    "Confidence",
    "Life transitions"
  ],
  HEALTH: [
    "Nutrition",
    "Fitness",
    "Mental wellbeing education",
    "Sleep",
    "Patient education (not medical advice)",
    "Public health education",
    "Aging & longevity",
    "Wellness"
  ],
  BIOGRAPHY: [
    "Memoir",
    "Autobiography",
    "Profile",
    "Family history",
    "Travel memoir",
    "Creative nonfiction",
    "Leadership biography",
    "Historical biography"
  ],
  HISTORY: [
    "Ancient history",
    "Medieval history",
    "Modern history",
    "Military history",
    "Political history",
    "Cultural history",
    "Local history",
    "True crime"
  ],
  SOCIETY: [
    "Politics & government",
    "Social issues",
    "Culture & media",
    "Philosophy & ideas",
    "Religion & spirituality",
    "Economics",
    "Law & civic education",
    "Environment & society"
  ],
  ARTS: [
    "Poetry",
    "Art & design",
    "Photography",
    "Music",
    "Film & theater",
    "Writing craft",
    "Comics & graphic novels",
    "Food & travel"
  ],
  CUSTOM: [
    "Essay collection",
    "Journal / workbook",
    "Research report",
    "Manifesto",
    "Worldbuilding bible",
    "Brand book",
    "Newsletter-to-book",
    "Other niche format"
  ]
};

export const DEFAULT_GENERATION_STRATEGIES: GenerationStrategyOption[] = [
  {
    id: "auto",
    label: "Auto (recommended)",
    strengthScore: 10,
    recommendedPageRange: { min: 1, max: 600 }
  },
  {
    id: "chaptered-sequential",
    label: "Chaptered sequential generation",
    strengthScore: 7,
    recommendedPageRange: { min: 12, max: 80 }
  },
  {
    id: "whole-book-single-pass",
    label: "Whole book single pass",
    strengthScore: 3,
    recommendedPageRange: { min: 5, max: 20 }
  },
  {
    id: "page-map-sequential",
    label: "Page-map sequential generation",
    strengthScore: 8,
    recommendedPageRange: { min: 12, max: 120 }
  },
  {
    id: "chapter-whole-pass",
    label: "Chapter whole-pass generation",
    strengthScore: 7,
    recommendedPageRange: { min: 16, max: 120 }
  },
  {
    id: "batch-window",
    label: "Batch window generation",
    strengthScore: 6,
    recommendedPageRange: { min: 12, max: 80 }
  },
  {
    id: "draft-then-polish",
    label: "Draft then polish",
    strengthScore: 9,
    recommendedPageRange: { min: 5, max: 40 }
  },
  {
    id: "research-grounded",
    label: "Research-grounded generation",
    strengthScore: 9,
    recommendedPageRange: { min: 12, max: 80 }
  },
  {
    id: "research-map-draft-polish",
    label: "Research map draft & polish",
    strengthScore: 10,
    recommendedPageRange: { min: 12, max: 80 }
  },
  {
    id: "composed-chapters",
    label: "Composed chapters",
    strengthScore: 10,
    recommendedPageRange: { min: 12, max: 600 }
  },
  {
    id: "composed-chapters-research",
    label: "Composed chapters (research-grounded)",
    strengthScore: 10,
    recommendedPageRange: { min: 12, max: 600 }
  }
];

export const DEFAULT_IMAGE_MODEL_OPTIONS: ImageModelOption[] = [
  {
    provider: DEFAULT_IMAGE_MODEL.provider,
    model: DEFAULT_IMAGE_MODEL.model,
    label: "Gemini 2.5 Flash Image",
    costUsd: 0.039,
    supportsReferenceImages: true,
    description: "Best for books with recurring characters."
  }
];
export const TONE_PROFILE_OPTIONS: Array<{ id: ToneProfile; label: string; hint: string }> = [
  { id: "neutral", label: "Neutral", hint: "Balanced and natural" },
  { id: "confident", label: "Confident", hint: "Assertive without proof-leaps" },
  { id: "skeptical", label: "Skeptical", hint: "Careful about easy conclusions" },
  { id: "scholarly", label: "Scholarly", hint: "Measured and source-aware" },
  { id: "conversational", label: "Conversational", hint: "Plainspoken and warm" },
  { id: "narrative", label: "Narrative", hint: "Scene and example led" }
];
export const AUDIENCE_AGE_RANGE_OPTIONS: Array<{ value: AudienceAgeRange; label: string }> = [
  { value: "2-4", label: "Ages 2-4" },
  { value: "4-6", label: "Ages 4-6" },
  { value: "6-8", label: "Ages 6-8" }
];

export const initialDraft: DraftProject = {
  title: "",
  subtitle: "",
  authorName: "",
  coverTagline: "",
  prompt: "A curious child discovers that the moon keeps a tiny library of forgotten bedtime stories.",
  category: "KIDS",
  subcategory: "",
  customSubcategory: "",
  generationStrategy: DEFAULT_GENERATION_STRATEGY_ID,
  imageModel: DEFAULT_IMAGE_MODEL,
  coverTemplate: "auto",
  audienceAgeRange: "4-6",
  targetPages: 32,
  complexity: 3,
  temperature: 0.8,
  fullIllustrations: true,
  coverArtSource: "ai",
  finalReview: true,
  toneProfile: DEFAULT_TONE_PROFILE,
  draftCandidates: 1
};

export function projectInputFromDraft(draft: DraftProject) {
  const selectedSubcategory =
    draft.subcategory === CUSTOM_SUBCATEGORY_VALUE ? draft.customSubcategory.trim() : draft.subcategory.trim();

  return {
    title: draft.title.trim() || undefined,
    subtitle: draft.subtitle.trim() || undefined,
    authorName: draft.authorName.trim() || undefined,
    coverTagline: draft.coverTagline.trim() || undefined,
    prompt: draft.prompt,
    category: draft.category,
    subcategory: selectedSubcategory || undefined,
    targetPages: draft.targetPages,
    complexity: draft.complexity,
    temperature: draft.temperature,
    mediaSettings: {
      fullIllustrations: draft.fullIllustrations,
      illustrationCadence: "template-driven",
      includeCover: draft.coverArtSource === "ai",
      coverArtSource: draft.coverArtSource,
      coverTemplate: draft.coverTemplate,
      imageModel: imageModelSelectionFromOption(draft.imageModel),
      finalReview: draft.finalReview,
      generationStrategy: draft.generationStrategy,
      ...(draft.category === "KIDS" ? { audienceAgeRange: draft.audienceAgeRange } : {}),
      toneProfile: draft.toneProfile,
      ...(draft.draftCandidates > 1 ? { draftCandidates: draft.draftCandidates } : {})
    }
  };
}

export function draftFromSavedInputs(project: Project): DraftProject {
  const snapshot: ProjectInputSnapshot | null = project.currentPlan?.inputSnapshot ?? null;
  const category = projectCategoryFromValue(firstString(snapshot?.category, project.category));
  const mediaSettings = {
    ...project.mediaSettings,
    ...snapshot?.mediaSettings
  };
  const subcategory = draftSubcategoryFromValue(category, firstString(snapshot?.subcategory, project.subcategory));

  return {
    title: firstString(snapshot?.title, project.title),
    subtitle: firstString(snapshot?.subtitle, project.subtitle),
    authorName: firstString(snapshot?.authorName, project.authorName),
    coverTagline: firstString(snapshot?.coverTagline, project.coverTagline),
    prompt: firstString(snapshot?.prompt, project.prompt, initialDraft.prompt),
    category,
    subcategory: subcategory.subcategory,
    customSubcategory: subcategory.customSubcategory,
    generationStrategy: firstString(mediaSettings.generationStrategy, DEFAULT_GENERATION_STRATEGY_ID),
    imageModel: imageModelSelectionFromValue(mediaSettings.imageModel),
    coverTemplate: coverTemplateFromValue(firstString(mediaSettings.coverTemplate, initialDraft.coverTemplate)),
    targetPages: clampInt(
      firstFiniteNumber(snapshot?.targetPages, project.targetPages) ?? initialDraft.targetPages,
      1,
      600
    ),
    complexity: clampInt(
      firstFiniteNumber(snapshot?.complexity, project.complexity) ?? initialDraft.complexity,
      1,
      10
    ),
    temperature: clampNumber(
      firstFiniteNumber(snapshot?.temperature, project.temperature) ?? initialDraft.temperature,
      0,
      2
    ),
    fullIllustrations: firstBoolean(mediaSettings.fullIllustrations, initialDraft.fullIllustrations),
    coverArtSource: resolveCoverArtSource(mediaSettings),
    finalReview: firstBoolean(mediaSettings.finalReview, initialDraft.finalReview),
    audienceAgeRange:
      category === "KIDS" ? audienceAgeRangeFromValue(mediaSettings.audienceAgeRange) : initialDraft.audienceAgeRange,
    toneProfile: toneProfileFromValue(firstString(mediaSettings.toneProfile, initialDraft.toneProfile)),
    draftCandidates: clampInt(firstFiniteNumber(mediaSettings.draftCandidates) ?? initialDraft.draftCandidates, 1, 3)
  };
}

export function audienceAgeRangeFromValue(value: unknown): AudienceAgeRange {
  return value === "2-4" || value === "4-6" || value === "6-8" ? value : initialDraft.audienceAgeRange;
}

export function projectCategoryFromValue(value: string): ProjectCategory {
  return isProjectCategory(value) ? value : initialDraft.category;
}

export function isProjectCategory(value: string): value is ProjectCategory {
  return PROJECT_CATEGORY_VALUES.includes(value as ProjectCategory);
}

export function draftSubcategoryFromValue(
  category: ProjectCategory,
  value: string
): Pick<DraftProject, "subcategory" | "customSubcategory"> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { subcategory: "", customSubcategory: "" };
  }
  if (SUBCATEGORY_OPTIONS[category].includes(trimmed)) {
    return { subcategory: trimmed, customSubcategory: "" };
  }
  return { subcategory: CUSTOM_SUBCATEGORY_VALUE, customSubcategory: trimmed };
}

export function isCoverArtSource(value: unknown): value is CoverArtSource {
  return value === "ai" || value === "design" || value === "none";
}

/**
 * The console's copy of `coverArtSourceFor` in packages/core (apps/web does not
 * depend on the workspace packages): a validated `coverArtSource` wins, and the
 * legacy `includeCover` resolves `false` to a designed cover, never to none.
 */
export function resolveCoverArtSource(mediaSettings: {
  coverArtSource?: unknown;
  includeCover?: unknown;
}): CoverArtSource {
  if (isCoverArtSource(mediaSettings.coverArtSource)) {
    return mediaSettings.coverArtSource;
  }
  return (typeof mediaSettings.includeCover === "boolean" ? mediaSettings.includeCover : true) ? "ai" : "design";
}

export function coverTemplateFromValue(value: string): DraftProject["coverTemplate"] {
  return value === "kids" ||
    value === "science" ||
    value === "fiction" ||
    value === "minimal" ||
    value === "business" ||
    value === "self-help" ||
    value === "romance"
    ? value
    : "auto";
}

export function toneProfileFromValue(value: string): ToneProfile {
  return value === "confident" ||
    value === "skeptical" ||
    value === "scholarly" ||
    value === "conversational" ||
    value === "narrative" ||
    value === "neutral"
    ? value
    : DEFAULT_TONE_PROFILE;
}

export function imageModelSelectionFromValue(value: unknown): ImageModelSelection {
  if (typeof value === "string" && value.trim()) {
    return { provider: "gemini", model: value.trim().replace(/^models\//, "") };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_IMAGE_MODEL;
  }
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  const model = record.model;
  if ((provider === "gemini" || provider === "alibaba") && typeof model === "string" && model.trim()) {
    return { provider, model: model.trim().replace(/^models\//, "") };
  }
  return DEFAULT_IMAGE_MODEL;
}

export function imageModelSelectionFromOption(option: ImageModelSelection): ImageModelSelection {
  return {
    provider: option.provider,
    model: option.model
  };
}

export function imageModelSelectionFromKey(key: string, options: ImageModelOption[]): ImageModelSelection {
  const option =
    options.find((candidate) => imageModelKey(candidate) === key) ?? options[0] ?? DEFAULT_IMAGE_MODEL_OPTIONS[0]!;
  return imageModelSelectionFromOption(option);
}

export function resolveImageModelOption(options: ImageModelOption[], selection: ImageModelSelection): ImageModelOption {
  return options.find((option) => sameImageModel(option, selection)) ?? options[0] ?? DEFAULT_IMAGE_MODEL_OPTIONS[0]!;
}

export function imageModelLabel(option: ImageModelOption): string {
  return option.costUsd === undefined ? option.label : `${option.label} — ${formatUsd(option.costUsd)}/image`;
}

export function sameImageModel(first: ImageModelSelection, second: ImageModelSelection): boolean {
  return first.provider === second.provider && first.model === second.model;
}

export function imageModelKey(selection: ImageModelSelection): string {
  return `${selection.provider}:${selection.model}`;
}

export function resolveGenerationStrategy(
  strategies: GenerationStrategyOption[],
  strategyId: string
): GenerationStrategyOption {
  return (
    strategies.find((strategy) => strategy.id === strategyId) ??
    DEFAULT_GENERATION_STRATEGIES.find((strategy) => strategy.id === strategyId) ?? {
      id: strategyId,
      label: formatStrategyLabel(strategyId),
      strengthScore: 0,
      recommendedPageRange: { min: 5, max: 20 }
    }
  );
}

export function formatRecommendedPageRange(range?: GenerationStrategyOption["recommendedPageRange"]): string {
  const fallbackRange = DEFAULT_GENERATION_STRATEGIES[1]?.recommendedPageRange ?? { min: 5, max: 20 };
  const pageRange = range ?? fallbackRange;
  const min = Math.max(1, Math.round(pageRange.min));
  const max = Math.max(min, Math.round(pageRange.max));
  return `${min}-${max}`;
}

export function formatStrategyLabel(strategyId: string): string {
  return strategyId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatProjectCategory(category: string, subcategory?: string | null): string {
  const categoryLabel = category in CATEGORY_LABELS ? CATEGORY_LABELS[category as ProjectCategory] : category;
  const trimmedSubcategory = subcategory?.trim();
  return trimmedSubcategory ? `${categoryLabel} / ${trimmedSubcategory}` : categoryLabel;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return false;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
