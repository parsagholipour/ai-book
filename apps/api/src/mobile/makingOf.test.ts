import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import type { FastifyInstance } from "fastify";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { objectKey } from "@book-maker/storage";
import { seedObject } from "../testing/objectStorage.js";
import { MAKING_OF_SOURCE_LIMIT } from "./makingOf.js";

/**
 * "Behind the book" (`makingOf.ts`): the chapters the book prints and the
 * sheet each starts on, and the sources the book read, by the printed Sources
 * list's own rule.
 */

const AUTH = bearer("token-a");
const DIGEST = "02c979c024c3ecbd8429389b7de06c3d4c38d376eae79bc3330324e59cfb5f56";

let status: string;
let contentRevision: number;

/** The published Contents of "The Last Table": three printed chapters over ten pages. */
function contents(chapters: Array<[string, number]>): string {
  const items = chapters
    .map(
      ([name, page], offset) => `    <li class="book-contents__item">
      <a class="book-contents__link" href="#chapter-${offset + 1}">
        <span class="book-contents__chapter">Chapter ${offset + 1}</span>
        <span class="book-contents__name">${name}</span>
        <span class="book-contents__leader" aria-hidden="true"></span>
        <span class="book-contents__page">${page}</span>
      </a>
    </li>`
    )
    .join("\n");
  return `# The Last Table\n\n<section class="book-contents" aria-labelledby="book-contents-title">
  <h2 id="book-contents-title">Contents</h2>
  <ol class="book-contents__list">
${items}
  </ol>
</section>\n\nThe rent reminder buzzed.\n`;
}

const PAGE_MAP = {
  version: 2,
  totalPdfPages: 12,
  hasCoverPage: true,
  contentsStartPdfPage: 4,
  contentRevision: 1,
  pdfDigest: DIGEST,
  pages: Array.from({ length: 10 }, (_, offset) => ({
    index: offset + 1,
    startPdfPage: [5, 5, 6, 7, 7, 8, 9, 10, 10, 11][offset],
    endPdfPage: [5, 6, 6, 7, 8, 9, 9, 10, 11, 12][offset]
  }))
};

let app: FastifyInstance;

beforeEach(async () => {
  resetMobileHarness();
  status = "COMPLETE";
  contentRevision = 1;
  mockAccessTokens({ "token-a": "user-a" });
  mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { id: string; userId: string } }) =>
    where.id === "project-1" && where.userId === "user-a"
      ? { id: "project-1", status, contentRevision, pdfPageMap: PAGE_MAP }
      : null
  );
  mockPrisma.project.findUnique.mockResolvedValue({ userId: "user-a", currentPlanId: "plan-1" });
  mockPrisma.voiceCharacter.findMany.mockResolvedValue([
    {
      id: "voice-1",
      projectId: "project-1",
      planVersionId: "plan-1",
      libraryCharacterId: null,
      name: "The Waitress",
      role: "Female lead",
      description: "Wary of celebrity.",
      traits: ["guarded"],
      status: "CANDIDATE",
      persona: null,
      profileImageAssetId: null
    }
  ]);
  mockPrisma.imageAsset.findMany.mockResolvedValue([]);
  // The plan's five chapters: a short book is written page by page and never
  // prints these.
  mockPrisma.chapter.findMany.mockResolvedValue([
    { title: "The Table by the Window", summary: "They meet.", pages: [{ index: 1 }] },
    { title: "The Camera at the Door", summary: "Phones come out.", pages: [{ index: 3 }] }
  ]);
  mockPrisma.page.findMany.mockResolvedValue(Array.from({ length: 10 }, (_, offset) => ({ index: offset + 1 })));
  seedObject(
    objectKey("books", "project-1", "book.md"),
    contents([
      ["The First Shift", 1],
      ["A Chance to Listen", 4],
      ["On Her Terms", 7]
    ])
  );
  seedObject(
    objectKey("books", "project-1", "reader-chapters.json"),
    JSON.stringify({
      fingerprint: "f",
      chapters: [
        { index: 1, title: "The First Shift", summary: "A late shift.", startPageIndex: 1, endPageIndex: 3 },
        { index: 2, title: "A Chance to Listen", summary: "He asks what help means.", startPageIndex: 4, endPageIndex: 6 },
        // A grouping that no longer starts where the printed chapter does says nothing about it.
        { index: 3, title: "On Her Terms", summary: "Stale.", startPageIndex: 8, endPageIndex: 10 }
      ]
    })
  );
  mockPrisma.researchSource.findMany.mockResolvedValue([
    { title: "Neymargate", url: "https://en.wikipedia.org/wiki/Neymargate" },
    { title: "Neymargate, again", url: "https://en.wikipedia.org/wiki/Neymargate#Reaction" },
    { title: "si.com", url: "https://www.si.com/soccer/neymar" },
    { title: "Not a page", url: "javascript:alert(1)" }
  ]);
  app = await buildMobileApp();
});

