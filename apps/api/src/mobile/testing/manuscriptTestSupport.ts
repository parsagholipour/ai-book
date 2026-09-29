import type { FastifyInstance } from "fastify";
import { bearer } from "./mobileApiHarness.js";
import { synthesizeAuthorBookPlan } from "@book-maker/core";
import type { ManuscriptFakeDb } from "./manuscriptFakeDb.js";

/**
 * Route drivers and seeds shared by the Writing Studio suites. Every call goes
 * through the real routes as the owner of `token-a`.
 */

export const AUTH = bearer("token-a");

export async function createStudioBook(
  app: FastifyInstance,
  options: { title?: string; kind?: string; requestId?: string } = {}
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/mobile/projects/studio",
    headers: AUTH,
    payload: {
      ...(options.title !== undefined ? { title: options.title } : { title: "The Lighthouse" }),
      kind: options.kind ?? "story",
      requestId: options.requestId ?? "request-create-0001"
    }
  });
  return { response, body: response.json() as Record<string, any> };
}

export function getManuscript(app: FastifyInstance, projectId: string) {
  return app.inject({ method: "GET", url: `/api/mobile/projects/${projectId}/manuscript`, headers: AUTH });
}

export function getChapter(app: FastifyInstance, projectId: string, chapterId: string) {
  return app.inject({ method: "GET", url: `/api/mobile/projects/${projectId}/manuscript/chapters/${chapterId}`, headers: AUTH });
}

export function saveChapter(
  app: FastifyInstance,
  projectId: string,
  chapter: { id: string; revision: number; title?: string },
  markdown: string,
  extra: Record<string, unknown> = {}
) {
  return app.inject({
    method: "PUT",
    url: `/api/mobile/projects/${projectId}/manuscript/chapters/${chapter.id}`,
    headers: AUTH,
    payload: { title: chapter.title ?? "Chapter 1", markdown, baseRevision: chapter.revision, ...extra }
  });
}

export function addChapter(app: FastifyInstance, projectId: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/mobile/projects/${projectId}/manuscript/chapters`, headers: AUTH, payload });
}

export function publish(app: FastifyInstance, projectId: string, requestId: string, dryRun = false) {
  return app.inject({
    method: "POST",
    url: `/api/mobile/projects/${projectId}/manuscript/publish`,
    headers: AUTH,
    payload: { requestId, ...(dryRun ? { dryRun: true } : {}) }
  });
}

/** What the worker's compile does once it publishes: the book is settled again. */
export function finishCompile(db: ManuscriptFakeDb, projectId: string): void {
  const project = db.projects.find((row) => row.id === projectId);
  if (project) project.status = "COMPLETE";
}

/** Prose long enough to span several pages at the 1,900-character target. */
export function longProse(paragraphs: number, label = "The tide"): string {
  return Array.from(
    { length: paragraphs },
    (_, index) =>
      `${label} paragraph ${index + 1}. ` +
      "The keeper climbed the spiral stairs and counted every step out loud, the way her father had taught her. ".repeat(6).trim()
  ).join("\n\n");
}

/**
 * An imported book as the import job leaves it: a COMPLETE project with an
 * approved plan, one chapter row per chapter and pages under them, and — on
 * the first page — a hero illustration the compile prints above the prose.
 */
export function seedImportedBook(db: ManuscriptFakeDb, options: { status?: string; heroImage?: boolean } = {}): string {
  const projectId = "project-import";
  const now = new Date("2026-09-01T10:00:00.000Z");
  db.projects.push({
    id: projectId,
    userId: "user-a",
    title: "Imported Tales",
    subtitle: null,
    authorName: "Ada",
    coverTagline: null,
    prompt: "Imported manuscript: Imported Tales. The author's uploaded text is the canonical book content.",
    category: "CUSTOM",
    subcategory: null,
    targetPages: 3,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "manual",
      includeCover: false,
      coverArtSource: "design",
      coverTemplate: "auto",
      finalReview: false,
      toneProfile: "neutral",
      mobile: { bookType: "custom", lengthPreset: "custom", qualityPreset: "balanced", import: { importId: "imp_1", fileName: "tales.docx" } }
    },
    status: options.status ?? "COMPLETE",
    contentRevision: 1,
    currentPlanId: "plan-import",
    pdfPageMap: null,
    templateId: null,
    createdAt: now,
    updatedAt: now
  });
  db.planVersions.push({
    id: "plan-import",
    projectId,
    version: 1,
    status: "APPROVED",
    planningPackage: {},
    inputSnapshot: {},
    messages: [],
    approvedAt: now,
    createdAt: now,
    updatedAt: now
  });
  db.bookChapters.push(
    { id: "chapter-a", projectId, index: 1, title: "The Harbour", summary: "", targetPages: 2, status: "COMPLETED" },
    { id: "chapter-b", projectId, index: 2, title: "The Storm", summary: "", targetPages: 1, status: "COMPLETED" }
  );
  db.pages.push(
    page(projectId, "page-1", 1, "chapter-a", "The harbour was quiet at dawn."),
    page(projectId, "page-2", 2, "chapter-a", "Boats rocked against the pier."),
    page(projectId, "page-3", 3, "chapter-b", "Then the storm came in from the west.")
  );
  if (options.heroImage !== false) {
    db.images.push({
      id: "image-hero",
      projectId,
      pageId: "page-1",
      type: "SCENE_ILLUSTRATION",
      path: `https://api.example.com/assets/images/${projectId}/page-1.jpg`,
      metadata: {},
      prompt: "A quiet harbour",
      provider: "test",
      createdAt: now
    });
  }
  return projectId;
}

