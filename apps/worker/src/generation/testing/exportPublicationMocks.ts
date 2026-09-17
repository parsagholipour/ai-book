import { vi } from "vitest";

/**
 * The mocked database and filesystem behind `publishCompiledExports`, shared by
 * `exportPublication.test.ts` and `exportPublicationCompanions.test.ts`.
 *
 * Imports only `vitest`: the `vi.mock` factories that consume it `await import`
 * this module from inside the mock registry, so anything it reached that
 * transitively imported a mocked module would deadlock the suite rather than
 * fail it (the same rule `apps/api`'s `mobileApiMocks.ts` lives under).
 */

export const mocks = {
  prisma: {
    project: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    generationJob: { count: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    generationAttempt: { updateMany: vi.fn(), findUnique: vi.fn() },
    bookEditOperation: { updateMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    voiceCharacter: { count: vi.fn() },
    $transaction: vi.fn()
  },
  transfer: vi.fn(),
  rm: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  /** Ordered trace of everything the publication does, commit included. */
  events: [] as string[]
};

export const dbModuleMock = () => ({ prisma: mocks.prisma });

export const fsModuleMock = () => ({
  rm: mocks.rm,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile
});

/** What each render wrote, keyed by the scratch path it wrote it to. */
export const RENDERED: Record<string, Buffer> = {
  "/books/project-1/.book-token.md": Buffer.from("# New manuscript"),
  "/books/project-1/.book-token.pdf": Buffer.from("%PDF-token"),
  "/books/project-1/.book-token.epub": Buffer.from("epub-token"),
  "/books/project-1/.book-token.docx": Buffer.from("docx-token")
};

/** The row's text-edit invalidation barrier; null is what a healthy project has. */
export const publicationState: { barrier: number | null } = { barrier: null };

export const writtenRecords = () =>
  (mocks.writeFile.mock.calls as [path: string, contents: string][])
    .filter(([path]) => path.endsWith(".provenance.json"))
    .map(([path, contents]) => [path, JSON.parse(contents)] as const);

/** Predecessors are parked under a per-publication name; the uuid is not the point. */
export const stable = (path: string) => path.replace(/\.book-superseded-[^.]+\./, ".book-superseded.");

export const transferCalls = () => mocks.transfer.mock.calls as [from: string, to: string][];
export const rmPaths = () => (mocks.rm.mock.calls as [path: string][]).map(([path]) => path);

/** Postgres' verdict for one row: `"col" <> $1` is UNKNOWN — never true — for a null column. */
export const claimMatchesBarrier = (where: Record<string, unknown>, value: number | null): boolean =>
  ((where.OR as Record<string, unknown>[] | undefined) ?? [where]).some((arm) => {
    const filter = arm.exportInvalidationRevision as null | { not: number } | undefined;
    return filter === undefined ? true : filter === null ? value === null : value !== null && value !== filter.not;
  });

/** The `beforeEach` both suites share: a healthy project, an empty trace, every read answered. */
export function resetExportPublicationMocks(): void {
  vi.clearAllMocks();
  mocks.events.length = 0;
  publicationState.barrier = null;
  staged.clear();
  // A transaction that records its own commit, so a test can say when the
  // status write became visible relative to the files it describes.
  mocks.prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
    try {
      const result = await callback(mocks.prisma);
      mocks.events.push("commit");
      return result;
    } catch (error) {
      mocks.events.push("rollback");
      throw error;
    }
  });
  mocks.prisma.project.updateMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    mocks.events.push("claim");
    return { count: claimMatchesBarrier(where, publicationState.barrier) ? 1 : 0 };
  });
  mocks.prisma.project.update.mockResolvedValue({});
  mocks.prisma.generationJob.updateMany.mockImplementation(async () => {
    mocks.events.push("claim job");
    return { count: 1 };
  });
  mocks.prisma.generationJob.count.mockResolvedValue(0);
  mocks.prisma.generationJob.findFirst.mockResolvedValue(null);
  mocks.prisma.generationJob.findUnique.mockResolvedValue({ payload: { planId: "plan-1", contentRevision: 7 } });
  mocks.prisma.generationJob.upsert.mockResolvedValue({ id: "character-job-1", status: "QUEUED" });
  mocks.prisma.generationAttempt.updateMany.mockImplementation(async () => {
    mocks.events.push("settle attempt");
    return { count: 1 };
  });
  mocks.prisma.generationAttempt.findUnique.mockResolvedValue(null);
  mocks.prisma.bookEditOperation.updateMany.mockImplementation(async () => {
    mocks.events.push("settle edit");
    return { count: 1 };
  });
  mocks.prisma.bookEditOperation.findUnique.mockResolvedValue(null);
  mocks.prisma.bookEditOperation.findFirst.mockResolvedValue(null);
  mocks.prisma.voiceCharacter.count.mockResolvedValue(0);
  mocks.transfer.mockImplementation(async (_from: string, to: string) => {
    mocks.events.push(`transfer ${stable(to)}`);
  });
  mocks.rm.mockResolvedValue(undefined);
  mocks.readFile.mockImplementation(async (path: string) => {
    const rendered = RENDERED[path] ?? staged.get(path);
    if (!rendered) {
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    }
    return rendered;
  });
  mocks.writeFile.mockImplementation(async (path: string, data: string) => {
    staged.set(path, Buffer.from(data));
    mocks.events.push(`record ${path.split("/").pop()}`);
  });
}


const staged = new Map<string, Buffer>();
/** Records upload/copy transitions without pretending S3 has POSIX rename. */
export const objectStoreMock = () => ({
  copy: async (from: string, to: string) => { await mocks.transfer(from, to); },
  put: async (key: string, data: Buffer) => {
    const source = [...Object.entries(RENDERED), ...staged.entries()].find(([, bytes]) => bytes.equals(data))?.[0];
    if (!source) throw new Error(`Unknown staged bytes for ${key}`);
    await mocks.transfer(source, key);
  },
  delete: async (key: string) => { await mocks.rm(key); }
});
