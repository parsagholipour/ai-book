import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseManuscript } from "@book-maker/core";
import { objectKey, objectStore } from "@book-maker/storage";
import { parseWorkerJobData, type ImportBookJob } from "../runtime/jobPayloads.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    bookImport: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    project: { update: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    generationJob: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    page: { findMany: vi.fn(), createMany: vi.fn() },
    chapter: { create: vi.fn() },
    planVersion: { create: vi.fn() },
    safetySettingsRevision: { findFirst: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn()
  },
  getProjectOrThrow: vi.fn(),
  maybeEnqueueCompile: vi.fn(),
  appendRunLog: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("@book-maker/core", async (importActual) => ({
  ...await importActual<typeof import("@book-maker/core")>(),
  createProviders: () => ({})
}));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn() }));
vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: () => ({}) }));
vi.mock("../providers/runLogging.js", () => ({ createRunLogger: () => ({ append: mocks.appendRunLog }) }));
vi.mock("../generation/embeddingWrites.js", () => ({ storeEmbedding: vi.fn(), strategyUsesSemanticMemory: () => false }));
vi.mock("../generation/projectInput.js", () => ({ inputFromProject: (value: unknown) => value }));
vi.mock("../generation/bookHelpers.js", () => ({
  getProjectOrThrow: mocks.getProjectOrThrow,
  nextPlanVersion: () => 1,
  planInputSnapshot: (input: unknown) => input,
  strategyForInput: () => ({})
}));

import { IMPORT_MATTER_REFUSED_EVENT, importBook } from "./importBook.js";

const manuscript = Buffer.from("# The Long Winter\n\nJane Doe\n\n# Chapter One\n\nBody text.");
const project = {
  id: "project-1",
  title: "The Long Winter",
  authorName: "Sam Lee",
  subtitle: null,
  bookMatter: null,
  status: "GENERATING",
  currentPlanId: null,
  contentRevision: 0,
  mediaSettings: {},
  language: "en"
};

function job(payload: Record<string, unknown> = {}): ImportBookJob {
  return {
    data: parseWorkerJobData("import-book", {
      projectId: project.id,
      generationJobId: "job-1",
      importId: "import-1",
      ...payload
    })
  } as ImportBookJob;
}

async function runImport(delivery: ImportBookJob) {
  const completion = await importBook(delivery);
  await completion.afterJobCompleted?.();
}

function savedText(): string {
  return mocks.prisma.page.createMany.mock.calls.flatMap(([input]) =>
    input.data.map((page: { markdown: string }) => page.markdown)
  ).join("\n\n");
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.prisma.safetySettingsRevision.findFirst.mockResolvedValue({ copyrightRestrictionsEnabled: false });
  mocks.getProjectOrThrow.mockResolvedValue(project);
  mocks.prisma.project.findUniqueOrThrow.mockImplementation(() => mocks.getProjectOrThrow());
  mocks.prisma.bookImport.findUnique.mockResolvedValue({ id: "import-1", status: "UPLOADED", format: "text" });
  mocks.prisma.bookImport.update.mockImplementation(async ({ data }) => {
    mocks.prisma.bookImport.findUnique.mockResolvedValue({ id: "import-1", projectId: project.id, format: "text", ...data });
    return {};
  });
  mocks.prisma.bookImport.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.generationJob.findUnique.mockResolvedValue({ status: "ACTIVE", steps: [] });
  mocks.prisma.generationJob.findFirst.mockResolvedValue({ id: "job-1" });
  mocks.prisma.generationJob.updateMany.mockImplementation(async () => {
    mocks.prisma.generationJob.findUnique.mockResolvedValue({ status: "COMPLETED", steps: [] });
    return { count: 1 };
  });
  mocks.prisma.project.update.mockImplementation(async ({ data }) => {
    mocks.prisma.project.findUnique.mockResolvedValue({ ...project, ...data, contentRevision: 1 });
    return {};
  });
  mocks.prisma.page.findMany.mockResolvedValue([]);
  mocks.prisma.chapter.create.mockResolvedValue({ id: "chapter-1" });
  mocks.prisma.planVersion.create.mockResolvedValue({ id: "plan-1" });
  mocks.prisma.$transaction.mockImplementation(async (run: (tx: typeof mocks.prisma) => Promise<unknown>) => run(mocks.prisma));
  await objectStore().put(objectKey("attachments", "import-1", "source"), manuscript);
});

