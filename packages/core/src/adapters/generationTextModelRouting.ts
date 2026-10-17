import type { AppConfig } from "../config.js";
import type { TextGenerationCostRate } from "../costs.js";
import type {
  ModelTier,
  TextModelSelection,
  TextModelThinkingEffort
} from "../schemas/book.js";

export type { ModelTier, TextModelSelection, TextModelThinkingEffort } from "../schemas/book.js";

export const GENERATION_TEXT_MODEL_TIERS = ["fast", "balanced", "premium", "ultra"] as const;
export const GENERATION_TEXT_MODEL_ROLES = ["writer", "judgment"] as const;
export const GENERATION_TEXT_MODEL_ROUTE_FIELDS = [
  "writer",
  "writerFallback",
  "judgment",
  "judgmentFallback"
] as const;

export type GenerationTextModelRole = (typeof GENERATION_TEXT_MODEL_ROLES)[number];
export type GenerationTextModelRouteField = (typeof GENERATION_TEXT_MODEL_ROUTE_FIELDS)[number];
/** Provider-call purposes are the stage IDs: the UI and the router use the same registry. */
export const GENERATION_MODEL_STAGES = [
  { id: "plan-book", label: "Book plan", group: "Planning", role: "writer" },
  { id: "revise-plan", label: "Plan revision", group: "Planning", role: "writer" },
  { id: "author-stance", label: "Author stance", group: "Planning", role: "writer" },
  { id: "architect-book", label: "Book architecture", group: "Planning", role: "writer" },
  { id: "plan-chapter-forms", label: "Chapter forms", group: "Planning", role: "writer" },
  { id: "plan-episodes", label: "Episode planning", group: "Planning", role: "writer" },
  { id: "develop-book-plan", label: "Book development", group: "Development", role: "writer" },
  { id: "review-book-development", label: "Development review", group: "Development", role: "writer" },
  { id: "plan-developmental-edit", label: "Developmental edit plan", group: "Development", role: "writer" },
  { id: "rewrite-developmental-sections", label: "Developmental rewrite", group: "Development", role: "writer" },
  { id: "extract-excerpts", label: "Source excerpts", group: "Evidence", role: "judgment" },
  { id: "review-dossier-provenance", label: "Source provenance review", group: "Evidence", role: "judgment" },
  { id: "build-case-evidence", label: "Case evidence", group: "Evidence", role: "writer" },
  { id: "verify-case-evidence", label: "Case evidence verification", group: "Evidence", role: "writer" },
  { id: "inventory-chapter-claims", label: "Chapter claim inventory", group: "Evidence", role: "judgment" },
  { id: "review-chapter-evidence", label: "Chapter evidence review", group: "Evidence", role: "writer" },
  { id: "compose-chapter", label: "Chapter drafting", group: "Chapters", role: "writer" },
  { id: "compose-scene", label: "Scene drafting", group: "Chapters", role: "writer" },
  { id: "judge-chapter-drafts", label: "Chapter draft comparison", group: "Chapters", role: "fast" },
  { id: "edit-chapter", label: "Chapter editing", group: "Chapters", role: "writer" },
  { id: "review-chapter-edit-acceptance", label: "Chapter edit acceptance", group: "Chapters", role: "judgment" },
  { id: "detemplate-chapter", label: "Chapter form rewrite", group: "Chapters", role: "writer" },
  { id: "cut-chapter", label: "Chapter cuts", group: "Chapters", role: "writer" },
  { id: "describe-pages", label: "Page titles and summaries", group: "Chapters", role: "judgment" },
  { id: "extract-chapter-facts", label: "Chapter continuity ledger", group: "Chapters", role: "judgment" },
  { id: "read-manuscript", label: "Manuscript review", group: "Manuscript", role: "writer" },
  { id: "inventory-brief-requirements", label: "Brief requirement inventory", group: "Manuscript", role: "writer" },
  { id: "rewrite-seams", label: "Chapter transitions rewrite", group: "Manuscript", role: "writer" },
  { id: "final-book-qa", label: "Final book review", group: "Manuscript", role: "judgment" },
  { id: "chapterize-export", label: "Export chapter structure", group: "Manuscript", role: "judgment" },
  { id: "generate-page-map", label: "Page map", group: "Page mapping", role: "judgment" },
  { id: "generate-chapter-brief", label: "Chapter briefs", group: "Page mapping", role: "judgment" },
  { id: "dedupe-page-beats", label: "Page beat rewrite", group: "Page mapping", role: "judgment" },
  { id: "generate-page", label: "Page drafting", group: "Pages", role: "writer" },
  { id: "generate-chapter-draft", label: "Chapter page draft", group: "Pages", role: "writer" },
  { id: "generate-page-batch", label: "Batch page draft", group: "Pages", role: "writer" },
  { id: "generate-whole-book", label: "Whole book draft", group: "Pages", role: "writer" },
  { id: "write-page-with-tools", label: "Page drafting with tools", group: "Pages", role: "writer" },
  { id: "review-page", label: "Page review", group: "Page review", role: "judgment" },
  { id: "revise-page", label: "Page revision", group: "Page review", role: "writer" },
  { id: "patch-page", label: "Page patch", group: "Page review", role: "writer" },
  { id: "verify-page-claims", label: "Page claim verification", group: "Page review", role: "judgment" },
  { id: "audit-page-style", label: "Page style review", group: "Page review", role: "judgment" },
  { id: "review-edit-adherence", label: "Edit instruction review", group: "Page review", role: "judgment" },
  { id: "select-cover-design", label: "Cover design selection", group: "Supporting steps", role: "judgment" },
  { id: "rewrite-image-prompt-copyright-safe", label: "Image prompt rewrite", group: "Supporting steps", role: "judgment" },
  { id: "extract-voice-character-candidates", label: "Voice character extraction", group: "Supporting steps", role: "writer" },
  { id: "build-voice-character-persona", label: "Voice character persona", group: "Supporting steps", role: "writer" },
  { id: "import-chapterize", label: "Import chapter structure", group: "Supporting steps", role: "judgment" },
  { id: "import-style-profile", label: "Import style profile", group: "Supporting steps", role: "judgment" },
  { id: "author-assist-rewrite", label: "Rewrite", group: "Writing Studio", role: "writer" },
  { id: "author-assist-proofread", label: "Proofread", group: "Writing Studio", role: "judgment" },
  { id: "author-assist-continue", label: "Continue writing", group: "Writing Studio", role: "writer" },
  { id: "author-assist-describe", label: "Describe more vividly", group: "Writing Studio", role: "writer" },
  { id: "author-assist-brainstorm", label: "What happens next", group: "Writing Studio", role: "writer" },
  { id: "author-assist-ask", label: "Ask about the text", group: "Writing Studio", role: "writer" },
  { id: "author-draft-chapter", label: "Draft chapter from notes", group: "Writing Studio", role: "writer" },
  { id: "author-chapter-feedback", label: "Chapter feedback", group: "Writing Studio", role: "judgment" },
  { id: "author-consistency", label: "Book consistency check", group: "Writing Studio", role: "judgment" },
  { id: "author-outline", label: "Book outline", group: "Writing Studio", role: "writer" }
] as const;
export type GenerationModelStageId = (typeof GENERATION_MODEL_STAGES)[number]["id"];
export type GenerationStageRoute = { primary: DecisionModelSelection; fallback: TextModelSelection };
export type GenerationStageRoutes = Partial<Record<GenerationModelStageId, GenerationStageRoute>>;

