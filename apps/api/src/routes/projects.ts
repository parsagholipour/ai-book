import type { FastifyPluginAsync } from "fastify";
import {
  assertBookLikeMarkdown,
  bookGenerationStrategies,
  createLanguageDetectionTextModel,
  createProjectSchema,
  detectPromptLanguage,
  getBookGenerationStrategy,
  imageModelOptions,
  isEnglishLanguage,
  loadConfig,
  mediaSettingsSchema,
  normalizeProjectLanguage,
  resolvePublicImageUrl,
  textModelOptions,
  type AppConfig,
  type CreateProjectInput
} from "@book-maker/core";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureSeedTemplates, prisma } from "@book-maker/db";
import { buildProjectStatus, normalizeTokenUsage } from "../projectStatus.js";
import { loadProjectCostSummaries, loadProjectCostSummary } from "../projectCosts.js";
import {
  enqueueGenerationJob,
  isBullJobActive,
  requeueGenerationJob,
  stopProjectGenerationJobs,
  type GenerationJobType
} from "../queue.js";
import { z } from "zod";

const idParamsSchema = z.object({ id: z.string().min(1) });
const planMessageParamsSchema = z.object({ id: z.string().min(1) });
const planMessageBodySchema = z.object({ message: z.string().min(1).max(10000) });
const resumableJobTypes: GenerationJobType[] = ["GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT"];
const restartableJobTypes: GenerationJobType[] = ["GENERATE_BOOK"];
const generationFailureJobTypes = [...resumableJobTypes, ...restartableJobTypes];
const BOOK_MARKDOWN_FILENAME = "book.md";
const LEGACY_BOOK_MARKDOWN_FILENAME = "README.md";
type ResumeContext = {
  currentPlanId: string | null;
  existingPages: number;
  pageIds: Set<string>;
};