function page(projectId: string, id: string, index: number, chapterId: string, markdown: string) {
  return {
    id,
    projectId,
    index,
    chapterId,
    title: `Page ${index}`,
    markdown,
    summary: markdown,
    status: "COMPLETED",
    revision: 1,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-01T10:00:00.000Z")
  };
}

export function takeOver(app: FastifyInstance, projectId: string, requestId = "request-takeover-0001", headers = AUTH) {
  return app.inject({
    method: "POST",
    url: `/api/mobile/projects/${projectId}/manuscript/takeover`,
    headers,
    payload: { requestId }
  });
}

export type GeneratedBookPage = {
  markdown: string;
  chapter: string;
  hero?: boolean;
  status?: string;
  qualityReport?: Record<string, unknown> | null;
  imagePrompt?: string | null;
};

/**
 * A finished AI-generated book as the pipeline leaves it: an APPROVED plan
 * whose snapshot is what the compile reads, one `Chapter` row per plan chapter
 * with its pages under it, generation-time illustrations as hero `ImageAsset`
 * rows attached to their pages, and a cover.
 */
export function seedGeneratedBook(
  db: ManuscriptFakeDb,
  options: {
    projectId?: string;
    category?: string;
    status?: string;
    language?: string;
    chapters?: Array<{ id: string; title: string }>;
    pages?: GeneratedBookPage[];
    planningPackage?: Record<string, unknown>;
  } = {}
): string {
  const projectId = options.projectId ?? "project-gen";
  const now = new Date("2026-09-10T10:00:00.000Z");
  const chapters = options.chapters ?? [
    { id: "chapter-g1", title: "The Harbour" },
    { id: "chapter-g2", title: "The Storm" }
  ];
  const pages: GeneratedBookPage[] = options.pages ?? [
    { markdown: "The harbour was quiet at dawn.", chapter: "chapter-g1", hero: true, imagePrompt: "A quiet harbour at dawn" },
    { markdown: "Boats rocked against the pier.", chapter: "chapter-g1" },
    { markdown: "Then the storm came in from the west.", chapter: "chapter-g2", hero: true, imagePrompt: "A storm" },
    { markdown: "By morning the sea was calm again.", chapter: "chapter-g2", status: "FAILED_QA", qualityReport: { approved: false } }
  ];
  const category = options.category ?? "STORY";
  const mediaSettings = {
    fullIllustrations: true,
    illustrationCadence: "every-page",
    includeCover: true,
    coverArtSource: "ai",
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral",
    modelTier: "balanced",
    mobile: {
      bookType: category === "KIDS" ? "kids" : "story",
      lengthPreset: "custom",
      qualityPreset: "balanced",
      targetPages: pages.length,
      characters: [{ id: "char-mira", name: "Mira", description: "The keeper's daughter.", fields: [] }]
    }
  };
  db.projects.push({
    id: projectId,
    userId: "user-a",
    title: "Harbour Lights",
    subtitle: null,
    authorName: "Ada",
    coverTagline: null,
    prompt: "A story about a harbour town and the storm that changed it.",
    category,
    subcategory: null,
    targetPages: pages.length,
    complexity: 5,
    temperature: 0.8,
    language: options.language ?? "en",
    mediaSettings,
    status: options.status ?? "COMPLETE",
    contentRevision: 3,
    currentPlanId: `plan-${projectId}`,
    pdfPageMap: null,
    templateId: null,
    createdAt: now,
    updatedAt: now
  });
  db.planVersions.push({
    id: `plan-${projectId}`,
    projectId,
    version: 1,
    status: "APPROVED",
    planningPackage:
      options.planningPackage ??
      {
        ...synthesizeAuthorBookPlan({
          title: "Harbour Lights",
          chapters: chapters.map((chapter) => ({
            title: chapter.title,
            summary: `${chapter.title} summary.`,
            pageCount: pages.filter((page) => page.chapter === chapter.id).length || 1
          })),
          artStyle: "Soft watercolour with warm harbour light"
        }),
        premise: "A harbour town weathers the storm of the century.",
        promises: ["The lighthouse will matter."]
      },
    inputSnapshot: {
      title: "Harbour Lights",
      prompt: "A story about a harbour town and the storm that changed it.",
      category,
      targetPages: pages.length,
      complexity: 5,
      temperature: 0.8,
      language: options.language ?? "en",
      mediaSettings: { ...mediaSettings, generationStrategy: "auto" }
    },
    messages: [],
    approvedAt: now,
    createdAt: now,
    updatedAt: now
  });
  chapters.forEach((chapter, offset) => {
    db.bookChapters.push({
      id: chapter.id,
      projectId,
      index: offset + 1,
      title: chapter.title,
      summary: `${chapter.title} summary.`,
      targetPages: pages.filter((page) => page.chapter === chapter.id).length,
      productionBrief: { beats: ["planned"] },
      status: "COMPLETED"
    });
  });
  pages.forEach((spec, offset) => {
    const index = offset + 1;
    const id = `${projectId}-page-${index}`;
    db.pages.push({
      id,
      projectId,
      index,
      chapterId: spec.chapter,
      title: `Page ${index} title`,
      markdown: spec.markdown,
      summary: spec.markdown.slice(0, 80),
      status: spec.status ?? "COMPLETED",
      revision: 2,
      imagePrompt: spec.imagePrompt ?? null,
      imageFailureReason: null,
      qualityReport: spec.qualityReport ?? { approved: true },
      storyDelta: { facts: [`fact ${index}`] },
      createdAt: now,
      updatedAt: now
    });
    if (spec.hero) {
      db.images.push({
        id: `${id}-hero`,
        projectId,
        pageId: id,
        type: "SCENE_ILLUSTRATION",
        path: `http://localhost:4001/assets/images/${projectId}/page-${id}-k${index}.jpg`,
        metadata: {},
        prompt: spec.imagePrompt ?? "A picture",
        provider: "test",
        createdAt: now
      });
    }
  });
  db.images.push({
    id: `${projectId}-cover`,
    projectId,
    pageId: null,
    type: "COVER",
    path: `http://localhost:4001/assets/images/${projectId}/cover.jpg`,
    metadata: { coverArtSource: "ai" },
    prompt: "Cover",
    provider: "test",
    createdAt: now
  });
  return projectId;
}

