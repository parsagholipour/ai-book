import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { z } from "zod";
import { CURRENT_LEGAL_VERSIONS, legalAcceptanceData, legalMetadata } from "./legalAcceptance.js";
import type { AuthFailure } from "./mobileAuth.js";
import { stopProjectGenerationJobs } from "./queue.js";
import {
  authenticateMobileBearer,
  markOperatorRequest,
  sendMobileAuthFailure,
  type MobileAuthContext,
  type OperatorAuthContext
} from "./requestAuth.js";
import { deleteProjectStorage } from "./projectStorage.js";
import {
  InMemoryRateLimiter,
  rateLimitKey,
  sendRateLimitError,
  type RateLimitConfig
} from "./rateLimit.js";

const idParamsSchema = z.object({ id: z.string().min(1) });
const assetReportParamsSchema = z.object({ id: z.string().min(1), assetId: z.string().min(1) });
const reviewParamsSchema = z.object({ id: z.string().min(1) });
const reportReasonSchema = z.enum([
  "offensive",
  "hate_or_harassment",
  "sexual_content",
  "violence_or_self_harm",
  "child_safety",
  "deceptive_or_misleading",
  "privacy_or_copyright",
  "other"
]);
const moderationReportBodySchema = z
  .object({
    reason: reportReasonSchema,
    comment: z.string().trim().max(2000).optional()
  })
  .strict();
const accountDeletionRequestBodySchema = z
  .object({
    reason: z.string().trim().max(2000).optional()
  })
  .strict()
  .default({});
const reviewBodySchema = z
  .object({
    status: z.enum(["pending", "reviewed", "actioned", "dismissed"]),
    reviewNotes: z.string().trim().max(4000).optional()
  })
  .strict();
// Re-acceptance is one tap: fresh assent to the terms only. The age/guardian
// attestation was made at signup and does not expire with a terms bump, so it
// defaults to false here and is recorded as whatever the client actually
// re-presented. Version echoes from older builds are accepted and ignored —
// the server stamps the versions in force at acceptance time.
const legalAcceptanceBodySchema = z
  .object({
    termsAccepted: z.literal(true),
    ageGuardianAttested: z.boolean().optional().default(false),
    termsVersion: z.string().trim().max(40).optional(),
    privacyVersion: z.string().trim().max(40).optional()
  })
  .strict();

const DEFAULT_REPORT_RATE_LIMIT = { maxAttempts: 10, windowMs: 60 * 60 * 1000 };
const DEFAULT_ACCOUNT_PRIVACY_RATE_LIMIT = { maxAttempts: 5, windowMs: 24 * 60 * 60 * 1000 };
const DEFAULT_PROJECT_DELETION_RATE_LIMIT = { maxAttempts: 10, windowMs: 60 * 60 * 1000 };

type SafetyRouteOptions = {
  reportRateLimit?: Partial<RateLimitConfig>;
  accountPrivacyRateLimit?: Partial<RateLimitConfig>;
  projectDeletionRateLimit?: Partial<RateLimitConfig>;
};

type ModerationReportRecord = {
  id: string;
  reporterUserId: string | null;
  projectId: string | null;
  imageAssetId: string | null;
  targetType: string;
  reason: string;
  comment: string | null;
  status: string;
  targetSnapshot: unknown;
  reviewerUserId: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
  reporter?: { email: string; displayName: string | null } | null;
  project?: { title: string } | null;
  imageAsset?: { type: string } | null;
};

type AccountDeletionRequestRecord = {
  id: string;
  userId: string | null;
  email: string;
  status: string;
  reason: string | null;
  requestedAt: Date;
  completedAt: Date | null;
};