export function stageSupportsFiniteDecisions(id: string): boolean {
  return id === "judge-chapter-drafts";
}

export function generationModelStage(purpose: string | undefined) {
  return GENERATION_MODEL_STAGES.find((stage) => stage.id === purpose);
}

/** Legacy revisions seed stages from the operator's saved routes, never from tier effort boosts. */
export function generationStageRoute(routing: GenerationTextModelRouting, tier: ModelTier, id: GenerationModelStageId): GenerationStageRoute {
  const saved = routing[tier].stages?.[id];
  if (saved) return saved;
  // Splitting extraction must not silently change any saved model, effort or fallback.
  if (id === "inventory-brief-requirements") return generationStageRoute(routing, tier, "read-manuscript");
  // The next chapter's compose waits on this extraction, so until it is given its own route it takes
  // Quick Draft's page-description route on every tier: luna with no reasoning answered in 2.5–4.7 s
  // on the 2026-09-30 books, Balanced's own (luna, low) in 6–10 s.
  if (id === "extract-chapter-facts") return generationStageRoute(routing, "fast", "describe-pages");
  // New mechanical extraction inherits the operator's existing extraction route until
  // it receives its own saved setting; evidence adjudication retains its route.
  if (id === "inventory-chapter-claims" && routing[tier].stages?.["extract-excerpts"]) {
    return routing[tier].stages["extract-excerpts"];
  }
  if (stageSupportsFiniteDecisions(id) && isJevSelection(routing.fastDecisions)) {
    return { primary: { ...routing.fastDecisions }, fallback: routing.fastDecisionsFallback ?? routing.fastJudgments };
  }
  const stage = generationModelStage(id)!;
  return stage.role === "fast"
    ? { primary: routing.fastJudgments, fallback: routing.fastJudgmentsFallback }
    : { primary: routing[tier][stage.role], fallback: routing[tier][fallbackField(stage.role)] };
}