export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  await ensureSeedTemplates();
  const appConfig = loadConfig();

  fastify.get("/api/health", async () => ({ ok: true, mockAi: appConfig.MOCK_AI }));

  fastify.get("/api/runtime", async () => ({
    mockAi: appConfig.MOCK_AI,
    providers: {
      text: appConfig.MOCK_AI ? "fake" : "deepseek",
      research: appConfig.MOCK_AI ? "fake" : "gemini",
      image: appConfig.MOCK_AI ? "fake" : "gemini",
      embedding: appConfig.MOCK_AI ? "fake" : "gemini"
    },
    models: {
      text: appConfig.MOCK_AI ? "fake-model" : appConfig.DEEPSEEK_MODEL,
      fastText: appConfig.MOCK_AI ? "fake-model" : appConfig.DEEPSEEK_FAST_MODEL,
      research: appConfig.MOCK_AI ? "fake-model" : appConfig.GEMINI_TEXT_MODEL,
      image: appConfig.MOCK_AI ? "fake-image" : appConfig.GEMINI_IMAGE_MODEL,
      embedding: appConfig.MOCK_AI ? "fake-embedding" : appConfig.GEMINI_EMBEDDING_MODEL
    },
    textModelOptions: appConfig.MOCK_AI
      ? [{ provider: "deepseek", model: "fake-model", label: "Mock text model" }]
      : textModelOptions(appConfig),
    imageModelOptions: imageModelOptions(appConfig),
    generationStrategies: bookGenerationStrategies.map((strategy) => ({
      id: strategy.id,
      label: strategy.label,
      strengthScore: strategy.strengthScore,
      recommendedPageRange: strategy.recommendedPageRange
    }))
  }));

  fastify.get("/api/templates", async () => {
    return prisma.template.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
  });

  fastify.get("/api/projects", async () => {
    const projects = await prisma.project.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        template: true,
        currentPlan: true,
        _count: { select: { pages: true, images: true, jobs: true } }
      }
    });
    const projectIds = projects.map((project) => project.id);
    const [tokenRows, costsByProjectId] = await Promise.all([
      projectIds.length > 0
        ? prisma.providerCallLog.groupBy({
            by: ["projectId"],
            where: { projectId: { in: projectIds } },
            _sum: { promptTokens: true, outputTokens: true, cacheHitTokens: true }
          })
        : Promise.resolve([]),
      loadProjectCostSummaries(projectIds)
    ]);
    const tokensByProjectId = new Map(
      tokenRows.flatMap((row) =>
        row.projectId ? [[row.projectId, normalizeTokenUsage(row._sum)] as const] : []
      )
    );

    return projects.map((project) => ({
      ...project,
      tokens: tokensByProjectId.get(project.id) ?? normalizeTokenUsage(),
      cost: costsByProjectId.get(project.id)
    }));
  });

  fastify.get("/api/projects/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const [project, tokenLogs, cost] = await Promise.all([
      prisma.project.findUnique({
        where: { id },
        include: {
          template: true,
          currentPlan: true,
          chapters: { orderBy: { index: "asc" } },
          pages: { orderBy: { index: "asc" } },
          images: true,
          research: true
        }
      }),
      prisma.providerCallLog.aggregate({
        where: { projectId: id },
        _sum: { promptTokens: true, outputTokens: true, cacheHitTokens: true }
      }),
      loadProjectCostSummary(id)
    ]);
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    return {
      ...project,
      tokens: normalizeTokenUsage(tokenLogs._sum),
      cost
    };
  });

  fastify.post("/api/projects", async (request, reply) => {
    const input = await inputWithDetectedLanguage(createProjectSchema.parse(request.body), request.body, appConfig);
    const template = await prisma.template.findFirst({
      where: input.templateSlug ? { slug: input.templateSlug } : { category: input.category }
    });
    const title = input.title ?? deriveTitle(input.prompt);
    const subtitle = cleanOptionalText(input.subtitle);
    const authorName = cleanOptionalText(input.authorName);
    const coverTagline = cleanOptionalText(input.coverTagline);
    const subcategory = cleanOptionalText(input.subcategory);

    const project = await prisma.project.create({
      data: {
        title,
        ...(subtitle ? { subtitle } : {}),
        ...(authorName ? { authorName } : {}),
        ...(coverTagline ? { coverTagline } : {}),
        prompt: input.prompt,
        category: input.category,
        ...(subcategory ? { subcategory } : {}),
        targetPages: input.targetPages,
        complexity: input.complexity,
        temperature: input.temperature,
        language: input.language,
        mediaSettings: mediaSettingsSchema.parse(input.mediaSettings),
        ...(template ? { templateId: template.id } : {})
      },
      include: { template: true }
    });

    return reply.code(201).send(project);
  });

  fastify.post("/api/projects/:id/plan", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input =
      request.body === undefined
        ? null
        : await inputWithDetectedLanguage(createProjectSchema.parse(request.body), request.body, appConfig);
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const template = input
      ? await prisma.template.findFirst({
          where: input.templateSlug ? { slug: input.templateSlug } : { category: input.category }
        })
      : null;

    await prisma.project.update({
      where: { id },
      data: {
        ...(input ? projectUpdateDataFromInput(input, template?.id ?? null) : {}),
        status: "PLANNING"
      }
    });
    const job = await enqueueGenerationJob({
      projectId: id,
      type: "PLAN_BOOK",
      payload: input ? { inputSnapshot: jsonPayload(input) } : {}
    });
    return reply.code(202).send(job);
  });

  fastify.post("/api/plans/:id/messages", async (request, reply) => {
    const { id } = planMessageParamsSchema.parse(request.params);
    const body = planMessageBodySchema.parse(request.body);
    const plan = await prisma.planVersion.findUnique({ where: { id } });
    if (!plan) {
      return reply.code(404).send({ error: "Plan not found" });
    }
    if (plan.status === "APPROVED") {
      return reply.code(400).send({ error: "Approved plans cannot be revised. Create a new plan version first." });
    }

    const job = await enqueueGenerationJob({
      projectId: plan.projectId,
      type: "REVISE_PLAN",
      payload: { planId: id, message: body.message }
    });
    return reply.code(202).send(job);
  });

  fastify.post("/api/plans/:id/approve", async (request, reply) => {
    const { id } = planMessageParamsSchema.parse(request.params);
    const plan = await prisma.planVersion.findUnique({ where: { id }, include: { project: true } });
    if (!plan) {
      return reply.code(404).send({ error: "Plan not found" });
    }

    await prisma.$transaction([
      prisma.planVersion.updateMany({
        where: { projectId: plan.projectId, id: { not: id } },
        data: { status: "SUPERSEDED" }
      }),
      prisma.planVersion.update({
        where: { id },
        data: { status: "APPROVED", approvedAt: new Date() }
      }),
      prisma.project.update({
        where: { id: plan.projectId },
        data: { currentPlanId: id, status: "GENERATING" }
      })
    ]);

    const job = await enqueueGenerationJob({
      projectId: plan.projectId,
      type: "GENERATE_BOOK",
      payload: { planId: id }
    });
    return reply.code(202).send(job);
  });

  fastify.post("/api/projects/:id/cover", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const project = await prisma.project.findUnique({ where: { id }, include: { currentPlan: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    if (!project.currentPlanId) {
      return reply.code(400).send({ error: "A project needs an approved plan before generating a cover." });
    }

    await prisma.project.update({ where: { id }, data: { status: "GENERATING" } });
    const job = await enqueueGenerationJob({
      projectId: id,
      type: "GENERATE_IMAGE",
      payload: { planId: project.currentPlanId, assetType: "COVER" }
    });
    return reply.code(202).send(job);
  });

  fastify.post("/api/projects/:id/resume", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const project = await prisma.project.findUnique({ where: { id }, include: { currentPlan: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }
    if (!project.currentPlanId) {
      return reply.code(400).send({ error: "A project needs an approved plan before generation can resume." });
    }

    const failedJobs = await prisma.generationJob.findMany({
      where: {
        projectId: id,
        status: "FAILED",
        type: { in: generationFailureJobTypes }
      },
      orderBy: { createdAt: "asc" }
    });
    const pages = await prisma.page.findMany({
      where: { projectId: id },
      select: { id: true, status: true, revision: true, qualityReport: true }
    });
    const resumeContext = {
      currentPlanId: project.currentPlanId,
      existingPages: pages.length,
      pageIds: new Set(pages.map((page) => page.id))
    };
    const jobsForCurrentPlan = failedJobs.filter((job) =>
      canResumeGenerationJob(job.type as GenerationJobType, job.payload, resumeContext)
    );
    const jobsReadyToResume: typeof failedJobs = [];
    let stoppingJobs = 0;
    for (const job of jobsForCurrentPlan) {
      if (await isBullJobActive(job.bullJobId)) {
        stoppingJobs += 1;
      } else {
        jobsReadyToResume.push(job);
      }
    }

    if (jobsReadyToResume.length === 0) {
      return reply.code(409).send({
        error:
          stoppingJobs > 0
            ? "Stopped generation jobs are still winding down. Try resume again in a moment."
            : "No failed generation jobs are available to resume for the current plan."
      });
    }

    await prisma.project.update({ where: { id }, data: { status: "GENERATING" } });
    const resumedJobs = [];
    for (const job of jobsReadyToResume) {
      resumedJobs.push(
        await requeueGenerationJob({
          id: job.id,
          projectId: job.projectId,
          type: job.type as GenerationJobType,
          payload: payloadWithCurrentPlan(job.payload, project.currentPlanId)
        })
      );
    }

    return reply.code(202).send({
      resumedJobs: resumedJobs.length,
      skippedJobs: failedJobs.length - jobsForCurrentPlan.length,
      stoppingJobs,
      jobs: resumedJobs
    });
  });

  fastify.post("/api/projects/:id/stop", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const project = await prisma.project.findUnique({ where: { id }, select: { id: true } });
    if (!project) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const result = await stopProjectGenerationJobs(id);
    return reply.code(202).send(result);
  });

  fastify.get("/api/projects/:id/status", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const status = await buildProjectStatus(id);
    if (!status) {
      return reply.code(404).send({ error: "Project not found" });
    }
    return status;
  });

  fastify.get("/api/projects/:id/events", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const origin = request.headers.origin;
    const corsHeaders = origin
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
          Vary: "Origin"
        }
      : {};

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders
    });

    const send = async () => {
      const status = await buildProjectStatus(id);
      if (status) {
        reply.raw.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
      }
    };

    await send();
    const timer = setInterval(send, 1000);
    request.raw.on("close", () => {
      clearInterval(timer);
      reply.raw.end();
    });
  });

  fastify.get("/api/projects/:id/book", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const markdown = await compileProjectMarkdown(id, appConfig.PUBLIC_API_URL, appConfig.BOOK_STORAGE_DIR);
    if (!markdown) {
      return reply.code(404).send({ error: "Book not found" });
    }
    reply.type("text/markdown");
    return markdown;
  });

  fastify.get("/api/projects/:id/export/readme", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const [markdown, project] = await Promise.all([
      compileProjectMarkdown(id, appConfig.PUBLIC_API_URL, appConfig.BOOK_STORAGE_DIR),
      prisma.project.findUnique({ where: { id }, select: { title: true } })
    ]);
    if (!markdown) {
      return reply.code(404).send({ error: "Book not found" });
    }
    const filename = `${sanitizeDownloadFilename(project?.title ?? "book")}.md`;
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    reply.type("text/markdown");
    return markdown;
  });

  fastify.get("/api/projects/:id/export/pdf", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const project = await prisma.project.findUnique({
      where: { id },
      select: { title: true, currentPlanId: true, mediaSettings: true }
    });
    if (!project?.currentPlanId) {
      return reply.code(404).send({ error: "Book not found" });
    }

    const pdfPath = join(appConfig.BOOK_STORAGE_DIR, id, "book.pdf");
    let pdf: Buffer;
    try {
      await access(pdfPath);
      pdf = await readFile(pdfPath);
    } catch {
      const markdown = await compileProjectMarkdown(id, appConfig.PUBLIC_API_URL, appConfig.BOOK_STORAGE_DIR);
      if (!markdown) {
        return reply.code(404).send({ error: "Book not found" });
      }
      try {
        await mkdir(dirname(pdfPath), { recursive: true });
        const strategy = strategyForMediaSettings(project.mediaSettings);
        pdf = await strategy.generatePdf(markdown, {
          imageStorageDir: appConfig.IMAGE_STORAGE_DIR,
          publicApiUrl: appConfig.PUBLIC_API_URL,
          outputPath: pdfPath
        });
      } catch (error) {
        request.log.error({ err: error, projectId: id }, "PDF generation failed");
        return reply.code(500).send({ error: "PDF generation failed" });
      }
    }

    const filename = `${sanitizeDownloadFilename(project.title)}.pdf`;
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    reply.type("application/pdf");
    return pdf;
  });
};

