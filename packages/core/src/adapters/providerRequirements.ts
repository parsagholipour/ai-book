import type { AppConfig } from "../config.js";
import type { ImageModelSelection, TextModelSelection } from "../schemas/book.js";
import type { VoiceChatProviderId } from "../voiceProviders.js";
import {
  audiobookSpeechSelections,
  defaultImageModelSelection,
  imageModelOptions,
  resolveImageFallbackSelection,
  type SpeechProviderId
} from "./factory.js";
import {
  compiledGenerationTextRouteCandidates,
  GENERATION_MODEL_STAGES,
  GENERATION_TEXT_MODEL_ROUTE_FIELDS,
  GENERATION_TEXT_MODEL_TIERS,
  isJevSelection,
  type CompiledGenerationTextRouteCandidates,
  type DecisionModelSelection,
  type GenerationTextModelRouting
} from "./generationTextModelRouting.js";
import { premiumCoverImageSelection } from "./modelTiers.js";
import {
  PROVIDER_CREDENTIALS,
  PROVIDER_LABELS,
  providerConfigured,
  type ProviderAccount
} from "./providerCredentials.js";

/**
 * Which provider keys a deployment must carry, read off the routing rather
 * than written down beside it.
 *
 * Text comes from the compiled defaults' preference lists
 * (`compiledGenerationTextRouteCandidates`): a provider named anywhere in them
 * is one a default route lands on, first or as the fallback the next provider
 * down the list becomes. Images come from the default and tier selections, the
 * premium cover, every model a book may name explicitly, and the fallback rule
 * `FallbackImageAdapter` is built with. Narration comes from the audiobook's
 * speech providers, voice calls from the configured and the app's voice
 * provider. Embeddings, grounded search and OCR have no routing at all; they
 * are pinned against the adapters `createProviders` builds in the test.
 *
 * The Quality tab can save a different routing at runtime. That routing is
 * checked at boot too (`routedProvidersWithoutCredentials`), but as a warning:
 * the operator moves a route from the console, and the console needs the API
 * running.
 */

type ProviderUse = {
  provider: ProviderAccount;
  use: string;
  /** A setting that turns this use off, when there is one. */
  optOut?: string;
};

export type ProviderRequirement = {
  provider: ProviderAccount;
  label: string;
  /** The settings the provider needs. Names only. */
  variables: readonly string[];
  /** What the default routing sends to it, in plain words. */
  uses: string[];
  /** Set when every use has a switch that turns it off instead. */
  optOut?: string;
};

const TEXT_ROUTE_USES: Record<keyof CompiledGenerationTextRouteCandidates, string> = {
  fast: "Quick Draft text and the fast judgments",
  balancedWriter: "Balanced writing",
  balancedJudgment: "Balanced reviews",
  premiumWriter: "Premium and Ultra writing",
  premiumJudgment: "Premium and Ultra reviews"
};

const SPEECH_PROVIDER_ACCOUNTS: Record<SpeechProviderId, ProviderAccount> = {
  gemini_tts: "gemini",
  openai_tts: "openai"
};

const VOICE_PROVIDER_ACCOUNTS: Record<VoiceChatProviderId, ProviderAccount> = {
  gemini_live: "gemini",
  openai_realtime: "openai"
};

/** The provider the app's voice-call relay always opens (`apps/api/src/mobile/routeContext.ts`). */
const APP_VOICE_CALL_PROVIDER: VoiceChatProviderId = "gemini_live";

/**
 * Work built on one provider with nothing to route: `createProviders` gives
 * every book a Gemini embedding and research adapter, and source OCR, character
 * photos and chat attachments are read by Gemini. Pinned by
 * `providerRequirements.test.ts` against what `createProviders` constructs.
 */
export const FIXED_PROVIDER_USES: readonly ProviderUse[] = [
  { provider: "gemini", use: "embeddings (page memory)" },
  { provider: "gemini", use: "grounded web search" },
  { provider: "gemini", use: "OCR, character photos and chat attachments" }
];

function defaultRoutingProviderUses(config: AppConfig): ProviderUse[] {
  const uses: ProviderUse[] = [];

  const textCandidates = compiledGenerationTextRouteCandidates(config);
  for (const route of Object.keys(textCandidates) as Array<keyof CompiledGenerationTextRouteCandidates>) {
    for (const candidate of textCandidates[route] as readonly TextModelSelection[]) {
      uses.push({ provider: candidate.provider, use: TEXT_ROUTE_USES[route] });
    }
  }

  const drawnByDefault: ImageModelSelection[] = [
    defaultImageModelSelection(config),
    ...GENERATION_TEXT_MODEL_TIERS.map((tier) => defaultImageModelSelection(config, tier)),
    premiumCoverImageSelection()
  ];
  const selectable: ImageModelSelection[] = imageModelOptions(config).map(({ provider, model }) => ({ provider, model }));
  for (const primary of drawnByDefault) {
    uses.push({ provider: primary.provider, use: "illustrations and covers" });
  }
  for (const primary of selectable) {
    uses.push({ provider: primary.provider, use: "illustrations on an image model a book selects" });
  }
  for (const primary of [...drawnByDefault, ...selectable]) {
    for (const premium of [false, true]) {
      uses.push({
        provider: resolveImageFallbackSelection(config, primary, premium).provider,
        use: "illustrations when the other image provider fails"
      });
    }
  }

  const [narration, ...narrationFallbacks] = audiobookSpeechSelections(config);
  if (narration) {
    uses.push({ provider: SPEECH_PROVIDER_ACCOUNTS[narration.provider], use: "audiobook narration" });
  }
  for (const fallback of narrationFallbacks) {
    uses.push({
      provider: SPEECH_PROVIDER_ACCOUNTS[fallback.provider],
      use: "audiobook narration once Gemini's speech quota runs out",
      optOut: "AUDIOBOOK_OPENAI_FALLBACK_ENABLED=false"
    });
  }

  for (const voice of new Set([APP_VOICE_CALL_PROVIDER, config.VOICE_CHAT_PROVIDER])) {
    uses.push({ provider: VOICE_PROVIDER_ACCOUNTS[voice], use: "character voice calls" });
  }

  return [...uses, ...FIXED_PROVIDER_USES];
}

