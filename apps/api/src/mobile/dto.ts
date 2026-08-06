import { type CreationChatBranchDto } from "../creationChatTree.js";
import {
  type MobileBookAdvisorResponse,
  type MobileBookTypeChoice,
  type MobileCreationBrief,
  type MobileCreationDraftPayload,
  type MobileCreationMessage,
  type MobileCreationTurn,
  type MobilePageCountMode,
  type MobilePageCountSource
} from "../mobileCreation.js";
import { buildProjectStatus, type ProjectQualityStatus } from "../projectStatus.js";
import { type ProjectExportFormat } from "../routes/projects.js";
import {
  mobileBookTypeSchema,
  mobileCreationBuildBodySchema,
  mobileLengthPresetSchema,
  mobileQualityPresetSchema
} from "./schemas.js";
import { type CoverArtSource, type CreateProjectInput, type CreditPricing, type PlanTier } from "@book-maker/core";
import { InsufficientCreditsError } from "@book-maker/db/billing";
import { z } from "zod";

/**
 * Response DTOs and the Prisma row shapes they are built from. Types only.
 */

export type MobileBookType = z.infer<typeof mobileBookTypeSchema>;

export type MobileLengthPreset = z.infer<typeof mobileLengthPresetSchema>;

export type MobileQualityPreset = z.infer<typeof mobileQualityPresetSchema>;

export type MobileJsonValue = string | number | boolean | null | MobileJsonValue[] | { [key: string]: MobileJsonValue };

export type MobileProjectCreateRequestDto = {
  bookType: MobileBookType;
  bookTypeChoice?: MobileBookTypeChoice | undefined;
  title?: string | undefined;
  authorName?: string | undefined;
  prompt: string;
  lengthPreset?: MobileLengthPreset | undefined;
  qualityPreset?: MobileQualityPreset | undefined;
  /** @deprecated Use coverEnabled and illustrationsEnabled. */
  imagesEnabled?: boolean | undefined;
  coverEnabled?: boolean | undefined;
  illustrationsEnabled?: boolean | undefined;
  pageCountMode?: MobilePageCountMode | undefined;
  targetPages?: number | undefined;
  pageCountSource?: MobilePageCountSource | undefined;
  language?: string | undefined;
  creationBrief?: MobileCreationBrief | undefined;
  creationPayload?: MobileCreationDraftPayload | undefined;
  advisor?: MobileBookAdvisorResponse | undefined;
};

export type MobileProjectSummaryDto = {
  id: string;
  title: string;
  subtitle: string | null;
  authorName: string | null;
  bookType: MobileBookType | "custom";
  lengthPreset: MobileLengthPreset | "custom";
  qualityPreset: MobileQualityPreset | "custom";
  /** Compatibility aggregate: coverEnabled || illustrationsEnabled. */
  imagesEnabled: boolean;
  /** True only for AI cover artwork; see coverArtSource. */
  coverEnabled: boolean;
  illustrationsEnabled: boolean;
  /** "ai" drew the cover, "design" picked a bundled one for free, "none" has no cover. */
  coverArtSource: CoverArtSource;
  status: string;
  statusLabel: string;
  progressPercent: number;
  currentAction: string;
  promptPreview: string;
  targetPages: number;
  pageCount: number;
  imageCount: number;
  hasPlan: boolean;
  /** "imported" for books brought in by the author, "generated" otherwise. */
  source: "imported" | "generated";
  /**
   * Cover art, when the project has one. Present on summaries so the mobile
   * library can render a real bookshelf instead of placeholder tiles; null
   * until the cover image job finishes.
   */
  coverImage: MobileProjectImageDto | null;
  exports: MobileExportSetDto;
  createdAt: string;
  updatedAt: string;
};

export type MobileProjectDetailDto = MobileProjectSummaryDto & {
  prompt: string;
  language: string;
  plan: MobilePlanDto | null;
  pages: MobileProjectPageDto[];
  quality: ProjectQualityStatus;
};

export type MobileProjectCreateResponseDto = {
  project: MobileProjectDetailDto;
};