export const mobileSafetyRoutes: FastifyPluginAsync<SafetyRouteOptions> = async (fastify, options) => {
  const appConfig = loadConfig();
  const reportLimiter = new InMemoryRateLimiter({
    ...DEFAULT_REPORT_RATE_LIMIT,
    ...options.reportRateLimit
  });
  const accountPrivacyLimiter = new InMemoryRateLimiter({
    ...DEFAULT_ACCOUNT_PRIVACY_RATE_LIMIT,
    ...options.accountPrivacyRateLimit
  });
  const projectDeletionLimiter = new InMemoryRateLimiter({
    ...DEFAULT_PROJECT_DELETION_RATE_LIMIT,
    ...options.projectDeletionRateLimit
  });

  fastify.get("/api/mobile/legal", async () => {
    return {
      legal: {
        ...legalMetadata(appConfig),
        aiGeneratedContentDisclosure:
          "Books, pages, and visuals are generated with AI from user prompts and product presets."
      }
    };
  });

  // Deliberately public (see `shouldProtectPath`): the sample is what a person
  // deciding whether to sign up gets to read. It serves one operator-chosen
  // compiled book, so there is nothing user-owned to protect.
  fastify.get("/api/mobile/sample-book", async (_request, reply) => {
    const projectId = appConfig.SAMPLE_PROJECT_ID;
    const pdfPath = projectId ? join(appConfig.BOOK_STORAGE_DIR, projectId, "book.pdf") : null;
    const size = pdfPath ? await stat(pdfPath).then((s) => s.size).catch(() => null) : null;
    if (!pdfPath || size == null) {
      return sendMobileError(reply, 404, "SAMPLE_UNAVAILABLE", "No sample book is published right now.");
    }
    reply.header("Content-Length", String(size));
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.type("application/pdf").send(createReadStream(pdfPath));
  });

  fastify.post("/api/mobile/legal/acceptance", async (request, reply) => {
    const auth = await requireMobileAuth(request, reply);
    if (!auth) {
      return;
    }
    const parsed = legalAcceptanceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendMobileError(
        reply,
        400,
        "LEGAL_ACCEPTANCE_REQUIRED",
        "Accept the current Terms and Privacy Policy to continue."
      );
    }
    await prisma.legalAcceptance.create({
      data: legalAcceptanceData(auth.user.id, parsed.data, "mobile_reacceptance", request)
    });
    return {
      accepted: true,
      legalAcceptanceRequired: false,
      ...CURRENT_LEGAL_VERSIONS
    };
  });

  fastify.post("/api/mobile/projects/:id/reports", async (request, reply) => {
    const auth = await requireMobileAuth(request, reply);
    if (!auth) {
      return;
    }
    if (!hitAuthenticatedLimit(reportLimiter, request, reply, auth.user.id, "report-project")) {
      return;
    }

    const { id } = idParamsSchema.parse(request.params);
    const parsed = moderationReportBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a report reason.");
    }

    const project = await prisma.project.findFirst({
      where: { id, userId: auth.user.id },
      select: {
        id: true,
        title: true,
        status: true,
        category: true,
        subcategory: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { pages: true, images: true } }
      }
    });
    if (!project) {
      return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
    }

    const report = (await prisma.moderationReport.create({
      data: {
        reporterUserId: auth.user.id,
        projectId: project.id,
        targetType: "PROJECT",
        reason: toReportReason(parsed.data.reason),
        comment: cleanText(parsed.data.comment) ?? null,
        targetSnapshot: jsonInput({
          projectId: project.id,
          title: project.title,
          status: project.status,
          category: project.category,
          subcategory: project.subcategory,
          pageCount: project._count.pages,
          imageCount: project._count.images,
          createdAt: project.createdAt.toISOString(),
          updatedAt: project.updatedAt.toISOString()
        })
      },
      select: moderationReportSelect
    })) as ModerationReportRecord;

    return reply.code(201).send({ report: serializeModerationReport(report) });
  });

  fastify.post("/api/mobile/projects/:id/assets/:assetId/reports", async (request, reply) => {
    const auth = await requireMobileAuth(request, reply);
    if (!auth) {
      return;
    }
    if (!hitAuthenticatedLimit(reportLimiter, request, reply, auth.user.id, "report-asset")) {
      return;
    }

    const { id, assetId } = assetReportParamsSchema.parse(request.params);
    const parsed = moderationReportBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a report reason.");
    }

    const image = await prisma.imageAsset.findFirst({
      where: { id: assetId, projectId: id, project: { userId: auth.user.id } },
      select: {
        id: true,
        projectId: true,
        pageId: true,
        type: true,
        path: true,
        metadata: true,
        project: {
          select: {
            title: true,
            status: true,
            category: true
          }
        }
      }
    });
    if (!image) {
      return sendMobileError(reply, 404, "ASSET_NOT_FOUND", "Visual not found.");
    }

    const report = (await prisma.moderationReport.create({
      data: {
        reporterUserId: auth.user.id,
        projectId: image.projectId,
        imageAssetId: image.id,
        targetType: "IMAGE_ASSET",
        reason: toReportReason(parsed.data.reason),
        comment: cleanText(parsed.data.comment) ?? null,
        targetSnapshot: jsonInput({
          projectId: image.projectId,
          projectTitle: image.project.title,
          projectStatus: image.project.status,
          projectCategory: image.project.category,
          imageAssetId: image.id,
          pageId: image.pageId,
          assetType: image.type,
          filename: image.path.split("/").pop() ?? image.path,
          contentType: stringFromRecord(image.metadata, "mimeType") ?? "application/octet-stream"
        })
      },
      select: moderationReportSelect
    })) as ModerationReportRecord;

    return reply.code(201).send({ report: serializeModerationReport(report) });
  });

  fastify.delete("/api/mobile/projects/:id", async (request, reply) => {
    const auth = await requireMobileAuth(request, reply);
    if (!auth) {
      return;
    }
    if (!hitAuthenticatedLimit(projectDeletionLimiter, request, reply, auth.user.id, "delete-project")) {
      return;
    }

    const { id } = idParamsSchema.parse(request.params);
    const project = await prisma.project.findFirst({
      where: { id, userId: auth.user.id },
      select: { id: true }
    });
    if (!project) {
      return sendMobileError(reply, 404, "PROJECT_NOT_FOUND", "Project not found.");
    }

    let stoppedJobs: Awaited<ReturnType<typeof stopProjectGenerationJobs>> | null = null;
    try {
      stoppedJobs = await stopProjectGenerationJobs(id);
    } catch (error) {
      request.log.warn({ err: error, projectId: id }, "Could not stop project jobs before mobile deletion");
    }

    await prisma.project.delete({ where: { id } });
    const assetCleanup = await deleteProjectStorage(appConfig, id, request);
    return {
      ok: true,
      deletedProjectId: id,
      stoppedJobs,
      assetCleanup,
      retainedLogs:
        "Provider call logs and moderation reports may be retained with project references cleared for diagnostics, billing, abuse prevention, and compliance review."
    };
  });

  fastify.post("/api/mobile/account/deletion-request", async (request, reply) => {
    const auth = await requireMobileAuth(request, reply);
    if (!auth) {
      return;
    }
    if (!hitAuthenticatedLimit(accountPrivacyLimiter, request, reply, auth.user.id, "account-deletion-request")) {
      return;
    }

    const parsed = accountDeletionRequestBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a short deletion request note or leave it blank.");
    }

    const existing = (await prisma.accountDeletionRequest.findFirst({
      where: { userId: auth.user.id, status: "PENDING" },
      orderBy: { requestedAt: "desc" },
      select: accountDeletionRequestSelect
    })) as AccountDeletionRequestRecord | null;
    if (existing) {
      return { request: serializeAccountDeletionRequest(existing) };
    }

    const deletionRequest = (await prisma.accountDeletionRequest.create({
      data: {
        userId: auth.user.id,
        email: auth.user.email,
        reason: cleanText(parsed.data.reason) ?? null,
        metadata: jsonInput({
          source: "mobile_app",
          supportEmail: appConfig.SUPPORT_EMAIL,
          accountDeletionUrl: appConfig.ACCOUNT_DELETION_URL
        })
      },
      select: accountDeletionRequestSelect
    })) as AccountDeletionRequestRecord;

    return reply.code(201).send({ request: serializeAccountDeletionRequest(deletionRequest) });
  });

  fastify.get("/api/admin/moderation/reports", async (request, reply) => {
    const operator = await requireOperatorAuth(request, reply);
    if (!operator) {
      return;
    }
    const reports = (await prisma.moderationReport.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        ...moderationReportSelect,
        reporter: { select: { email: true, displayName: true } },
        project: { select: { title: true } },
        imageAsset: { select: { type: true } }
      }
    })) as ModerationReportRecord[];
    return { reports: reports.map(serializeModerationReport) };
  });

  fastify.patch("/api/admin/moderation/reports/:id", async (request, reply) => {
    const operator = await requireOperatorAuth(request, reply);
    if (!operator) {
      return;
    }
    const { id } = reviewParamsSchema.parse(request.params);
    const parsed = reviewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendMobileError(reply, 400, "VALIDATION_ERROR", "Send a valid moderation status.");
    }

    const report = (await prisma.moderationReport.update({
      where: { id },
      data: {
        status: toReportStatus(parsed.data.status),
        reviewNotes: cleanText(parsed.data.reviewNotes) ?? null,
        reviewerUserId: operator.userId,
        reviewedAt: new Date()
      },
      select: moderationReportSelect
    })) as ModerationReportRecord;

    return { report: serializeModerationReport(report) };
  });
};

