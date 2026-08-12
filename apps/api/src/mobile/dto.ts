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
import { type ProjectQualityStatus } from "../projectStatus.js";
import { type ProjectExportFormat } from "../routes/projects.js";
import {
  mobileBookTypeSchema,
  mobileCreationBuildBodySchema,
  mobileLengthPresetSchema,
  mobileQualityPresetSchema
} from "./schemas.js";
import { type CoverArtSource, type CreditPricing, type PlanTier } from "@book-maker/core";
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
  /** Set on a copy created by a chat "rebuild the book" request; null otherwise. */
  revisedFrom: MobileProjectRevisionOriginDto | null;
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

/** Where a replan copy came from: the book it was rebuilt from and the request that asked. */
export type MobileProjectRevisionOriginDto = {
  /** The source project; it may since have been deleted. */
  projectId: string;
  /** The chat request that asked for the rebuild, as the reader typed it. */
  request: string | null;
  targetLanguage: string | null;
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
  /** Library characters this message @-mentions. */
  characters?: MobileCreationMessage["characters"];
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
  questions: Array<{
    prompt: string;
    options: string[];
    /** "multi" lets the reader send several of the options as one answer. */
    answerKind: "choice" | "multi" | "open";
    allowCustom: boolean;
  }>;
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
  /**
   * True when a planned illustration failed and the book finished without it.
   * A page designed without an image has `image: null` and `imageFailed: false`.
   */
  imageFailed: boolean;
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
  recoveryQuote: MobileGenerationRecoveryQuoteDto | null;
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

export type MobileGenerationRecoveryQuoteDto = {
  retryToken: string;
  credits: number;
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
      key: "prepare" | "snapshot" | "apply" | "export" | "outline" | "draft" | "save" | "revise" | "generate";
      label: string;
      status: "pending" | "active" | "done" | "failed";
      detail: string | null;
    }>;
  } | null;
  failureMessage: string | null;
  retryAvailable: boolean;
  recoveryQuote: MobileGenerationRecoveryQuoteDto | null;
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

// The Prisma row shapes these DTOs are built from live in ./recordTypes.ts;
// re-exported here so every consumer keeps one import surface.
export type {
  MobileBookEditOperationRecord,
  MobileCreateProjectInput,
  MobileCreationOutputRecord,
  MobileImageRecord,
  MobileMediaMetadata,
  MobilePageRecord,
  MobilePlanRecord,
  MobileProjectChatMessageRecord,
  MobileProjectRecord,
  ProjectStatusResult
} from "./recordTypes.js";

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

export type MobileLibraryCharacterPortraitStatus = "none" | "queued" | "generating" | "ready" | "failed";

/** What the uploaded image turned out to be. Null on rows never read. */
export type MobileLibraryCharacterPhotoKind = "photograph" | "illustration" | "unknown";

/** Whether the reference image was drawn for a fee or is the user's own art. */
export type MobileLibraryCharacterPortraitSource = "generated" | "adopted_upload";

/** An account-level library character ("consistent characters"). */
export type MobileLibraryCharacterDto = {
  id: string;
  name: string;
  description: string;
  fields: Array<{ key: string; value: string }>;
  portraitStatus: MobileLibraryCharacterPortraitStatus;
  portraitError: string | null;
  portraitSource: MobileLibraryCharacterPortraitSource | null;
  hasPhoto: boolean;
  photoKind: MobileLibraryCharacterPhotoKind | null;
  /**
   * A description read off the photo, offered to the user. Never applied on
   * their behalf, and cleared as soon as they accept, edit, or dismiss it.
   */
  suggestedDescription: string | null;
  /**
   * Whether this character's look actually reaches an illustrated book. It is
   * exactly the condition the build snapshot uses, so the app can never promise
   * more than the pipeline delivers — a stored photo alone does not count.
   */
  usedInBooks: boolean;
  /** Authenticated fetch paths under /api/mobile/characters/:id/…, or null. */
  photoUrl: string | null;
  portraitUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MobileLibraryCharacterListDto = {
  characters: MobileLibraryCharacterDto[];
  /** What one portrait generation costs right now, for the editor's badge. */
  portraitCredits: number;
};

/** Where the bytes of one retained picture came from. */
export type MobileLibraryCharacterImageSource = "upload" | "generated";

/**
 * One retained version of a character's picture — every upload and every
 * drawing, newest first on the wire.
 */
export type MobileLibraryCharacterImageDto = {
  id: string;
  /**
   * Authenticated fetch path. Immutable: one id is one set of bytes forever,
   * so it carries no cache-busting query and must never be given one.
   */
  url: string;
  source: MobileLibraryCharacterImageSource;
  photoKind: MobileLibraryCharacterPhotoKind | null;
  /** The picture every surface shows: the reference if there is one, else the photo. */
  isMain: boolean;
  isCurrentPhoto: boolean;
  isCurrentReference: boolean;
  /**
   * Whether making this the main picture would move the **book reference**.
   * The server's own adoption verdict, not a client rule — and the only flag a
   * surface may pair with copy that mentions books.
   */
  canBeMain: boolean;
  /**
   * Whether this upload can become the character's photo without touching what
   * books draw from. Only offered while there is no reference at all, since a
   * reference outranks the photo on every surface and the action would
   * otherwise change nothing the reader can see.
   */
  canBeShownAsPhoto: boolean;
  width: number | null;
  height: number | null;
  createdAt: string;
};

export type MobileLibraryCharacterImageListDto = {
  images: MobileLibraryCharacterImageDto[];
};

/** What every write that can move a pointer answers with: one call re-renders every surface. */
export type MobileLibraryCharacterWithImagesDto = {
  character: MobileLibraryCharacterDto;
  images: MobileLibraryCharacterImageDto[];
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