export function materializeGenerationStages(routing: GenerationTextModelRouting): GenerationTextModelRouting {
  const result = { ...routing };
  for (const tier of GENERATION_TEXT_MODEL_TIERS) {
    result[tier] = { ...routing[tier], stages: Object.fromEntries(GENERATION_MODEL_STAGES.map(({ id }) => {
      const route = generationStageRoute(routing, tier, id);
      return [id, { primary: { ...route.primary }, fallback: { ...route.fallback } }];
    })) };
  }
  return result;
}

export type GenerationTextModelTierRouting = {
  writer: TextModelSelection;
  writerFallback: TextModelSelection;
  judgment: TextModelSelection;
  judgmentFallback: TextModelSelection;
  stages?: GenerationStageRoutes;
};

/** Per-tier writer and judgment routes, Fast judgments, and optional Fast decisions, each with an operator-controlled fallback. */
export type GenerationTextModelRouting = {
  fastDecisions?: DecisionModelSelection | null;
  fastDecisionsFallback?: TextModelSelection;
  fastJudgments: TextModelSelection;
  fastJudgmentsFallback: TextModelSelection;
  fast: GenerationTextModelTierRouting;
  balanced: GenerationTextModelTierRouting;
  premium: GenerationTextModelTierRouting;
  ultra: GenerationTextModelTierRouting;
};

export const JEV_SELECTION = { provider: "vercel-ai-gateway", model: "typesafe-ai/jev" } as const;
export type DecisionModelSelection = TextModelSelection | typeof JEV_SELECTION;

export function isJevSelection(value: unknown): value is typeof JEV_SELECTION {
  const candidate = record(value);
  return candidate?.provider === JEV_SELECTION.provider && candidate.model === JEV_SELECTION.model;
}

export function parseDecisionModelSelection(value: unknown): DecisionModelSelection | undefined {
  const candidate = record(value);
  if (isJevSelection(candidate) &&
      Object.keys(candidate).every((key) => key === "provider" || key === "model")) return { ...JEV_SELECTION };
  return parseTextModelSelection(value);
}

export type GenerationTextModelOption = TextModelSelection & {
  label: string;
  costs?: TextGenerationCostRate[] | undefined;
  preview?: boolean | undefined;
  thinking?: boolean | undefined;
  thinkingEfforts?: Array<{
    value: TextModelThinkingEffort;
    label: string;
    default?: boolean | undefined;
  }> | undefined;
};