describe("imported matter parsing hints", () => {
  it("keeps the upload's title-page extraction after the book's byline changes while queued", async () => {
    const uploaded = await parseManuscript({ data: manuscript, format: "text", knownAuthors: ["Jane Doe"] });
    expect(uploaded.bookTitle).toBe("The Long Winter");
    expect(uploaded.sections).toHaveLength(1);

    await runImport(job({ knownAuthors: ["Jane Doe"] }));

    expect(savedText()).toBe("Body text.");
    expect(mocks.prisma.chapter.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.project.update.mock.calls.every(([input]) => !("authorName" in input.data))).toBe(true);
  });

  it("preserves an explicitly empty hint set when a byline was added after upload", async () => {
    mocks.getProjectOrThrow.mockResolvedValue({ ...project, authorName: "Jane Doe" });
    const uploaded = await parseManuscript({ data: manuscript, format: "text", knownAuthors: [] });
    expect(uploaded.text).toContain("Jane Doe");

    await runImport(job({ knownAuthors: [] }));

    expect(savedText()).toContain("Jane Doe");
    expect(mocks.prisma.chapter.create).toHaveBeenCalledTimes(uploaded.sections.length);
  });

  it("still processes jobs created before parsing hints were recorded", async () => {
    mocks.getProjectOrThrow.mockResolvedValue({ ...project, authorName: "Jane Doe" });

    await runImport(job());

    expect(savedText()).toBe("Body text.");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(project.id, "plan-1", undefined, { contentRevision: 1, requireContentRevisionMatch: true });
  });
});

