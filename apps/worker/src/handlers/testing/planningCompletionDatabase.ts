import { vi } from "vitest";

type Row = Record<string, unknown>;
type Query = { where?: Row; data?: Row | Row[]; orderBy?: Row[] };

/** Transactional database boundary for the real planning/processor/lifecycle regression. */
export function planningCompletionDatabase() {
  let tables: Record<string, Row[]> = {};
  let inTransaction = false;
  const controls = {
    failReadyOutsideTransaction: false,
    failReady: false,
    failAttemptSuccess: false,
    crashAfterCommit: false,
    commits: [] as Record<string, Row[]>[]
  };
  function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
      const actual = row[key];
      if (value instanceof Date) return actual instanceof Date && actual.getTime() === value.getTime();
      if (value && typeof value === "object") {
        const condition = value as Row;
        if (Array.isArray(condition.in)) return condition.in.includes(actual);
        if (Array.isArray(condition.notIn)) return !condition.notIn.includes(actual);
        if ("not" in condition) return actual !== condition.not;
      }
      return actual === value;
    });
  }
  function update(table: string, row: Row, data: Row) {
    if (table === "project" && data.status === "PLAN_READY" &&
      (controls.failReady || (controls.failReadyOutsideTransaction && !inTransaction))) {
      throw new Error("database unavailable for PLAN_READY");
    }
    if (table === "generationAttempt" && data.status === "SUCCEEDED" && controls.failAttemptSuccess) {
      throw new Error("attempt settlement unavailable");
    }
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        row[key] = Number(row[key] ?? 0) + Number(value.increment);
      } else row[key] = value;
    }
    return { ...row };
  }
  function model(table: string) {
    const rows = () => tables[table] ??= [];
    const find = (query: Query = {}) => rows().filter((row) => matches(row, query.where));
    return {
      findUnique: vi.fn(async (query: Query) => find(query)[0] ?? null),
      findMany: vi.fn(async (query?: Query) => find(query)),
      findFirst: vi.fn(async (query: Query) => {
        const found = find(query);
        for (const order of [...(query.orderBy ?? [])].reverse()) {
          const [key, direction] = Object.entries(order)[0]!;
          found.sort((a, b) => {
            const left = a[key], right = b[key];
            const compared = left instanceof Date && right instanceof Date
              ? left.getTime() - right.getTime()
              : String(left).localeCompare(String(right));
            return compared * (direction === "desc" ? -1 : 1);
          });
        }
        return found[0] ?? null;
      }),
      update: vi.fn(async (query: Query) => {
        const row = find(query)[0];
        if (!row) throw new Error(`Missing ${table}`);
        return update(table, row, query.data as Row);
      }),
      updateMany: vi.fn(async (query: Query) => {
        const found = find(query);
        found.forEach((row) => update(table, row, query.data as Row));
        return { count: found.length };
      }),
      create: vi.fn(async (query: Query) => {
        const row = { id: `${table}-${rows().length + 1}`, ...query.data };
        rows().push(row);
        return row;
      }),
      createMany: vi.fn(async (query: Query) => {
        rows().push(...query.data as Row[]);
        return { count: (query.data as Row[]).length };
      }),
      deleteMany: vi.fn(async (query: Query) => {
        tables[table] = rows().filter((row) => !matches(row, query.where));
      })
    };
  }
  const prisma = {
    project: model("project"), generationJob: model("generationJob"),
    generationAttempt: model("generationAttempt"), planVersion: model("planVersion"),
    character: model("character"), location: model("location"),
    researchSource: model("researchSource"), embedding: model("embedding"),
    bookEditOperation: model("bookEditOperation"),
    $executeRawUnsafe: vi.fn(async () => 1),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      const before = structuredClone(tables);
      inTransaction = true;
      let result: unknown;
      try { result = await run(prisma); }
      catch (error) { tables = before; throw error; }
      finally { inTransaction = false; }
      controls.commits.push(structuredClone(tables));
      if (controls.crashAfterCommit) throw new Error("process lost after commit");
      return result;
    })
  };
  function reset() {
    tables = {
      project: [{ id: "project-1", status: "PLANNING", currentPlanId: null, contentRevision: 0,
        updatedAt: new Date("2026-01-01"), title: "Working title", prompt: "A guide to backyard birds with enough detail.",
        category: "SCIENCE", targetPages: 12, complexity: 5, temperature: 0.7, language: "en", mediaSettings: {} }],
      generationJob: [{ id: "gj-1", projectId: "project-1", attemptId: "attempt-1", type: "PLAN_BOOK",
        status: "QUEUED", contentRevision: 0, createdAt: new Date("2026-01-01"), payload: {}, steps: [] }],
      generationAttempt: [{ id: "attempt-1", projectId: "project-1", primaryJobId: "gj-1", status: "QUEUED", refundPending: false }]
    };
    Object.assign(controls, { failReadyOutsideTransaction: false, failReady: false, failAttemptSuccess: false, crashAfterCommit: false, commits: [] });
  }
  return { prisma, controls, reset, rows: (name: string) => tables[name] ??= [], row: (name: string) => tables[name]![0]! };
}