const PREMIUM_WRITER: TextModelSelection = {
  provider: "gemini",
  model: "gemini-2.5-pro",
  thinkingBudget: 2048
};
const PREMIUM_JUDGMENT: TextModelSelection = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  thinkingBudget: 0
};
const FAST_GEMINI: TextModelSelection = {
  provider: "gemini",
  model: "gemini-2.5-flash-lite",
  thinkingBudget: 0
};

type TextRouteCandidates = readonly [TextModelSelection, ...TextModelSelection[]];

/**
 * The compiled defaults' preference lists, in order. Each route takes the first
 * candidate the configured catalog offers and the next one as its fallback, so
 * every provider named here is one the defaults can land on — which is why the
 * production check (`providerRequirements.ts`) reads these lists, rather than a
 * copy of them, to decide which provider keys a deployment must carry.
 */
export function compiledGenerationTextRouteCandidates(config: AppConfig) {
  return {
    /** Quick Draft's writer and judgment, and the fast judgments. */
    fast: [
      { provider: "deepseek", model: config.DEEPSEEK_FAST_MODEL, thinkingEnabled: false },
      { provider: "deepinfra", model: config.DEEPINFRA_FAST_MODEL, thinkingEnabled: false },
      FAST_GEMINI,
      { provider: "alibaba", model: "qwen-flash" }
    ],
    balancedWriter: [
      { provider: "deepseek", model: config.DEEPSEEK_MODEL },
      { provider: "deepinfra", model: config.DEEPINFRA_MODEL },
      PREMIUM_WRITER,
      { provider: "alibaba", model: config.ALIBABA_TEXT_MODEL }
    ],
    balancedJudgment: [
      { provider: "deepseek", model: config.DEEPSEEK_FAST_MODEL, thinkingEnabled: false },
      { provider: "deepinfra", model: config.DEEPINFRA_FAST_MODEL, thinkingEnabled: false },
      PREMIUM_JUDGMENT,
      { provider: "alibaba", model: "qwen-flash" }
    ],
    /** Premium and Ultra writers. */
    premiumWriter: [
      PREMIUM_WRITER,
      { provider: "deepseek", model: config.DEEPSEEK_MODEL },
      { provider: "deepinfra", model: config.DEEPINFRA_MODEL },
      { provider: "alibaba", model: config.ALIBABA_TEXT_MODEL }
    ],
    /** Premium and Ultra judgment. */
    premiumJudgment: [
      PREMIUM_JUDGMENT,
      { provider: "deepseek", model: config.DEEPSEEK_FAST_MODEL, thinkingEnabled: false },
      { provider: "deepinfra", model: config.DEEPINFRA_FAST_MODEL, thinkingEnabled: false },
      { provider: "alibaba", model: "qwen-flash" }
    ]
  } satisfies Record<string, TextRouteCandidates>;
}

export type CompiledGenerationTextRouteCandidates = ReturnType<typeof compiledGenerationTextRouteCandidates>;

/**
 * Defaults are the routing that existed before the Quality tab exposed models.
 * A missing preferred provider falls through to the configured catalog order.
 */
export function compiledGenerationTextModelRouting(
  config: AppConfig,
  configuredOptions: readonly GenerationTextModelOption[]
): GenerationTextModelRouting {
  const candidates = compiledGenerationTextRouteCandidates(config);
  const fast = preferredRoute(candidates.fast, configuredOptions);
  const balancedWriter = preferredRoute(candidates.balancedWriter, configuredOptions);
  const balancedJudgment = preferredRoute(candidates.balancedJudgment, configuredOptions);
  const premiumWriter = preferredRoute(candidates.premiumWriter, configuredOptions);
  const premiumJudgment = preferredRoute(candidates.premiumJudgment, configuredOptions);
  return {
    fastDecisions: null,
    fastDecisionsFallback: cloneSelection(fast.primary),
    fastJudgments: fast.primary,
    fastJudgmentsFallback: fast.fallback,
    fast: tierRoute(fast, fast),
    balanced: tierRoute(balancedWriter, balancedJudgment),
    premium: tierRoute(premiumWriter, premiumJudgment),
    ultra: tierRoute(premiumWriter, premiumJudgment)
  };
}