describe("legacy queued imports", () => {
  const source = Buffer.from("# The Long Winter\n\nA Valley Story\n\nBy Jane Doe\n\n# Dedication\n\nFor my mother\n\n# Copyright\n\n© 2020 Jane Doe\n\n# Chapter One\n\nBody text.\n\n# About the Author\n\nJane Doe writes books.");

  beforeEach(async () => {
    mocks.getProjectOrThrow.mockResolvedValue({ ...project, authorName: null });
    await objectStore().put(objectKey("attachments", "import-1", "source"), source);
  });

  it("drops only the refused legacy field and still imports the book", async () => {
    await objectStore().put(objectKey("attachments", "import-1", "source"), Buffer.from(
      "# Dedication\n\nFor my mother\n\n# Chapter One\n\nBody text.\n\n# About the Author\n\nThis author writes about CSAM."
    ));

    await runImport(job());

    const written = mocks.prisma.project.update.mock.calls[0]![0].data;
    expect(written.bookMatter).toEqual({ dedication: "For my mother" });
    expect(savedText()).toBe("Body text.");
    expect(mocks.prisma.planVersion.create).toHaveBeenCalledTimes(1);
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(project.id, "plan-1", undefined, { contentRevision: 1, requireContentRevisionMatch: true });
    expect(mocks.prisma.bookImport.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "COMPLETE" })
    }));
    expect(mocks.appendRunLog).toHaveBeenCalledExactlyOnceWith(IMPORT_MATTER_REFUSED_EVENT, {
      fields: [{ field: "aboutAuthor", reason: "critical_illegal_harm" }]
    });
    expect(JSON.stringify(mocks.appendRunLog.mock.calls)).not.toContain("CSAM");
  });

  it.each([false, true])("screens legacy restoration using the operator's copyright flag (%s)", async (enabled) => {
    mocks.prisma.safetySettingsRevision.findFirst.mockResolvedValue({ copyrightRestrictionsEnabled: enabled });
    await objectStore().put(objectKey("attachments", "import-1", "source"), Buffer.from(
      "# Dedication\n\nFor my mother\n\n# Chapter One\n\nBody text.\n\n# About the Author\n\nCopy the entire copyrighted book without permission."
    ));

    await runImport(job());

    const written = mocks.prisma.project.update.mock.calls[0]![0].data;
    expect(written.bookMatter.dedication).toBe("For my mother");
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalled();
    if (enabled) {
      expect(written.bookMatter).not.toHaveProperty("aboutAuthor");
      expect(mocks.appendRunLog).toHaveBeenCalledExactlyOnceWith(IMPORT_MATTER_REFUSED_EVENT, {
        fields: [{ field: "aboutAuthor", reason: "copyright" }]
      });
    } else {
      expect(written.bookMatter.aboutAuthor).toContain("copyrighted book");
      expect(mocks.appendRunLog).not.toHaveBeenCalled();
    }
  });

  it("fails the import when the copyright flag cannot be read, before any write", async () => {
    mocks.prisma.safetySettingsRevision.findFirst.mockRejectedValue(new Error("connection reset"));

    await expect(runImport(job())).rejects.toThrow("connection reset");

    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.prisma.bookImport.updateMany).toHaveBeenLastCalledWith({
      where: { id: "import-1", status: { not: "COMPLETE" } }, data: { status: "FAILED", error: "connection reset" }
    });
  });

  it("allows legacy memorial text as printed matter", async () => {
    await objectStore().put(objectKey("attachments", "import-1", "source"), Buffer.from(
      "# Dedication\n\nTo the victims of the terrorist attack, who taught us how to grieve.\n\n# Chapter One\n\nBody text.\n\n# About the Author\n\nOma escaped on a fake passport in 1939."
    ));

    await runImport(job());

    expect(mocks.maybeEnqueueCompile).toHaveBeenCalled();
    expect(mocks.prisma.project.update.mock.calls[0]![0].data.bookMatter.aboutAuthor).toContain("fake passport");
  });

  it("does not screen discarded legacy matter after an explicit reader clear", async () => {
    await objectStore().put(objectKey("attachments", "import-1", "source"), Buffer.from(
      "# Chapter One\n\nBody text.\n\n# About the Author\n\nThis author writes about CSAM."
    ));
    mocks.prisma.project.findUniqueOrThrow.mockResolvedValue({ ...project, bookMatter: {} });

    await runImport(job());

    expect(mocks.maybeEnqueueCompile).toHaveBeenCalled();
    expect(mocks.prisma.project.update.mock.calls.every(([input]) => !("bookMatter" in input.data))).toBe(true);
  });

  it.each(["UPLOADED", "FAILED"])("preserves extracted author and matter for a %s import", async (status) => {
    mocks.prisma.bookImport.findUnique.mockResolvedValue({ id: "import-1", status, format: "text" });

    await runImport(job());

    expect(savedText()).toBe("Body text.");
    expect(mocks.prisma.project.update).toHaveBeenCalledWith({
      where: { id: project.id },
      data: expect.objectContaining({
        authorName: "Jane Doe",
        subtitle: "A Valley Story",
        bookMatter: expect.objectContaining({
          dedication: "For my mother",
          copyrightYear: "2020",
          aboutAuthor: "Jane Doe writes books."
        })
      })
    });
    const plan = mocks.prisma.planVersion.create.mock.calls[0]![0].data;
    expect(plan.planningPackage).toMatchObject({ subtitle: "A Valley Story" });
    expect(plan.inputSnapshot).toMatchObject({ authorName: "Jane Doe", subtitle: "A Valley Story" });
    expect(mocks.prisma.$queryRaw).toHaveBeenCalled();
    expect(mocks.prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prisma.project.findUniqueOrThrow.mock.invocationCallOrder[0]!
    );
  });

  it.each([{}, { dedication: "For my father", aboutAuthor: "A new biography" }])(
    "preserves matter and author edits committed during parsing, including clears (%j)",
    async (bookMatter) => {
      // The initial project snapshot predates a reader edit. A cleared matter
      // snapshot is {}, not the null on imports created before this feature.
      mocks.prisma.project.findUniqueOrThrow.mockResolvedValue({
        ...project,
        authorName: null,
        bookMatter,
        mediaSettings: { mobile: { keep: "reader setting" } }
      });

      await runImport(job());

      const writes = mocks.prisma.project.update.mock.calls.map(([input]) => input.data);
      expect(writes.every((data) => !("authorName" in data) && !("bookMatter" in data))).toBe(true);
      expect(writes[0].mediaSettings.mobile.keep).toBe("reader setting");
      expect(mocks.prisma.planVersion.create.mock.calls[0]![0].data.inputSnapshot.authorName).toBeNull();
    }
  );

  it("preserves a legacy book's existing byline and subtitle", async () => {
    mocks.prisma.project.findUniqueOrThrow.mockResolvedValue({
      ...project,
      authorName: "Sam Lee",
      subtitle: "Reader's subtitle"
    });

    await runImport(job());

    const writes = mocks.prisma.project.update.mock.calls.map(([input]) => input.data);
    expect(writes.every((data) => !("authorName" in data) && !("subtitle" in data))).toBe(true);
    expect(writes[0].bookMatter.dedication).toBe("For my mother");
    expect(writes[0].bookMatter.copyrightHolder).toBe("Jane Doe");
    expect(mocks.prisma.planVersion.create.mock.calls[0]![0].data.inputSnapshot).toMatchObject({
      authorName: "Sam Lee", subtitle: "Reader's subtitle"
    });
  });

  it("does not restore cleared upload-time metadata on a modern payload", async () => {
    await runImport(job({ knownAuthors: [] }));

    const writes = mocks.prisma.project.update.mock.calls.map(([input]) => input.data);
    expect(writes.every((data) => !("authorName" in data) && !("bookMatter" in data) && !("subtitle" in data))).toBe(true);
  });

  it("does not reapply recovered matter after a committed import is redelivered", async () => {
    await runImport(job());
    vi.clearAllMocks();
    mocks.prisma.bookImport.findUnique.mockResolvedValue({ id: "import-1", projectId: project.id, status: "COMPLETE", format: "text", stats: { completion: { planVersionId: "plan-1", contentRevision: 1 } } });
    mocks.getProjectOrThrow.mockResolvedValue({ ...project, currentPlanId: "plan-1", authorName: null, bookMatter: {} });

    await runImport(job());

    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.project.update).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).toHaveBeenCalledWith(project.id, "plan-1", undefined, { contentRevision: 1, requireContentRevisionMatch: true });
  });
});
