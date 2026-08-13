import { createGooglePlayVerifierFromConfig, type GooglePlayVerifier } from "../googlePlayBilling.js";
import {
  enrichAdvisorWithAi,
  enrichCreationTurnWithSearch,
  type MobileBookAdvisorResponse,
  type MobileCreationDraftPayload,
  type MobileCreationTurn,
  type MobileCreationTurnRequest
} from "../mobileCreation.js";
import { InMemoryRateLimiter, type RateLimitConfig } from "../rateLimit.js";
import {
  DEFAULT_ADVISOR_RATE_LIMIT,
  DEFAULT_ATTACHMENT_RATE_LIMIT,
  DEFAULT_BILLING_VERIFICATION_RATE_LIMIT,
  DEFAULT_DRAFT_RATE_LIMIT,
  DEFAULT_GENERATION_RATE_LIMIT,
  DEFAULT_VOICE_CALL_RATE_LIMIT
} from "./schemas.js";
import {
  createCharacterPhotoVisionAdapter,
  createFastRoutingTextModel,
  createFileDigestAdapter,
  createLanguageDetectionTextModel,
  createResearchAdapter,
  createVoiceProvider,
  ingestCreationAttachment,
  loadConfig,
  type CharacterPhotoVisionRequest,
  type CharacterPhotoVisionResult,
  type CreateGeminiLiveSessionRequest,
  type CreationAttachment,
  type GeminiLiveSessionResponse,
  type IngestCreationAttachmentInput,
  type ResearchAdapter,
  type TextModelAdapter
} from "@book-maker/core";

/**
 * Shared setup for every mobile route group: config, rate limiters, the Google
 * Play verifier, and the optional AI enrichment hooks that tests override.
 */

export type MobileProjectRoutesOptions = {
  googlePlayVerifier?: GooglePlayVerifier | undefined;
  generationRateLimit?: Partial<RateLimitConfig>;
  billingVerificationRateLimit?: Partial<RateLimitConfig>;
  advisorRateLimit?: Partial<RateLimitConfig>;
  draftRateLimit?: Partial<RateLimitConfig>;
  attachmentRateLimit?: Partial<RateLimitConfig>;
  voiceCallRateLimit?: Partial<RateLimitConfig>;
  /** Test seam for attachment ingestion; defaults to the core pipeline. */
  attachmentIngestion?: (input: IngestCreationAttachmentInput) => Promise<CreationAttachment>;
  /**
   * Test seam for the chat router's text model; defaults to the config-derived
   * fast model. Image requests have no model-free fast path, so suites that
   * exercise the add_image flow inject a canned decide-tool model here.
   */
  routingTextModel?: TextModelAdapter;
  /**
   * Test seam for reading a character photo. Undefined is the real behaviour
   * with no vision provider configured, and the upload degrades to storing the
   * file — so leaving it unset is a supported production state, not just a
   * test one.
   */
  characterPhotoVision?:
    | false
    | ((request: CharacterPhotoVisionRequest) => Promise<CharacterPhotoVisionResult>);
  /** Overrides `CHARACTER_PHOTO_VISION_BUDGET_MS`; only tests need this. */
  characterPhotoVisionBudgetMs?: number;
  advisorTimeoutMs?: number;
  advisorEnrichment?:
    | false
    | ((payload: MobileCreationDraftPayload, base: MobileBookAdvisorResponse) => Promise<Partial<MobileBookAdvisorResponse>>);
  creationTurnTimeoutMs?: number;
  creationSearchTimeoutMs?: number;
  creationResearch?: ResearchAdapter;
  creationEnrichment?:
    | false
    | ((request: MobileCreationTurnRequest, base: MobileCreationTurn) => Promise<Partial<MobileCreationTurn>>);
  pageCountRecommendationTimeoutMs?: number;
  /** Test seam for minting Gemini Live call tokens; defaults to the core provider. */
  voiceSession?: (request: CreateGeminiLiveSessionRequest) => Promise<GeminiLiveSessionResponse>;
};