/**
 * Reads the nested `models` document without making credentials authoritative
 * over a saved choice. Removed credentials must leave the saved selection
 * visible to the admin UI as unavailable; only a missing/malformed leaf falls
 * back to the compiled routing.
 */
export function resolveGenerationTextModelRouting(
  storedSettings: unknown,
  compiled: GenerationTextModelRouting
): GenerationTextModelRouting {
  const settings = record(storedSettings);
  const stored = record(settings?.models);
  const fastJudgments = parseTextModelSelection(stored?.fastJudgments) ?? cloneSelection(compiled.fastJudgments);
  return materializeGenerationStages({
    fastDecisions: parseDecisionModelSelection(stored?.fastDecisions) ?? null,
    fastDecisionsFallback: parseTextModelSelection(stored?.fastDecisionsFallback) ?? cloneSelection(fastJudgments),
    fastJudgments,
    fastJudgmentsFallback:
      parseTextModelSelection(stored?.fastJudgmentsFallback) ??
      legacyFallback(fastJudgments, compiled.fastJudgments, compiled.fastJudgmentsFallback),
    fast: tierRouting(stored?.fast, compiled.fast),
    balanced: tierRouting(stored?.balanced, compiled.balanced),
    premium: tierRouting(stored?.premium, compiled.premium),
    ultra: tierRouting(stored?.ultra, compiled.ultra)
  });
}

export function routingSelection(
  routing: GenerationTextModelRouting,
  tier: ModelTier,
  role: GenerationTextModelRole
): TextModelSelection {
  return routing[tier][role];
}

export function routingFallbackSelection(
  routing: GenerationTextModelRouting,
  tier: ModelTier,
  role: GenerationTextModelRole
): TextModelSelection {
  return routing[tier][fallbackField(role)];
}

export function fallbackField(role: GenerationTextModelRole): "writerFallback" | "judgmentFallback" {
  return role === "writer" ? "writerFallback" : "judgmentFallback";
}

/** Stable value for adapter caches and browser select controls. */
export function textModelSelectionKey(selection: TextModelSelection): string {
  return JSON.stringify({
    provider: selection.provider,
    model: selection.model,
    ...(selection.thinkingBudget !== undefined ? { thinkingBudget: selection.thinkingBudget } : {}),
    ...(selection.thinkingEnabled !== undefined ? { thinkingEnabled: selection.thinkingEnabled } : {}),
    ...(selection.thinkingEffort !== undefined ? { thinkingEffort: selection.thinkingEffort } : {})
  });
}

export function sameTextModelSelection(a: TextModelSelection, b: TextModelSelection): boolean {
  return textModelSelectionKey(a) === textModelSelectionKey(b);
}

/** Model identity plus catalog-fixed flags; effort is the separately editable capability. */
export function generationTextModelOptionKey(selection: TextModelSelection): string {
  return JSON.stringify({
    provider: selection.provider,
    model: selection.model,
    ...(selection.thinkingBudget !== undefined ? { thinkingBudget: selection.thinkingBudget } : {}),
    ...(selection.thinkingEnabled !== undefined ? { thinkingEnabled: selection.thinkingEnabled } : {})
  });
}

/** Apply a catalog default effort without inventing reasoning for models that advertise none. */
export function selectionFromGenerationOption(option: GenerationTextModelOption): TextModelSelection {
  const defaultEffort = option.thinkingEfforts?.find((effort) => effort.default)?.value;
  return {
    provider: option.provider,
    model: option.model,
    ...(option.thinkingBudget !== undefined ? { thinkingBudget: option.thinkingBudget } : {}),
    ...(option.thinkingEnabled !== undefined ? { thinkingEnabled: option.thinkingEnabled } : {}),
    ...(defaultEffort !== undefined ? { thinkingEffort: defaultEffort } : {})
  };
}