/** A chat edit, as the worker's apply leaves a page: new text, revision bumped. */
export function chatEditPage(db: ManuscriptFakeDb, pageId: string, markdown: string): void {
  const row = db.pages.find((candidate) => candidate.id === pageId);
  if (!row) throw new Error(`No page ${pageId}`);
  row.markdown = markdown;
  row.revision += 1;
}

/**
 * A text model that answers each assist purpose with a canned reply, parsed
 * through the caller's own schema the way a real adapter's is. A reply that is
 * an `Error` is thrown instead. Every answer reports exact tokens from a
 * priced model, so the inline cost row has a real `costHint`.
 */
export function scriptedAssistModel(replies: Record<string, unknown>) {
  const calls: Array<{ purpose: string | undefined; messages: unknown }> = [];
  const model = {
    calls,
    async generateJson(options: { purpose?: string; schema: { parse: (value: unknown) => unknown }; messages: unknown }) {
      calls.push({ purpose: options.purpose, messages: options.messages });
      const reply = replies[options.purpose ?? ""];
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error(`No scripted reply for ${options.purpose}`);
      return {
        data: options.schema.parse(reply),
        text: JSON.stringify(reply),
        provider: "deepseek",
        model: "deepseek-chat",
        usage: { promptTokens: 1200, outputTokens: 300 }
      };
    },
    async generateText(): Promise<never> {
      throw new Error("not scripted");
    },
    async generateWithTools(): Promise<never> {
      throw new Error("not scripted");
    },
    async *streamText(): AsyncGenerator<string> {
      throw new Error("not scripted");
    }
  };
  return model;
}

export function quickAssist(app: FastifyInstance, projectId: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/mobile/projects/${projectId}/manuscript/assist`, headers: AUTH, payload });
}

export function longAssist(app: FastifyInstance, projectId: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/mobile/projects/${projectId}/manuscript/assists`, headers: AUTH, payload });
}

export function patchSettings(app: FastifyInstance, projectId: string, payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/api/mobile/projects/${projectId}/manuscript/settings`, headers: AUTH, payload });
}

/** A library character of `userId`, as the cast reads one. */
export function seedLibraryCharacter(
  db: ManuscriptFakeDb,
  options: { id: string; name: string; description?: string; appearance?: string | null; userId?: string }
): void {
  db.libraryCharacters.push({
    id: options.id,
    userId: options.userId ?? "user-a",
    name: options.name,
    description: options.description ?? `${options.name} keeps the lighthouse.`,
    appearance: options.appearance ?? null,
    fields: [],
    portraitStatus: "NONE",
    portraitPath: null,
    portraitSource: null,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-01T10:00:00.000Z")
  });
}