export type MobileRouteContext = {
  options: MobileProjectRoutesOptions;
  appConfig: ReturnType<typeof loadConfig>;
  googlePlayVerifier: GooglePlayVerifier;
  generationLimiter: InMemoryRateLimiter;
  billingVerificationLimiter: InMemoryRateLimiter;
  advisorLimiter: InMemoryRateLimiter;
  draftLimiter: InMemoryRateLimiter;
  attachmentLimiter: InMemoryRateLimiter;
  voiceCallLimiter: InMemoryRateLimiter;
  attachmentIngestion: (input: IngestCreationAttachmentInput) => Promise<CreationAttachment>;
  characterPhotoVision:
    | ((request: CharacterPhotoVisionRequest) => Promise<CharacterPhotoVisionResult>)
    | undefined;
  safeFastRoutingTextModel: () => TextModelAdapter | undefined;
  advisorEnrichment:
    | ((payload: MobileCreationDraftPayload, base: MobileBookAdvisorResponse) => Promise<Partial<MobileBookAdvisorResponse>>)
    | undefined;
  creationEnrichment:
    | ((request: MobileCreationTurnRequest, base: MobileCreationTurn) => Promise<Partial<MobileCreationTurn>>)
    | undefined;
  voiceSession: (request: CreateGeminiLiveSessionRequest) => Promise<GeminiLiveSessionResponse>;
};

export function createMobileRouteContext(options: MobileProjectRoutesOptions): MobileRouteContext {
  const appConfig = loadConfig();
  const safeFastRoutingTextModel = (): TextModelAdapter | undefined => {
    if (options.routingTextModel) {
      return options.routingTextModel;
    }
    try {
      return createFastRoutingTextModel(appConfig);
    } catch {
      return undefined;
    }
  };
  const googlePlayVerifier = options.googlePlayVerifier ?? createGooglePlayVerifierFromConfig(appConfig);
  const generationLimiter = new InMemoryRateLimiter({
    ...DEFAULT_GENERATION_RATE_LIMIT,
    ...options.generationRateLimit
  });
  const billingVerificationLimiter = new InMemoryRateLimiter({
    ...DEFAULT_BILLING_VERIFICATION_RATE_LIMIT,
    ...options.billingVerificationRateLimit
  });
  const advisorLimiter = new InMemoryRateLimiter({
    ...DEFAULT_ADVISOR_RATE_LIMIT,
    ...options.advisorRateLimit
  });
  const draftLimiter = new InMemoryRateLimiter({
    ...DEFAULT_DRAFT_RATE_LIMIT,
    ...options.draftRateLimit
  });
  const attachmentLimiter = new InMemoryRateLimiter({
    ...DEFAULT_ATTACHMENT_RATE_LIMIT,
    ...options.attachmentRateLimit
  });
  const voiceCallLimiter = new InMemoryRateLimiter({
    ...DEFAULT_VOICE_CALL_RATE_LIMIT,
    ...options.voiceCallRateLimit
  });
  const attachmentIngestion =
    options.attachmentIngestion ??
    ((input: IngestCreationAttachmentInput) =>
      ingestCreationAttachment(input, {
        fileDigest: createFileDigestAdapter(appConfig),
        summaryModel: safeFastRoutingTextModel()
      }));
  const characterPhotoVision =
    options.characterPhotoVision === false
      ? undefined
      : options.characterPhotoVision ??
        (() => {
          // Built once, here, rather than per request: the route must never
          // reach for a provider factory itself, and a deployment with no
          // vision key simply has no reader.
          const adapter = createCharacterPhotoVisionAdapter(appConfig);
          return adapter ? (request: CharacterPhotoVisionRequest) => adapter.describeCharacterPhoto(request) : undefined;
        })();
  const advisorEnrichment =
    options.advisorEnrichment === false
      ? undefined
      : options.advisorEnrichment ??
        ((payload: MobileCreationDraftPayload, base: MobileBookAdvisorResponse) =>
          enrichAdvisorWithAi(createLanguageDetectionTextModel(appConfig), payload, base));
  const creationEnrichment =
    options.creationEnrichment === false
      ? undefined
      : options.creationEnrichment ??
        ((request: MobileCreationTurnRequest, base: MobileCreationTurn) =>
          enrichCreationTurnWithSearch(
            {
              textModel: createLanguageDetectionTextModel(appConfig),
              research: options.creationResearch ?? (() => createResearchAdapter(appConfig)),
              searchTimeoutMs: options.creationSearchTimeoutMs
            },
            request,
            base
          ));

  const voiceSession =
    options.voiceSession ??
    (async (request: CreateGeminiLiveSessionRequest) => {
      const session = await createVoiceProvider(appConfig, "gemini_live").createRealtimeSession(request);
      if (session.type !== "gemini_live_token") {
        throw new Error("Gemini Live returned an unexpected voice session.");
      }
      return session;
    });

  return {
    options,
    appConfig,
    googlePlayVerifier,
    generationLimiter,
    billingVerificationLimiter,
    advisorLimiter,
    draftLimiter,
    attachmentLimiter,
    voiceCallLimiter,
    attachmentIngestion,
    characterPhotoVision,
    safeFastRoutingTextModel,
    advisorEnrichment,
    creationEnrichment,
    voiceSession
  };
}