function preferredOrNext(
  preferred: TextModelSelection,
  options: readonly GenerationTextModelOption[],
  alternates: readonly TextModelSelection[] = []
): TextModelSelection {
  for (const candidate of [preferred, ...alternates]) {
    const exact = options.find(
      (option) =>
        option.provider === candidate.provider &&
        option.model === candidate.model &&
        fixedReasoningMatches(option, candidate)
    );
    if (exact) {
      // Keep the historical spelling of the default (notably
      // thinkingEnabled:false) while using the catalog to prove availability.
      return cloneSelection(candidate);
    }
    const sameModel = options.find(
      (option) => option.provider === candidate.provider && option.model === candidate.model
    );
    if (sameModel) {
      return fixedReasoningSupported(sameModel, candidate)
        ? cloneSelection(candidate)
        : selectionFromGenerationOption(sameModel);
    }
  }
  const fallback = options[0];
  return fallback ? selectionFromGenerationOption(fallback) : cloneSelection(preferred);
}

function preferredRoute(
  candidates: readonly [TextModelSelection, ...TextModelSelection[]],
  options: readonly GenerationTextModelOption[]
): { primary: TextModelSelection; fallback: TextModelSelection } {
  const primary = preferredOrNext(candidates[0], options, candidates.slice(1));
  for (const candidate of candidates) {
    const available = availableSelection(candidate, options);
    if (available && !sameTextModelIdentity(primary, available)) {
      return { primary, fallback: available };
    }
  }
  const catalogFallback = options
    .map(selectionFromGenerationOption)
    .find((selection) => !sameTextModelIdentity(primary, selection));
  return { primary, fallback: catalogFallback ?? cloneSelection(primary) };
}

function availableSelection(
  candidate: TextModelSelection,
  options: readonly GenerationTextModelOption[]
): TextModelSelection | undefined {
  const exact = options.find(
    (option) =>
      option.provider === candidate.provider &&
      option.model === candidate.model &&
      fixedReasoningMatches(option, candidate)
  );
  if (exact) return cloneSelection(candidate);
  const sameModel = options.find(
    (option) => option.provider === candidate.provider && option.model === candidate.model
  );
  if (!sameModel) return undefined;
  return fixedReasoningSupported(sameModel, candidate)
    ? cloneSelection(candidate)
    : selectionFromGenerationOption(sameModel);
}

function tierRoute(
  writer: { primary: TextModelSelection; fallback: TextModelSelection },
  judgment: { primary: TextModelSelection; fallback: TextModelSelection }
): GenerationTextModelTierRouting {
  return {
    writer: cloneSelection(writer.primary),
    writerFallback: cloneSelection(writer.fallback),
    judgment: cloneSelection(judgment.primary),
    judgmentFallback: cloneSelection(judgment.fallback)
  };
}

function fixedReasoningSupported(
  option: GenerationTextModelOption,
  selection: TextModelSelection
): boolean {
  if (selection.thinkingBudget !== undefined) {
    // 0 disables thinking and is valid even when the catalog omits a budget (flash-lite).
    return option.thinkingBudget !== undefined || selection.thinkingBudget === 0;
  }
  if (selection.thinkingEnabled !== undefined) {
    return option.thinking === true || option.thinkingEnabled !== undefined || Boolean(option.thinkingEfforts?.length);
  }
  return true;
}

function fixedReasoningMatches(option: TextModelSelection, selection: TextModelSelection): boolean {
  return (
    option.thinkingBudget === selection.thinkingBudget &&
    option.thinkingEnabled === selection.thinkingEnabled
  );
}

