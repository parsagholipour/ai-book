import { mockPrisma, mockQueue, MockPrismaKnownRequestError } from "./mobileApiMocks.js";
import { jobRecord, state } from "./mobileApiHarness.js";

/**
 * An in-memory store behind the Writing Studio's Prisma calls, for the suites
 * in `manuscript*.test.ts`.
 *
 * The Studio is bookkeeping across six tables — a working copy, its chapters
 * and versions, and the book's `Chapter`, `Page` and `PlanVersion` rows it
 * publishes into — and "publish grows the book, then shrinks it, reusing rows
 * by position" is a claim about what those rows hold afterwards. Call-argument
 * assertions against bare mocks could not make it, so this backs the shared
 * `mockPrisma` delegates with rows instead: a small `where` matcher, the three
 * raw statements publish issues (recognised by the tag comment each opens
 * with), and a transaction that really rolls back, by snapshot.
 *
 * Install it from `beforeEach` *after* `resetMobileHarness`, which resets every
 * mock this replaces. It reuses the harness's `state.bookEditOperations` and
 * `state.projectChatMessages`, so the chat and undo code paths read the same
 * rows publish sealed.
 */

type Row = Record<string, any>;

export type ManuscriptFakeDb = {
  projects: Row[];
  manuscripts: Row[];
  manuscriptChapters: Row[];
  versions: Row[];
  bookChapters: Row[];
  pages: Row[];
  images: Row[];
  planVersions: Row[];
  characters: Row[];
  /** `ManuscriptAssist` rows (Phase 2). */
  assists: Row[];
  /** The user's `LibraryCharacter` rows, for the cast. */
  libraryCharacters: Row[];
  enqueued: Row[];
};

let clock = 0;
/** Strictly increasing timestamps, so "newest first" is never a tie. */
function tick(): Date {
  clock += 1;
  return new Date(Date.now() + clock);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function same(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right || (left == null && right == null);
}

/** Prisma's scalar filters, as far as the Studio code uses them. */
function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined;
  if (!isPlainObject(condition)) return same(value, condition);
  return Object.entries(condition).every(([operator, operand]) => {
    switch (operator) {
      case "in":
        return (operand as unknown[]).some((candidate) => same(value, candidate));
      case "notIn":
        return !(operand as unknown[]).some((candidate) => same(value, candidate));
      case "not":
        return operand === null ? value !== null && value !== undefined : !matchesCondition(value, operand);
      case "gt":
        return (value as number) > (operand as number);
      case "gte":
        return (value as number) >= (operand as number);
      case "lt":
        return (value as number) < (operand as number);
      case "lte":
        return (value as number) <= (operand as number);
      case "startsWith":
        return typeof value === "string" && value.startsWith(operand as string);
      case "contains":
        return typeof value === "string" && value.includes(operand as string);
      case "equals":
        return same(value, operand);
      default:
        // A relation filter (`project: { userId }`) — the Studio code never
        // relies on one to separate rows these suites hold.
        return true;
    }
  });
}

export function matchesWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Record<string, unknown>[]).some((clause) => matchesWhere(row, clause));
    if (key === "AND") return (condition as Record<string, unknown>[]).every((clause) => matchesWhere(row, clause));
    if (key === "NOT") return !matchesWhere(row, condition as Record<string, unknown>);
    return matchesCondition(row[key], condition);
  });
}

function compare(left: unknown, right: unknown): number {
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function ordered(rows: Row[], orderBy: unknown): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, "asc" | "desc">[];
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const [field, direction] = Object.entries(key)[0] ?? [];
      if (!field) continue;
      const result = compare(left[field], right[field]);
      if (result !== 0) return direction === "desc" ? -result : result;
    }
    return 0;
  });
}

function query(rows: Row[], args: Row = {}): Row[] {
  const filtered = ordered(rows.filter((row) => matchesWhere(row, args.where)), args.orderBy);
  const skipped = typeof args.skip === "number" ? filtered.slice(args.skip) : filtered;
  return (typeof args.take === "number" ? skipped.slice(0, args.take) : skipped).map((row) => ({ ...row }));
}