export type MobileCreationDraftDto = {
  id: string;
  revision: number;
  requestId: string | null;
  status: string;
  payload: MobileCreationDraftPayload;
  advisorSnapshot: MobileBookAdvisorResponse | null;
  createdProjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MobileCreationDraftResponseDto = {
  draft: MobileCreationDraftDto | null;
};

/**
 * Wire shape of one creation chat message: the stored message plus branch
 * position when siblings exist. The internal isActiveChild flag never leaves
 * the server.
 */
export type MobileCreationMessageDto = {
  id: string;
  parentId: string | null;
  role: "user" | "assistant";
  content: string;
  attachments?: MobileCreationMessage["attachments"];
  research?: MobileCreationMessage["research"];
  /** The quoted earlier message, when this turn was sent as a reply. */
  replyTo?: MobileCreationMessage["replyTo"];
  branch: CreationChatBranchDto | null;
};

export type MobileCreationSessionDto = {
  draftId: string;
  revision: number;
  title: string;
  status: string;
  messages: MobileCreationMessageDto[];
  createdProjectId: string | null;
  activeProjectId: string | null;
  outputs: MobileCreationOutputDto[];
  /** Uploaded files (display metadata only; digested content stays server-side). */
  attachments: MobileCreationAttachmentDto[];
  updatedAt: string;
};

export type MobileCreationAttachmentDto = {
  id: string;
  kind: "document" | "photo";
  name: string;
  mimeType: string;
  sizeBytes: number;
  summary: string;
  pages: number | null;
  truncated: boolean;
  createdAt: string;
  /** API path serving the stored original file (kept 6 months, then removed). */
  url: string;
};

export type MobileCreationAttachmentResponseDto = {
  attachment: MobileCreationAttachmentDto;
};

export type MobileCreationOutputDto = {
  id: string;
  draftId: string;
  projectId: string;
  requestId?: string | null;
  title: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
};

export type MobileCreationConversationResponseDto = {
  session: MobileCreationSessionDto | null;
  turn: MobileCreationTurn;
};

export type MobileBookAdvisorResponseDto = {
  advisor: MobileBookAdvisorResponse;
};

export type MobilePageCountRecommendationDto = {
  targetPages: number;
  label: string;
  description: string;
};

export type MobileCreationBuildPreflightResponseDto = {
  requiresPageCount: boolean;
  detectedPageCount: { targetPages: number; source: MobilePageCountSource } | null;
  recommendations: MobilePageCountRecommendationDto[];
};

export type MobileCreationFinalizeResponseDto = {
  project: MobileProjectDetailDto;
  output: MobileCreationOutputDto;
  operation: MobilePlanOperationDto | null;
  sessionRevision: number;
};

export type FinalizeOutcome =
  | { ok: true; project: MobileProjectDetailDto; output: MobileCreationOutputDto; operation: MobilePlanOperationDto | null; sessionRevision: number }
  | { ok: false; status: number; code: string; message: string }
  | { ok: false; insufficient: InsufficientCreditsError };

export type MobilePageCountResolution =
  | { resolved: true; targetPages: number; source: MobilePageCountSource; mode: MobilePageCountMode }
  | { resolved: false };

export type MobilePlanDto = {
  id: string;
  projectId: string;
  version: number;
  status: "draft" | "approved" | "superseded";
  title: string;
  subtitle: string | null;
  premise: string;
  audience: string;
  questions: Array<{ prompt: string; options: string[]; allowCustom: boolean }>;
  chapters: Array<{ index: number; title: string; summary: string; targetPages: number }>;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
};

export type MobileProjectPageDto = {
  id: string;
  index: number;
  title: string;
  summary: string;
  previewText: string;
  status: string;
  image: MobileProjectImageDto | null;
};

export type MobileProjectImageDto = {
  id: string;
  role: "cover" | "page_visual" | "character";
  url: string;
  contentType: string;
  altText: string;
  pageId: string | null;
};

export type MobilePlanRevisionRequestDto = {
  message: string;
};

export type MobilePlanOperationDto = {
  projectId: string;
  planId: string | null;
  status: "planning_queued" | "revision_queued" | "generation_queued";
  currentAction: string;
  job: MobileQueuedJobDto;
};

export type MobilePlanRevisionResponseDto = MobilePlanOperationDto;

export type MobileProjectChatMessageDto = {
  id: string;
  projectId: string;
  parentId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  operationId: string | null;
  metadata: MobileJsonValue;
  branch: MobileProjectChatBranchDto | null;
  createdAt: string;
};

export type MobileProjectChatBranchDto = {
  index: number;
  total: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
};

export type MobileBookEditOperationDto = {
  id: string;
  projectId: string;
  kind: "plan_revision" | "local_patch" | "page_rewrite" | "chapter_regenerate" | "book_replan" | "manual_edit";
  status: "queued" | "active" | "applied" | "failed" | "canceled";
  affectedPageIndexes: number[];
  creditsCharged: number;
  currentAction: string;
  error: string | null;
  job: MobileQueuedJobDto | null;
  retryAvailable: boolean;
  nextRetryAt: string | null;
  retryState: "scheduled" | "available" | "exhausted" | null;
  retryMessage: string | null;
  submittedText: string | null;
  requestId: string | null;
  createdAt: string;
  appliedAt: string | null;
  /**
   * The transcript message this operation belongs under, so the app can render its
   * outcome in place instead of pinning it below newer messages. Null for operations
   * with no chat anchor (older rows, or edits made outside the chat).
   */
  anchorMessageId: string | null;
  /** True when this applied edit is the latest undoable snapshot-backed change. */
  canUndo: boolean;
  /** True when before/after page snapshots exist, so the edit can be reviewed. */
  changesAvailable: boolean;
  /**
   * True when the credits this operation reserved were given back. A failed
   * operation is refunded, so reporting `creditsCharged` next to it without
   * this reads as a charge the user never actually paid.
   */
  creditsRefunded: boolean;
};

export type MobileEditDiffRunDto = {
  type: "equal" | "insert" | "delete";
  text: string;
};

export type MobileEditDiffBlockDto = {
  type: "unchanged" | "added" | "removed" | "changed";
  runs: MobileEditDiffRunDto[];
};

export type MobileEditPageChangeDto = {
  pageIndex: number;
  titleBefore: string;
  titleAfter: string;
  titleChanged: boolean;
  blocks: MobileEditDiffBlockDto[];
  addedWords: number;
  removedWords: number;
};

/** What one applied edit did to the book, page by page. */
export type MobileEditChangesDto = {
  operationId: string;
  kind: MobileBookEditOperationDto["kind"];
  status: MobileBookEditOperationDto["status"];
  request: string;
  creditsCharged: number;
  appliedAt: string | null;
  undone: boolean;
  pages: MobileEditPageChangeDto[];
  addedWords: number;
  removedWords: number;
};

export type MobileProjectChatResponseDto = {
  messages: MobileProjectChatMessageDto[];
  plans: MobilePlanDto[];
  operations: MobileBookEditOperationDto[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type MobileProjectChatMessageResponseDto = MobileProjectChatResponseDto & {
  reply: MobileProjectChatMessageDto;
  operation: MobileBookEditOperationDto | null;
};

export type MobileEditableBookPageDto = {
  id: string;
  index: number;
  title: string;
  markdown: string;
  revision: number;
};

export type MobileEditableBookDto = {
  projectId: string;
  title: string;
  pages: MobileEditableBookPageDto[];
};

export type MobileManualBookEditResponseDto = MobileProjectChatResponseDto & {
  savedExportMessage: MobileProjectChatMessageDto;
  operation: MobileBookEditOperationDto;
};

export type MobileProjectRecoveryDto = {
  projectId: string;
  status: "recovery_started";
  currentAction: string;
  resumedActions: number;
  skippedActions: number;
  stoppingActions: number;
};

export type MobileQueuedJobDto = {
  id: string;
  status: "queued" | "active" | "completed" | "failed" | "canceled";
  currentAction: string;
};

export type MobileProjectStatusDto = {
  projectId: string;
  /** Compatibility aggregate: coverEnabled || illustrationsEnabled. */
  imagesEnabled: boolean;
  /** True only for AI cover artwork; see coverArtSource. */
  coverEnabled: boolean;
  illustrationsEnabled: boolean;
  /** "ai" drew the cover, "design" picked a bundled one for free, "none" has no cover. */
  coverArtSource: CoverArtSource;
  status: string;
  statusLabel: string;
  progressPercent: number;
  currentAction: string;
  planningProgress: {
    percent: number;
    steps: Array<{
      key: "understand" | "shape" | "finalize";
      label: string;
      status: "pending" | "active" | "done" | "failed";
    }>;
  } | null;
  /**
   * Live milestones for the book itself, once a plan is approved. A superset of
   * `planningProgress`: writing has far more meaningful sub-states than
   * planning, so `detail` carries the phrase for what is happening right now.
   */
  generationProgress: {
    percent: number;
    detail: string | null;
    steps: Array<{
      key: "prepare" | "write" | "illustrate" | "finish";
      label: string;
      status: "pending" | "active" | "done" | "failed";
      detail: string | null;
    }>;
  } | null;
  /**
   * Live milestones for an edit to a finished book. Shaped like
   * `generationProgress` but kept separate: editing a book and writing one are
   * different stories with different steps, and widening that key union would
   * hand the writing UI keys it does not know how to draw.
   */
  editProgress: {
    percent: number;
    detail: string | null;
    steps: Array<{
      key: "prepare" | "snapshot" | "apply" | "export" | "outline" | "draft" | "save";
      label: string;
      status: "pending" | "active" | "done" | "failed";
      detail: string | null;
    }>;
  } | null;
  failureMessage: string | null;
  retryAvailable: boolean;
  steps: Array<{
    key: "plan" | "write" | "visuals" | "export";
    label: string;
    status: "pending" | "active" | "done" | "failed";
    detail: string | null;
  }>;
  pageProgress: {
    completed: number;
    target: number;
  };
  imageCount: number;
  quality: ProjectQualityStatus;
  exports: MobileExportSetDto;
  updatedAt: string;
};

export type MobileExportAvailabilityDto = {
  format: ProjectExportFormat;
  available: boolean;
  unlocked: boolean;
  creditsRequired: number;
  downloadUrl: string;
  filename: string;
  contentType: string;
  /** Project content revision this export set was reported against. */
  revision: number;
  /** Size of the compiled file, or null when it has not been compiled yet. */
  byteSize: number | null;
  /** When the compiled file was last written, or null when absent. */
  updatedAt: string | null;
};

export type MobileExportSetDto = {
  pdf: MobileExportAvailabilityDto;
  epub: MobileExportAvailabilityDto;
};

export type MobileAudiobookStatus = "generating" | "complete" | "failed";
export type MobileAudiobookChapterStatus = "pending" | "ready" | "failed";

export type MobileNarratorVoiceDto = {
  /** Stable identifier sent back when starting a narration. */
  voice: string;
  name: string;
  blurb: string;
  sampleUrl: string;
};

export type MobileAudiobookChapterDto = {
  index: number;
  title: string;
  status: MobileAudiobookChapterStatus;
  /** Measured length, present once the chapter is ready. */
  durationMs: number | null;
  /** Predicted length, used to draw the not-yet-narrated tail of the timeline. */
  estimatedDurationMs: number | null;
  byteSize: number | null;
  segmentCount: number | null;
  /** Null until the chapter is ready to download. */
  audioUrl: string | null;
  timelineUrl: string | null;
};

export type MobileAudiobookDto = {
  id: string;
  projectId: string;
  status: MobileAudiobookStatus;
  voice: string;
  narratorName: string;
  /** True when narration moved to the operational backup voice. */
  backupNarrationUsed: boolean;
  /** True when the book was edited after this narration was made. */
  isStale: boolean;
  totalDurationMs: number | null;
  totalEstimatedDurationMs: number | null;
  failureMessage: string | null;
  progress: MobileAudiobookProgressDto | null;
  chapters: MobileAudiobookChapterDto[];
};

export type MobileAudiobookProgressDto = {
  percent: number;
  currentAction: string;
  chaptersReady: number;
  chapterCount: number;
};

export type MobileMediaMetadata = {
  [key: string]: MobileJsonValue;
  bookType: MobileBookType | "custom";
  bookTypeChoice: MobileBookTypeChoice;
  lengthPreset: MobileLengthPreset | "custom";
  qualityPreset: MobileQualityPreset;
  /** Compatibility aggregate: coverEnabled || illustrationsEnabled. */
  imagesEnabled: boolean;
  coverEnabled: boolean;
  illustrationsEnabled: boolean;
  pageCountMode: MobilePageCountMode;
  targetPages: number;
  pageCountSource: MobilePageCountSource;
};

export type MobileCreateProjectInput = CreateProjectInput & {
  mediaSettings: CreateProjectInput["mediaSettings"] & {
    mobile: MobileMediaMetadata;
  };
};

export type MobileProjectRecord = {
  id: string;
  userId?: string;
  title: string;
  subtitle: string | null;
  authorName: string | null;
  coverTagline: string | null;
  prompt: string;
  category: string;
  subcategory: string | null;
  targetPages: number;
  complexity: number;
  temperature: number;
  language: string;
  mediaSettings: unknown;
  status: string;
  contentRevision: number;
  templateId?: string | null;
  currentPlanId: string | null;
  currentPlan?: MobilePlanRecord | null;
  pages?: MobilePageRecord[];
  images?: MobileImageRecord[];
  _count?: {
    pages?: number;
    images?: number;
    jobs?: number;
  };
  createdAt: Date;
  updatedAt: Date;
};

export type MobileCreationOutputRecord = {
  id: string;
  draftId: string;
  projectId: string;
  requestId?: string | null;
  title: string;
  sequence: number;
  createdAt: Date;
  updatedAt: Date;
  project?: { title: string; updatedAt?: Date } | null;
};

export type MobilePlanRecord = {
  id: string;
  projectId: string;
  version: number;
  status: string;
  planningPackage: unknown;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MobilePageRecord = {
  id: string;
  index: number;
  title: string;
  markdown: string;
  summary: string;
  status: string;
  images?: MobileImageRecord[];
};

export type MobileImageRecord = {
  id: string;
  projectId: string;
  pageId: string | null;
  type: string;
  path: string;
  metadata: unknown;
};

export type MobileProjectChatMessageRecord = {
  id: string;
  projectId: string;
  requestId?: string | null;
  parentId?: string | null;
  role: string;
  content: string;
  operationId: string | null;
  metadata: unknown;
  isActiveChild?: boolean;
  createdAt: Date;
};

export type MobileBookEditOperationRecord = {
  id: string;
  projectId: string;
  requestId?: string | null;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  generationJobId?: string | null;
  ledgerEntryId?: string | null;
  kind: string;
  status: string;
  request?: string;
  classifier?: unknown;
  affectedPageIndexes: number[];
  creditsCharged: number;
  automaticRetryCount?: number;
  automaticRetryLimit?: number;
  nextRetryAt?: Date | null;
  lastRetryAt?: Date | null;
  lastRetryReason?: string | null;
  retryRequestId?: string | null;
  error?: string | null;
  generationJob?: { id: string; status: string } | null;
  /**
   * The credit entry this operation spent against, when the query asked for it.
   * A reserved entry is refunded in place (`REFUNDED`); a settled one is
   * reversed by a separate entry, which is what `reversedByEntry` catches.
   */
  ledgerEntry?: { status: string; reversedByEntry?: { id: string } | null } | null;
  /** Present when the query asked for it; how many pages this edit snapshotted. */
  _count?: { snapshots: number };
  createdAt: Date;
  appliedAt: Date | null;
};

export type ProjectStatusResult = NonNullable<Awaited<ReturnType<typeof buildProjectStatus>>>;

export type MobileBillingDto = {
  credits: {
    /** Everything the user can spend right now: allowance plus purchased. */
    available: number;
    /** The part of `available` that came from a purchase and never expires. */
    purchased: number;
    reserved: number;
    lifetimeGranted: number;
    lifetimeSpent: number;
  };
  plan: {
    tier: PlanTier;
    source: "free" | "google_play";
    /** Google Play subscription status, or null on the free tier. */
    status: string | null;
    /** Null once the plan has been cancelled — read `endsAt` instead. */
    renewsAt: string | null;
    /** The plan is running out its last paid period and then drops to free. */
    cancelAtPeriodEnd: boolean;
    /** When that drop happens. Null while the plan is still renewing. */
    endsAt: string | null;
    /**
     * Whether this backend can end the subscription itself. Only the mock Play
     * verifier can; against real Play the app has to send the reader to the Play
     * subscription centre, because that is where Google requires it to happen.
     */
    canCancelInApp: boolean;
    productSku: string | null;
  };
  /**
   * What the free tier grants every month, whether or not the reader is on it.
   * Sent so the app can *describe* free — "1,000 credits and 3 illustrated books
   * a month" — rather than only counting down what a free user has left.
   */
  freeTier: {
    monthlyCredits: number;
    illustratedBooksPerMonth: number;
  };
  allowance: {
    /** What this plan grants each period. */
    monthlyCredits: number;
    /** What is left of it. Resets rather than carrying over. */
    planCredits: number;
    resetsAt: string | null;
  };
  /** Null means no image limit on this plan — unlimited, not unknown. */
  imageQuota: {
    used: number;
    limit: number;
    resetsAt: string;
  } | null;
  entitlements: Array<{
    id: string;
    type: string;
    projectId: string | null;
    status: string;
    source: string;
    creditsCost: number;
    startsAt: string;
    expiresAt: string | null;
  }>;
  creditCosts: CreditPricing;
  products: Array<{
    sku: string;
    title: string;
    description: string;
    productType: string;
    creditAmount: number;
    priceMicros: number;
    currency: string;
  }>;
};

/**
 * What a ledger row meant to the reader, not what it meant to the ledger.
 * `spend` covers every charge; the rest say where credits came from or why they
 * left without being spent.
 */
export type MobileCreditLogKind =
  | "purchase"
  | "subscription"
  | "monthly"
  | "bonus"
  | "spend"
  | "refund"
  | "expired";

export type MobileCreditLogEntryDto = {
  id: string;
  createdAt: string;
  /** `in` added credits, `out` took them. */
  direction: "in" | "out";
  /** Whole credits moved, always positive — the sign is `direction`. */
  credits: number;
  kind: MobileCreditLogKind;
  /**
   * Already in the reader's words. Built here rather than in the app so a new
   * `CreditOperation` reads correctly without a client release — and because the
   * stored `description` can carry raw provider errors, which never ship.
   */
  title: string;
  /** Held against work still running: charged, but not yet settled. */
  pending: boolean;
  /** The charge came back. The row is history, not a movement. */
  refunded: boolean;
  projectId: string | null;
  /** The book this touched, when it still exists. */
  projectTitle: string | null;
};

export type MobileCreditLogDto = {
  entries: MobileCreditLogEntryDto[];
  /** Send back as `cursor` for the next page. Null at the end of the history. */
  nextCursor: string | null;
};

export type MobileBillingResponseDto = {
  billing: MobileBillingDto;
};

export type MobileGooglePlayVerificationResponseDto = {
  purchase: {
    id: string;
    status: string;
    creditsGranted: number;
    subscriptionStatus: string | null;
    entitlementType: string | null;
  };
  billing: MobileBillingDto;
};

export type MobileCreationBuildOverrides = z.infer<typeof mobileCreationBuildBodySchema>;

/**
 * `ready` can be called right now. `preparing` is being built and will become
 * callable on its own. `unavailable` will not — the app shows it greyed rather
 * than hiding it, so a cast that is partly ready still reads as one cast.
 */
export type MobileVoiceCharacterStatus = "ready" | "preparing" | "unavailable";

export type MobileVoiceCharacterDto = {
  id: string;
  projectId: string;
  name: string;
  role: string;
  description: string;
  traits: string[];
  status: MobileVoiceCharacterStatus;
  /** True when the first call has to build the persona before connecting. */
  needsPreparation: boolean;
  image: MobileProjectImageDto | null;
};

export type MobileVoiceCastDto = {
  characters: MobileVoiceCharacterDto[];
  creditsPerMinute: number;
  creditsToStart: number;
  availableCredits: number;
  maxCallSeconds: number;
};

/**
 * Everything the app needs to open its own Gemini Live socket.
 *
 * The token is ephemeral and single-use, and the persona, voice and transcript
 * settings are locked into it server-side — the app cannot widen them. `model`
 * is here because it is a connection parameter the socket handshake requires,
 * not because the app is told which model wrote the book.
 */
export type MobileVoiceCallSessionDto = {
  callId: string;
  characterId: string;
  characterName: string;
  token: string;
  model: string;
  expiresAt: string;
  inputSampleRate: number;
  outputSampleRate: number;
  secondsRemaining: number;
  creditsPerMinute: number;
  heartbeatSeconds: number;
  maxCallSeconds: number;
};

export type MobileVoiceCallMeterDto = {
  callId: string;
  elapsedSeconds: number;
  secondsRemaining: number;
  chargedCredits: number;
  endingSoon: boolean;
  /** "credits" | "limit" | null — what is about to end the call, if anything. */
  endingReason: string | null;
};