afterEach(async () => {
  await app.close();
  teardownMobileHarness();
});

describe("GET /api/mobile/projects/:id/making-of", () => {
  it("answers each chapter's first page and the book's linked sources once each", async () => {
    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/making-of", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cast: [
        {
          id: "voice-1",
          projectId: "project-1",
          name: "The Waitress",
          role: "Female lead",
          description: "Wary of celebrity.",
          traits: ["guarded"],
          status: "ready",
          needsPreparation: true,
          image: null,
          libraryCharacterId: null,
          libraryPortraitUrl: null
        }
      ],
      chapters: [
        { index: 1, title: "The First Shift", summary: "A late shift.", firstPageIndex: 1, pdfPage: 5 },
        { index: 2, title: "A Chance to Listen", summary: "He asks what help means.", firstPageIndex: 4, pdfPage: 7 },
        { index: 3, title: "On Her Terms", summary: "", firstPageIndex: 7, pdfPage: 9 }
      ],
      pdfDigest: DIGEST,
      sources: [
        { title: "Neymargate", host: "en.wikipedia.org", url: "https://en.wikipedia.org/wiki/Neymargate" },
        { title: "si.com", host: "si.com", url: "https://www.si.com/soccer/neymar" }
      ],
      sourceCount: 2
    });
    expect(mockPrisma.researchSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "project-1", url: { not: null } } })
    );
  });

  it("names no cast before the book is finished, as the voice cast does not", async () => {
    status = "EDITING";

    const body = (await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/making-of", headers: AUTH })).json();

    expect(body.cast).toEqual([]);
    expect(mockPrisma.voiceCharacter.findMany).not.toHaveBeenCalled();
    expect(body.chapters).toHaveLength(3);
  });

  it("lists no chapters for a book that prints no Contents", async () => {
    seedObject(objectKey("books", "project-1", "book.md"), "# The Last Table\n\nThe rent reminder buzzed.\n");

    const body = (await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/making-of", headers: AUTH })).json();

    expect(body.chapters).toEqual([]);
    expect(body.pdfDigest).toBeNull();
  });

  it("names no sheet from a map that describes another revision of the book", async () => {
    contentRevision = 2;

    const body = (await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/making-of", headers: AUTH })).json();

    expect(body.chapters.map((chapter: { firstPageIndex: number }) => chapter.firstPageIndex)).toEqual([1, 4, 7]);
    expect(body.chapters.map((chapter: { pdfPage: number | null }) => chapter.pdfPage)).toEqual([null, null, null]);
    expect(body.pdfDigest).toBeNull();
  });

  it("lists at most the limit and still counts every source", async () => {
    mockPrisma.researchSource.findMany.mockResolvedValue(
      Array.from({ length: MAKING_OF_SOURCE_LIMIT + 5 }, (_, index) => ({
        title: `Source ${index}`,
        url: `https://example.com/${index}`
      }))
    );

    const body = (await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/making-of", headers: AUTH })).json();

    expect(body.sources).toHaveLength(MAKING_OF_SOURCE_LIMIT);
    expect(body.sourceCount).toBe(MAKING_OF_SOURCE_LIMIT + 5);
  });

  it("names no provider, model, queue or storage path", async () => {
    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/making-of", headers: AUTH });

    const keys = JSON.stringify(response.json()).match(/"[A-Za-z]+":/g) ?? [];
    expect(keys.filter((key) => /provider|model|queue|path|planningPackage/i.test(key))).toEqual([]);
  });

  it("is a 404 for a book the caller does not own", async () => {
    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/project-2/making-of", headers: AUTH });

    expect(response.statusCode).toBe(404);
    expect(mockPrisma.researchSource.findMany).not.toHaveBeenCalled();
  });

  it("is a 401 without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/making-of" });

    expect(response.statusCode).toBe(401);
  });
});