/** `data` applied to a row, with Prisma's `{ increment }` / `{ decrement }` forms. */
function applyData(row: Row, data: Row): Row {
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value) && "increment" in value) row[key] = (row[key] ?? 0) + value.increment;
    else if (isPlainObject(value) && "decrement" in value) row[key] = (row[key] ?? 0) - value.decrement;
    else if (value === "DbNull") row[key] = null;
    else row[key] = value;
  }
  if ("updatedAt" in row) row.updatedAt = tick();
  return row;
}

function uniqueConflict(): Error {
  return new MockPrismaKnownRequestError("Unique constraint failed", { code: "P2002" });
}

function table(rows: () => Row[], defaults: (data: Row) => Row, unique: Array<(row: Row, data: Row) => boolean> = []) {
  const create = async ({ data, select }: Row) => {
    if (rows().some((row) => row.id === data.id || unique.some((clash) => clash(row, data)))) {
      throw uniqueConflict();
    }
    const now = tick();
    const row = { createdAt: now, updatedAt: now, ...defaults(data), ...data };
    row.id ??= `row-${rows().length + 1}-${clock}`;
    rows().push(row);
    return select ? { ...row } : { ...row };
  };
  return {
    findUnique: async (args: Row) => query(rows(), args)[0] ?? null,
    findFirst: async (args: Row = {}) => query(rows(), args)[0] ?? null,
    findMany: async (args: Row = {}) => query(rows(), args),
    count: async (args: Row = {}) => query(rows(), args).length,
    create,
    createMany: async ({ data }: Row) => {
      for (const entry of data as Row[]) await create({ data: entry });
      return { count: (data as Row[]).length };
    },
    update: async ({ where, data }: Row) => {
      const row = rows().find((candidate) => matchesWhere(candidate, where));
      if (!row) throw new MockPrismaKnownRequestError("Record to update not found", { code: "P2025" });
      return { ...applyData(row, data) };
    },
    updateMany: async ({ where, data }: Row) => {
      const matched = rows().filter((row) => matchesWhere(row, where));
      for (const row of matched) applyData(row, data);
      return { count: matched.length };
    },
    deleteMany: async ({ where }: Row = {}) => {
      const doomed = rows().filter((row) => matchesWhere(row, where));
      const kept = rows().filter((row) => !doomed.includes(row));
      rows().splice(0, rows().length, ...kept);
      return { count: doomed.length };
    }
  };
}

function snapshot(db: ManuscriptFakeDb) {
  return {
    db: structuredClone(db),
    operations: structuredClone(state.bookEditOperations),
    messages: structuredClone(state.projectChatMessages)
  };
}

function restore(db: ManuscriptFakeDb, saved: ReturnType<typeof snapshot>): void {
  for (const key of Object.keys(db) as Array<keyof ManuscriptFakeDb>) {
    db[key].splice(0, db[key].length, ...saved.db[key]);
  }
  state.bookEditOperations = saved.operations;
  state.projectChatMessages = saved.messages;
}

/** The three raw statements publish issues, applied to rows. */
function rawWrite(db: ManuscriptFakeDb, strings: readonly string[], values: unknown[]): number {
  const sql = strings.join("?");
  if (sql.includes("studio:update-pages")) {
    const [ids, titles, markdowns, summaries, chapterIds] = values as string[][];
    let count = 0;
    ids!.forEach((id, index) => {
      const page = db.pages.find((row) => row.id === id);
      if (!page) return;
      Object.assign(page, {
        title: titles![index],
        markdown: markdowns![index],
        summary: summaries![index],
        chapterId: chapterIds![index],
        imagePrompt: null,
        imageFailureReason: null,
        qualityReport: null,
        storyDelta: null,
        status: "COMPLETED",
        revision: page.revision + 1,
        updatedAt: tick()
      });
      count += 1;
    });
    return count;
  }
  if (sql.includes("studio:update-chapters")) {
    const [ids, titles, summaries, targets] = values as unknown[][];
    let count = 0;
    (ids as string[]).forEach((id, index) => {
      const chapter = db.bookChapters.find((row) => row.id === id);
      if (!chapter) return;
      Object.assign(chapter, {
        title: titles![index],
        summary: summaries![index],
        targetPages: targets![index],
        productionBrief: null,
        status: "COMPLETED"
      });
      count += 1;
    });
    return count;
  }
  if (sql.includes("studio:takeover-pages")) {
    // A takeover rewrites a page's text and chapter only; everything else it
    // resets goes through `page.updateMany`.
    const [ids, markdowns, chapterIds] = values as Array<Array<string | null>>;
    let count = 0;
    ids!.forEach((id, index) => {
      const page = db.pages.find((row) => row.id === id);
      if (!page) return;
      Object.assign(page, {
        markdown: markdowns![index],
        chapterId: chapterIds![index],
        revision: page.revision + 1,
        updatedAt: tick()
      });
      count += 1;
    });
    return count;
  }
  if (sql.includes("studio:seal-operations")) {
    const [sealedAt, projectId] = values as string[];
    let count = 0;
    for (const operation of state.bookEditOperations) {
      const classifier = operation.classifier;
      if (
        operation.projectId === projectId &&
        operation.status === "APPLIED" &&
        isPlainObject(classifier) &&
        classifier.sealedAt === undefined
      ) {
        operation.classifier = { ...classifier, sealedAt };
        count += 1;
      }
    }
    return count;
  }
  const bound = values.find((value): value is unknown[] => Array.isArray(value));
  return bound?.length ?? 0;
}