const moderationReportSelect = {
  id: true,
  reporterUserId: true,
  projectId: true,
  imageAssetId: true,
  targetType: true,
  reason: true,
  comment: true,
  status: true,
  targetSnapshot: true,
  reviewerUserId: true,
  reviewedAt: true,
  reviewNotes: true,
  createdAt: true,
  updatedAt: true
} as const;

const accountDeletionRequestSelect = {
  id: true,
  userId: true,
  email: true,
  status: true,
  reason: true,
  requestedAt: true,
  completedAt: true
} as const;

async function requireMobileAuth(request: FastifyRequest, reply: FastifyReply): Promise<MobileAuthContext | null> {
  if (request.mobileAuth) {
    return request.mobileAuth;
  }
  const auth = await authenticateMobileBearer(request);
  if (!auth) {
    sendMobileError(reply, 401, "AUTH_REQUIRED", "Sign in to continue.");
    return null;
  }
  if (isAuthFailure(auth)) {
    sendMobileAuthFailure(reply, auth);
    return null;
  }
  return auth;
}

async function requireOperatorAuth(request: FastifyRequest, _reply: FastifyReply): Promise<OperatorAuthContext | null> {
  if (request.operatorAuth) {
    return request.operatorAuth;
  }
  return markOperatorRequest(request);
}

