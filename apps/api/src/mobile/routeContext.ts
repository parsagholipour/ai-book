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
  DEFAULT_GENERATION_RATE_LIMIT
} from "./schemas.js";
import {
  createFastRoutingTextModel,
  createFileDigestAdapter,
  createLanguageDetectionTextModel,
  createResearchAdapter,
  ingestCreationAttachment,
  loadConfig,
  type CreationAttachment,
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
  /** Test seam for attachment ingestion; defaults to the core pipeline. */
  attachmentIngestion?: (input: IngestCreationAttachmentInput) => Promise<CreationAttachment>;
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
  attachmentIngestion: (input: IngestCreationAttachmentInput) => Promise<CreationAttachment>;
  safeFastRoutingTextModel: () => TextModelAdapter | undefined;
  advisorEnrichment:
    | ((payload: MobileCreationDraftPayload, base: MobileBookAdvisorResponse) => Promise<Partial<MobileBookAdvisorResponse>>)
    | undefined;
  creationEnrichment:
    | ((request: MobileCreationTurnRequest, base: MobileCreationTurn) => Promise<Partial<MobileCreationTurn>>)
    | undefined;
};

export function createMobileRouteContext(options: MobileProjectRoutesOptions): MobileRouteContext {
  const appConfig = loadConfig();
  const safeFastRoutingTextModel = (): TextModelAdapter | undefined => {
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
  const attachmentIngestion =
    options.attachmentIngestion ??
    ((input: IngestCreationAttachmentInput) =>
      ingestCreationAttachment(input, {
        fileDigest: createFileDigestAdapter(appConfig),
        summaryModel: safeFastRoutingTextModel()
      }));
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

  return {
    options,
    appConfig,
    googlePlayVerifier,
    generationLimiter,
    billingVerificationLimiter,
    advisorLimiter,
    draftLimiter,
    attachmentLimiter,
    attachmentIngestion,
    safeFastRoutingTextModel,
    advisorEnrichment,
    creationEnrichment,
  };
}