async function compileProjectMarkdown(
  projectId: string,
  publicApiUrl: string,
  bookStorageDir: string
): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      currentPlan: true,
      pages: { orderBy: { index: "asc" }, include: { images: true } },
      images: true,
      research: true
    }
  });
  if (!project?.currentPlan) {
    return readSavedBookMarkdown(projectId, bookStorageDir);
  }

  const generatedPages = project.pages.filter((page) => page.markdown.trim().length > 0);
  if (generatedPages.length === 0) {
    return readSavedBookMarkdown(projectId, bookStorageDir);
  }

  const strategy = strategyForMediaSettings(project.mediaSettings);
  const cover = project.images.find((image) => image.type === "COVER");
  const markdown = strategy.compileMarkdown({
    plan: project.currentPlan.planningPackage as never,
    category: project.category,
    language: project.language,
    ...(cover
      ? {
          cover: {
            imagePath: resolvePublicImageUrl(cover.path, publicApiUrl) ?? cover.path,
            imageAlt: `Cover for ${project.title}`
          }
        }
      : {}),
    pages: generatedPages.map((page) => ({
      index: page.index,
      title: page.title,
      markdown: page.markdown,
      imagePath: resolvePublicImageUrl(page.images[0]?.path, publicApiUrl),
      imageAlt: "Illustration"
    })),
    researchSources: project.research.map((source) => ({
      title: source.title,
      url: source.url ?? undefined,
      summary: source.summary
    }))
  });
  assertBookLikeMarkdown(markdown);
  return markdown;
}

