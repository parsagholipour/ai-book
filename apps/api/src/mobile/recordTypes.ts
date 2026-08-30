import type { MobileBookTypeChoice, MobilePageCountMode, MobilePageCountSource } from "../mobileCreation.js";
import type { buildProjectStatus } from "../projectStatus.js";
import type { MobileBookType, MobileJsonValue, MobileLengthPreset, MobileQualityPreset } from "./dto.js";
import type { BillingOperation, CreateProjectInput } from "@book-maker/core";

/**
 * The Prisma row shapes and creation inputs the mobile serializers read —
 * the *from* side of the API contract, split out of ./dto.ts, which keeps the
 * wire DTOs and re-exports this file so callers keep one import surface.
 * Types only; every import here is type-only, so the circular reference back
 * into dto.ts is erased at compile time.
 */

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
  imageFailureReason?: string | null;
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
  editInstruction?: string | null;
  characterContext?: string | null;
  sourceProjectId?: string | null;
  classifier?: unknown;
  adherenceAudit?: unknown;
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
  /** Newest first when selected; the latest failed attempt supplies the exact retry quote. */
  generationAttempts?: Array<{
    id: string;
    commandKey: string;
    status: string;
    operation: BillingOperation;
    quotedCredits: number;
    refundPending: boolean;
  }>;
  /**
   * The credit entry this operation spent against, when the query asked for it.
   * A reserved entry is refunded in place (`REFUNDED`); a settled one is
   * reversed by a separate cumulative entry. Its amount may be less than the
   * original charge when a page-priced operation delivered only part.
   */
  ledgerEntry?: { status: string; reversedByEntry?: { id: string; amountCredits: number } | null } | null;
  /** Present when the query asked for it; live and structurally parked snapshots. */
  _count?: { snapshots: number; archivedSnapshots?: number };
  createdAt: Date;
  appliedAt: Date | null;
};

export type ProjectStatusResult = NonNullable<Awaited<ReturnType<typeof buildProjectStatus>>>;
