import type { StudioImageSweepDb } from "../studioImageReferences.js";

/**
 * An in-memory stand-in for the Prisma delegates the Studio picture sweep
 * reads. It implements exactly the query shapes that module issues — equality,
 * `{ gt }`, `{ in }`, `{ contains }` (case-sensitive, like Postgres `LIKE`),
 * `OR`, a single-key `orderBy` and `take` — and throws on anything else, so a
 * new query shape fails loudly here instead of silently matching every row.
 */

type Row = Record<string, unknown>;

export type SweepTables = {
  project: Row[];
  manuscript: Row[];
  manuscriptChapter: Row[];
  manuscriptVersion: Row[];
  manuscriptAssist: Row[];
  page: Row[];
  pageEditSnapshot: Row[];
  archivedPageEditSnapshot: Row[];
  imageAsset: Row[];
  bookEditOperation: Row[];
  moderationReport: Row[];
};

export type FakeSweepDb = {
  db: StudioImageSweepDb;
  tables: SweepTables;
  /** Every `findMany` issued, by table, with its `where`. */
  reads: Array<{ table: keyof SweepTables; where: Row }>;
};

type Query = { where?: Row; orderBy?: Record<string, "asc" | "desc">; take?: number; select?: unknown };

export function fakeSweepDb(): FakeSweepDb {
  const tables: SweepTables = {
    project: [],
    manuscript: [],
    manuscriptChapter: [],
    manuscriptVersion: [],
    manuscriptAssist: [],
    page: [],
    pageEditSnapshot: [],
    archivedPageEditSnapshot: [],
    imageAsset: [],
    bookEditOperation: [],
    moderationReport: []
  };
  const reads: FakeSweepDb["reads"] = [];
  const delegate = (table: keyof SweepTables) => {
    const query = (options: Query): Row[] => {
      let rows = tables[table].filter((row) => matches(row, options.where ?? {}));
      if (options.orderBy) {
        const [[key, direction]] = Object.entries(options.orderBy) as [[string, "asc" | "desc"]];
        rows = [...rows].sort((a, b) => compare(a[key], b[key]) * (direction === "desc" ? -1 : 1));
      }
      return (options.take === undefined ? rows : rows.slice(0, options.take)).map((row) => ({ ...row }));
    };
    return {
      findMany: async (options: Query = {}) => {
        reads.push({ table, where: options.where ?? {} });
        return query(options);
      },
      findFirst: async (options: Query = {}) => query(options)[0] ?? null,
      findUnique: async (options: Query) => query(options)[0] ?? null
    };
  };
  const db = Object.fromEntries(
    (Object.keys(tables) as Array<keyof SweepTables>).map((table) => [table, delegate(table)])
  ) as unknown as StudioImageSweepDb;
  return { db, tables, reads };
}

function matches(row: Row, where: Row): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!(condition as Row[]).some((branch) => matches(row, branch))) return false;
      continue;
    }
    const value = row[key];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const operators = condition as Row;
      for (const [operator, operand] of Object.entries(operators)) {
        if (operator === "contains") {
          if (typeof value !== "string" || !value.includes(operand as string)) return false;
        } else if (operator === "gt") {
          if (compare(value, operand) <= 0) return false;
        } else if (operator === "in") {
          if (!(operand as unknown[]).includes(value)) return false;
        } else {
          throw new Error(`fakeSweepDb: unsupported operator ${operator} on ${key}`);
        }
      }
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

function compare(a: unknown, b: unknown): number {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  return (left as string | number) < (right as string | number) ? -1 : 1;
}