/** Points each existing mock at the store, so `vi.resetAllMocks()` still resets it between tests. */
function install(delegate: Record<string, any>, methods: Record<string, (...args: any[]) => unknown>): void {
  for (const [name, method] of Object.entries(methods)) {
    const mock = delegate[name];
    if (mock && typeof mock.mockImplementation === "function") {
      mock.mockImplementation(method);
    }
  }
}

/**
 * Installs the store behind `mockPrisma` and returns it. The rows are plain
 * objects a test may seed or read directly.
 */
export function installManuscriptFakeDb(): ManuscriptFakeDb {
  const db: ManuscriptFakeDb = {
    projects: [],
    manuscripts: [],
    manuscriptChapters: [],
    versions: [],
    bookChapters: [],
    pages: [],
    images: [],
    planVersions: [],
    characters: [],
    assists: [],
    libraryCharacters: [],
    enqueued: []
  };

  const projects = table(() => db.projects, () => ({ status: "DRAFT", contentRevision: 0, currentPlanId: null, pdfPageMap: null }));
  const withRelations = (project: Row | null): Row | null => {
    if (!project) return null;
    const manuscript = db.manuscripts.find((row) => row.projectId === project.id);
    return {
      ...project,
      currentPlan: db.planVersions.find((row) => row.id === project.currentPlanId) ?? null,
      images: db.images.filter((row) => row.projectId === project.id && row.type === "COVER"),
      _count: {
        pages: db.pages.filter((row) => row.projectId === project.id).length,
        images: db.images.filter((row) => row.projectId === project.id).length,
        jobs: 0
      },
      manuscript: manuscript
        ? {
            ...manuscript,
            chapters: ordered(
              db.manuscriptChapters.filter((row) => row.manuscriptId === manuscript.id && row.deletedAt === null),
              { position: "asc" }
            )
          }
        : null
    };
  };
  install(mockPrisma.project, {
    ...projects,
    findUnique: async (args: Row) => withRelations(await projects.findUnique(args)),
    findFirst: async (args: Row) => withRelations(await projects.findFirst(args)),
    findMany: async (args: Row) => (await projects.findMany(args)).map(withRelations)
  });

  const manuscripts = table(
    () => db.manuscripts,
    () => ({ revision: 1, publishedOrder: null, firstPublishedAt: null, lastPublishedAt: null, lastPublishRequestId: null }),
    [(row, data) => row.projectId === data.projectId]
  );
  const chaptersOf = (manuscriptId: string, relations: Row | undefined): Row[] => {
    const spec = isPlainObject(relations?.chapters) ? relations!.chapters : {};
    return query(
      db.manuscriptChapters.filter((row) => row.manuscriptId === manuscriptId),
      { where: spec.where, orderBy: spec.orderBy ?? { position: "asc" } }
    );
  };
  install(mockPrisma.manuscript, {
    ...manuscripts,
    findUnique: async (args: Row) => {
      const row = await manuscripts.findUnique(args);
      const relations = args.include ?? args.select;
      return row && relations?.chapters ? { ...row, chapters: chaptersOf(row.id, relations) } : row;
    }
  });

  const chapters = table(
    () => db.manuscriptChapters,
    () => ({
      notes: "",
      status: "DRAFTING",
      wordCount: 0,
      revision: 1,
      publishedRevision: null,
      publishedChapterId: null,
      publishedPages: null,
      conflictTitle: null,
      conflictMarkdown: null,
      conflictDetectedAt: null,
      deletedAt: null
    })
  );
  install(mockPrisma.manuscriptChapter, {
    ...chapters,
    deleteMany: async (args: Row) => {
      const doomed = db.manuscriptChapters.filter((row) => matchesWhere(row, args.where)).map((row) => row.id);
      db.versions.splice(0, db.versions.length, ...db.versions.filter((row) => !doomed.includes(row.chapterId)));
      return chapters.deleteMany(args);
    }
  });

  install(mockPrisma.manuscriptVersion, table(() => db.versions, () => ({})));
  install(
    mockPrisma.chapter,
    table(() => db.bookChapters, () => ({ productionBrief: null }), [
      (row, data) => row.projectId === data.projectId && row.index === data.index
    ])
  );

  const pages = table(
    () => db.pages,
    () => ({ revision: 1, imagePrompt: null, imageFailureReason: null, qualityReport: null, storyDelta: null }),
    [(row, data) => row.projectId === data.projectId && row.index === data.index]
  );
  install(mockPrisma.page, {
    ...pages,
    deleteMany: async (args: Row) => {
      const doomed = db.pages.filter((row) => matchesWhere(row, args.where)).map((row) => row.id);
      for (const image of db.images) if (doomed.includes(image.pageId)) image.pageId = null;
      return pages.deleteMany(args);
    }
  });

  install(mockPrisma.imageAsset, table(() => db.images, () => ({ metadata: {}, prompt: "", provider: "test" })));
  install(
    mockPrisma.planVersion,
    table(() => db.planVersions, () => ({ messages: [] }), [
      (row, data) => row.projectId === data.projectId && row.version === data.version
    ])
  );
  install(mockPrisma.character, table(() => db.characters, () => ({})));
  install(
    mockPrisma.manuscriptAssist,
    table(
      () => db.assists,
      () => ({ status: "QUEUED", result: null, error: null, creditsCharged: 0, ledgerEntryId: null, chapterId: null }),
      [(row, data) => row.projectId === data.projectId && row.requestId === data.requestId]
    )
  );
  const libraryCharacters = table(() => db.libraryCharacters, () => ({ appearance: null, fields: [] }));
  install(mockPrisma.libraryCharacter, {
    ...libraryCharacters,
    // The mention include, answered empty: no cast description here names anybody.
    findMany: async (args: Row) =>
      (await libraryCharacters.findMany(args)).map((row) => (args?.include ? { outgoingMentions: [], ...row } : row))
  });

  mockPrisma.bookEditOperation.count.mockImplementation(async ({ where }: Row) =>
    state.bookEditOperations.filter((operation) => matchesWhere(operation, where)).length
  );

  mockPrisma.$executeRaw.mockImplementation(async (strings: readonly string[], ...values: unknown[]) =>
    rawWrite(db, strings, values)
  );

  const runTransaction = mockPrisma.$transaction.getMockImplementation();
  mockPrisma.$transaction.mockImplementation(async (...args: unknown[]) => {
    if (Array.isArray(args[0])) return runTransaction!(...args);
    const saved = snapshot(db);
    try {
      return await runTransaction!(...args);
    } catch (error) {
      restore(db, saved);
      throw error;
    }
  });

  // A counter rather than the list's length, so a suite that empties
  // `db.enqueued` between steps never hands out an id twice.
  let jobCounter = 0;
  mockQueue.enqueueGenerationJob.mockImplementation(async (options: Row) => {
    jobCounter += 1;
    const job = jobRecord({
      id: `job-${jobCounter}`,
      projectId: options.projectId,
      type: options.type,
      payload: options.payload,
      ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {})
    } as Row);
    db.enqueued.push({ ...job, contentRevision: options.contentRevision, dispatch: options.dispatch });
    return job;
  });

  return db;
}