async function readSavedBookMarkdown(projectId: string, bookStorageDir: string): Promise<string | null> {
  for (const filename of [BOOK_MARKDOWN_FILENAME, LEGACY_BOOK_MARKDOWN_FILENAME]) {
    try {
      const markdown = await readFile(join(bookStorageDir, projectId, filename), "utf8");
      return markdown.trim().length > 0 ? markdown : null;
    } catch {
      // Try the next legacy filename.
    }
  }
  return null;
}

function strategyForMediaSettings(mediaSettings: unknown) {
  return getBookGenerationStrategy(mediaSettingsSchema.parse(mediaSettings).generationStrategy);
}

function sanitizeDownloadFilename(title: string): string {
  const clean = title
    .trim()
    .replace(/[^\w\s-]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return clean || "book";
}

function deriveTitle(prompt: string): string {
  return prompt
    .split(/[.!?\n]/)[0]
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "Untitled Book";
}

function projectUpdateDataFromInput(input: CreateProjectInput, templateId: string | null) {
  const subtitle = cleanOptionalText(input.subtitle);
  const authorName = cleanOptionalText(input.authorName);
  const coverTagline = cleanOptionalText(input.coverTagline);
  const subcategory = cleanOptionalText(input.subcategory);

  return {
    title: input.title ?? deriveTitle(input.prompt),
    subtitle: subtitle ?? null,
    authorName: authorName ?? null,
    coverTagline: coverTagline ?? null,
    prompt: input.prompt,
    category: input.category,
    subcategory: subcategory ?? null,
    targetPages: input.targetPages,
    complexity: input.complexity,
    temperature: input.temperature,
    language: input.language,
    mediaSettings: mediaSettingsSchema.parse(input.mediaSettings),
    templateId
  };
}

async function inputWithDetectedLanguage(
  input: CreateProjectInput,
  rawBody: unknown,
  appConfig: AppConfig
): Promise<CreateProjectInput> {
  const explicitLanguage = explicitLanguageFromBody(rawBody);
  if (explicitLanguage && !isEnglishLanguage(explicitLanguage)) {
    return { ...input, language: normalizeProjectLanguage(explicitLanguage) };
  }
  const fallbackLanguage = explicitLanguage ? normalizeProjectLanguage(explicitLanguage) : input.language;

  try {
    return {
      ...input,
      language: await detectPromptLanguage(createLanguageDetectionTextModel(appConfig), input.prompt)
    };
  } catch {
    return { ...input, language: fallbackLanguage };
  }
}

function explicitLanguageFromBody(rawBody: unknown): string | undefined {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return undefined;
  }
  const language = (rawBody as Record<string, unknown>).language;
  return typeof language === "string" && language.trim() ? language : undefined;
}