function hitAuthenticatedLimit(
  limiter: InMemoryRateLimiter,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  action: string
): boolean {
  const limit = limiter.hit(rateLimitKey(request, userId, action));
  if (limit.allowed) {
    return true;
  }
  sendRateLimitError(reply, limit.retryAfterSeconds);
  return false;
}

function serializeModerationReport(report: ModerationReportRecord) {
  return {
    id: report.id,
    reporterUserId: report.reporterUserId,
    reporterEmail: report.reporter?.email ?? null,
    projectId: report.projectId,
    projectTitle: report.project?.title ?? stringFromRecord(report.targetSnapshot, "title") ?? stringFromRecord(report.targetSnapshot, "projectTitle"),
    imageAssetId: report.imageAssetId,
    targetType: report.targetType.toLowerCase(),
    reason: report.reason.toLowerCase(),
    comment: report.comment,
    status: report.status.toLowerCase(),
    targetSnapshot: report.targetSnapshot,
    reviewerUserId: report.reviewerUserId,
    reviewedAt: report.reviewedAt?.toISOString() ?? null,
    reviewNotes: report.reviewNotes,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString()
  };
}

function serializeAccountDeletionRequest(request: AccountDeletionRequestRecord) {
  return {
    id: request.id,
    status: request.status.toLowerCase(),
    email: request.email,
    reason: request.reason,
    requestedAt: request.requestedAt.toISOString(),
    completedAt: request.completedAt?.toISOString() ?? null
  };
}

function toReportReason(reason: z.infer<typeof reportReasonSchema>) {
  return reason.toUpperCase() as Uppercase<typeof reason>;
}

function toReportStatus(status: z.infer<typeof reviewBodySchema>["status"]) {
  return status.toUpperCase() as Uppercase<typeof status>;
}

function isAuthFailure(auth: MobileAuthContext | AuthFailure): auth is AuthFailure {
  return "ok" in auth && auth.ok === false;
}

function sendMobileError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.code(statusCode).send({
    error: {
      code,
      message
    }
  });
}

function cleanText(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function jsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function stringFromRecord(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const raw = record[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}