/** Every provider the default routing can select, with what it is used for. */
export function defaultRoutingProviderRequirements(config: AppConfig): ProviderRequirement[] {
  const byProvider = new Map<ProviderAccount, ProviderUse[]>();
  for (const use of defaultRoutingProviderUses(config)) {
    byProvider.set(use.provider, [...(byProvider.get(use.provider) ?? []), use]);
  }
  return [...byProvider].map(([provider, uses]) => {
    const optOuts = [...new Set(uses.map((use) => use.optOut))];
    const optOut = optOuts.length === 1 ? optOuts[0] : undefined;
    return {
      provider,
      label: PROVIDER_LABELS[provider],
      variables: PROVIDER_CREDENTIALS[provider],
      uses: [...new Set(uses.map((use) => use.use))],
      ...(optOut ? { optOut } : {})
    };
  });
}

/** The default-routing providers this deployment has no key for. Nothing under MOCK_AI, which calls none. */
export function missingProviderCredentials(config: AppConfig): ProviderRequirement[] {
  if (config.MOCK_AI) {
    return [];
  }
  return defaultRoutingProviderRequirements(config).filter(
    (requirement) => !providerConfigured(config, requirement.provider)
  );
}

export type UnkeyedRoutedProvider = {
  provider: ProviderAccount;
  label: string;
  variables: readonly string[];
  /** Where the routing names it, e.g. `balanced.writer`, `fast.stages.compose-chapter.fallback`. */
  routes: string[];
};

/**
 * The providers a resolved routing (the Quality tab's saved revision over the
 * compiled defaults) sends calls to without a key in this process. Those calls
 * fail at generation time; a saved selection stays saved when its key is
 * removed, by design (`resolveGenerationTextModelRouting`).
 */
export function routedProvidersWithoutCredentials(
  config: AppConfig,
  routing: GenerationTextModelRouting
): UnkeyedRoutedProvider[] {
  if (config.MOCK_AI) {
    return [];
  }
  const routes = new Map<ProviderAccount, string[]>();
  const visit = (selection: DecisionModelSelection | null | undefined, path: string) => {
    if (!selection || providerConfigured(config, selection.provider)) {
      return;
    }
    routes.set(selection.provider, [...(routes.get(selection.provider) ?? []), path]);
  };
  visit(routing.fastDecisions, "fastDecisions");
  if (isJevSelection(routing.fastDecisions)) {
    visit(routing.fastDecisionsFallback, "fastDecisionsFallback");
  }
  visit(routing.fastJudgments, "fastJudgments");
  visit(routing.fastJudgmentsFallback, "fastJudgmentsFallback");
  for (const tier of GENERATION_TEXT_MODEL_TIERS) {
    for (const field of GENERATION_TEXT_MODEL_ROUTE_FIELDS) {
      visit(routing[tier][field], `${tier}.${field}`);
    }
    for (const { id } of GENERATION_MODEL_STAGES) {
      const stage = routing[tier].stages?.[id];
      visit(stage?.primary, `${tier}.stages.${id}.primary`);
      visit(stage?.fallback, `${tier}.stages.${id}.fallback`);
    }
  }
  return [...routes].map(([provider, paths]) => ({
    provider,
    label: PROVIDER_LABELS[provider],
    variables: PROVIDER_CREDENTIALS[provider],
    routes: paths
  }));
}

const ROUTES_SHOWN = 6;

/** One log line per unkeyed provider. Names settings and routes, never a value. */
export function unkeyedRoutedProviderMessage(gap: UnkeyedRoutedProvider): string {
  const shown = gap.routes.slice(0, ROUTES_SHOWN).join(", ");
  const more = gap.routes.length > ROUTES_SHOWN ? ` and ${gap.routes.length - ROUTES_SHOWN} more` : "";
  return (
    `The saved Quality-tab model routing sends ${gap.routes.length} route(s) to ${gap.label} ` +
    `(${shown}${more}), but ${gap.variables.join(" and ")} is not set: those calls fail, and fail ` +
    `the books that make them. Set the key, or move the routes in the operator console's Quality tab.`
  );
}