function jsonPayload(input: CreateProjectInput): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function payloadPlanId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as Record<string, unknown>).planId;
  return typeof value === "string" ? value : null;
}

function canResumeGenerationJob(type: GenerationJobType, payload: unknown, context: ResumeContext): boolean {
  if (!context.currentPlanId) {
    return false;
  }

  const payloadRecord = jsonPayloadToRecord(payload);
  const planId = payloadPlanId(payloadRecord);
  if (planId && planId !== context.currentPlanId) {
    return false;
  }

  if (type === "GENERATE_BOOK") {
    return planId === context.currentPlanId;
  }

  if (type === "GENERATE_PAGE") {
    return isCurrentPagePayload(payloadRecord, context);
  }

  if (type === "GENERATE_IMAGE") {
    return (
      isCurrentCoverPayload(payloadRecord, context) ||
      (isCurrentPagePayload(payloadRecord, context) && typeof payloadRecord.prompt === "string")
    );
  }

  return type === "COMPILE_EXPORT";
}

function payloadWithCurrentPlan(payload: unknown, currentPlanId: string): Record<string, unknown> {
  return {
    ...jsonPayloadToRecord(payload),
    planId: currentPlanId
  };
}

function isCurrentPagePayload(payload: Record<string, unknown>, context: ResumeContext): boolean {
  return typeof payload.pageId === "string" && context.pageIds.has(payload.pageId);
}

function isCurrentCoverPayload(payload: Record<string, unknown>, context: ResumeContext): boolean {
  return payload.assetType === "COVER" && payloadPlanId(payload) === context.currentPlanId;
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function jsonPayloadToRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload as Record<string, unknown>;
}