function tierRouting(value: unknown, fallback: GenerationTextModelTierRouting): GenerationTextModelTierRouting {
  const stored = record(value);
  const writer = parseTextModelSelection(stored?.writer) ?? cloneSelection(fallback.writer);
  const judgment = parseTextModelSelection(stored?.judgment) ?? cloneSelection(fallback.judgment);
  const stages: GenerationStageRoutes = {};
  const rawStages = record(stored?.stages);
  if (stored?.stages !== undefined && !rawStages) throw new Error("Invalid saved stage model settings.");
  for (const { id } of GENERATION_MODEL_STAGES) {
    if (rawStages?.[id] === undefined) continue;
    const raw = record(rawStages?.[id]);
    if (!raw) throw new Error(`Invalid saved model route for stage ${id}.`);
    const primary = parseDecisionModelSelection(raw.primary);
    const stageFallback = parseTextModelSelection(raw.fallback);
    // A present broken setting must not silently route an expensive call elsewhere.
    if (!primary || !stageFallback || (isJevSelection(primary) && !stageSupportsFiniteDecisions(id))) throw new Error(`Invalid saved model route for stage ${id}.`);
    stages[id] = { primary, fallback: stageFallback };
  }
  return {
    writer,
    stages,
    writerFallback:
      parseTextModelSelection(stored?.writerFallback) ??
      legacyFallback(writer, fallback.writer, fallback.writerFallback),
    judgment,
    judgmentFallback:
      parseTextModelSelection(stored?.judgmentFallback) ??
      legacyFallback(judgment, fallback.judgment, fallback.judgmentFallback)
  };
}

function legacyFallback(
  primary: TextModelSelection,
  compiledPrimary: TextModelSelection,
  compiledFallback: TextModelSelection
): TextModelSelection {
  if (!sameTextModelIdentity(primary, compiledFallback)) return cloneSelection(compiledFallback);
  if (!sameTextModelIdentity(primary, compiledPrimary)) return cloneSelection(compiledPrimary);
  return cloneSelection(compiledFallback);
}

function sameTextModelIdentity(a: TextModelSelection, b: TextModelSelection): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/** Reads a stored or wire selection; malformed leaves fall through to compiled routing. */
export function parseTextModelSelection(value: unknown): TextModelSelection | undefined {
  const candidate = record(value);
  if (!candidate || typeof candidate.model !== "string" || !textProvider(candidate.provider)) {
    return undefined;
  }
  const model = candidate.model.trim();
  if (!model) {
    return undefined;
  }
  const thinkingBudget = candidate.thinkingBudget;
  const thinkingEnabled = candidate.thinkingEnabled;
  const thinkingEffort = candidate.thinkingEffort;
  if (
    (thinkingBudget !== undefined &&
      (typeof thinkingBudget !== "number" || !Number.isInteger(thinkingBudget) || thinkingBudget < -1 || thinkingBudget > 32768)) ||
    (thinkingEnabled !== undefined && typeof thinkingEnabled !== "boolean") ||
    (thinkingEffort !== undefined && !thinkingEfforts().has(thinkingEffort))
  ) {
    return undefined;
  }
  return {
    provider: candidate.provider,
    model,
    ...(typeof thinkingBudget === "number" ? { thinkingBudget } : {}),
    ...(typeof thinkingEnabled === "boolean" ? { thinkingEnabled } : {}),
    ...(typeof thinkingEffort === "string" ? { thinkingEffort: thinkingEffort as TextModelThinkingEffort } : {})
  };
}

function textProvider(value: unknown): value is TextModelSelection["provider"] {
  return (
    value === "deepseek" ||
    value === "deepinfra" ||
    value === "openrouter" ||
    value === "gemini" ||
    value === "alibaba" ||
    value === "openai" ||
    value === "openai-compatible"
  );
}

function thinkingEfforts(): ReadonlySet<unknown> {
  return new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
}

function cloneSelection(selection: TextModelSelection): TextModelSelection {
  return { ...selection };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
