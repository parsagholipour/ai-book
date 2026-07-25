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
import { CREDIT_COSTS, type CreateProjectInput } from "@book-maker/core";
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
  imagesEnabled?: boolean | undefined;
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
  imagesEnabled: boolean;
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
  role: "cover" | "page_visual";
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
  /** True when this applied edit is the latest undoable snapshot-backed change. */
  canUndo: boolean;
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
};

export type MobileExportSetDto = {
  pdf: MobileExportAvailabilityDto;
  epub: MobileExportAvailabilityDto;
};

export type MobileMediaMetadata = {
  [key: string]: MobileJsonValue;
  bookType: MobileBookType | "custom";
  bookTypeChoice: MobileBookTypeChoice;
  lengthPreset: MobileLengthPreset | "custom";
  qualityPreset: MobileQualityPreset;
  imagesEnabled: boolean;
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
  createdAt: Date;
  appliedAt: Date | null;
};

export type ProjectStatusResult = NonNullable<Awaited<ReturnType<typeof buildProjectStatus>>>;

export type MobileBillingDto = {
  credits: {
    available: number;
    reserved: number;
    lifetimeGranted: number;
    lifetimeSpent: number;
  };
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
  creditCosts: typeof CREDIT_COSTS;
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
