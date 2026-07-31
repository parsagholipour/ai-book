import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, creditPricing, resetCreditPricing } from "@book-maker/core";
import {
  CreditPricingConflictError,
  getCreditPricingState,
  listCreditPricingRevisions,
  loadCreditPricing,
  revertCreditPricing,
  saveCreditPricing
} from "./creditPricing.ts";

type Row = {
  id: string;
  version: number;
  values: unknown;
  changed: unknown;
  note: string | null;
  updatedBy: string | null;
  createdAt: Date;
};

const fakeDb = vi.hoisted(() => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }

  const state = {
    rows: [] as Array<{
      id: string;
      version: number;
      values: unknown;
      changed: unknown;
      note: string | null;
      updatedBy: string | null;
      createdAt: Date;
    }>,
    seq: 0,
    /** Set to have the next create() fail the way a racing writer would. */
    stealVersionOnNextCreate: false,
    /** Set to have the next create() blow up after the row would have landed. */
    throwAfterCreate: false
  };

  const byVersionDesc = () => [...state.rows].sort((a, b) => b.version - a.version);

  const prisma = {
    creditPricingRevision: {
      findFirst: vi.fn(async () => byVersionDesc()[0] ?? null),
      findUnique: vi.fn(async ({ where }: { where: { version: number } }) =>
        state.rows.find((row) => row.version === where.version) ?? null
      ),
      findMany: vi.fn(async ({ take }: { take?: number }) => byVersionDesc().slice(0, take ?? 20)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (state.stealVersionOnNextCreate) {
          state.stealVersionOnNextCreate = false;
          // Simulate the racing writer having already taken this version.
          state.seq += 1;
          state.rows.push({
            id: `stolen-${state.seq}`,
            version: data.version as number,
            values: { ...DEFAULT_CREDIT_COSTS, planRevision: 999 },
            changed: { planRevision: { from: DEFAULT_CREDIT_COSTS.planRevision, to: 999 } },
            note: "racing writer",
            updatedBy: null,
            createdAt: new Date()
          });
          throw new PrismaClientKnownRequestError("P2002");
        }
        if (state.throwAfterCreate) {
          state.throwAfterCreate = false;
          throw new Error("write failed after the row was staged");
        }
        state.seq += 1;
        const row = {
          id: `rev-${state.seq}`,
          version: data.version as number,
          values: data.values,
          changed: data.changed,
          note: (data.note as string | undefined) ?? null,
          updatedBy: (data.updatedBy as string | undefined) ?? null,
          createdAt: new Date(2026, 0, state.seq)
        };
        state.rows.push(row);
        return row;
      })
    }
  };

  return { state, prisma, Prisma: { PrismaClientKnownRequestError } };
});

vi.mock("./client.ts", () => ({ prisma: fakeDb.prisma, Prisma: fakeDb.Prisma }));

beforeEach(() => {
  fakeDb.state.rows.length = 0;
  fakeDb.state.seq = 0;
  fakeDb.state.stealVersionOnNextCreate = false;
  fakeDb.state.throwAfterCreate = false;
  vi.clearAllMocks();
  resetCreditPricing();
});

afterEach(() => {
  resetCreditPricing();
});

describe("loadCreditPricing", () => {
  it("uses the compiled defaults when nothing has ever been saved", async () => {
    const state = await loadCreditPricing();
    expect(state.version).toBe(0);
    expect(state.values).toEqual({ ...DEFAULT_CREDIT_COSTS });
    expect(creditPricing()).toEqual({ ...DEFAULT_CREDIT_COSTS });
    expect(fakeDb.prisma.creditPricingRevision.create).not.toHaveBeenCalled();
  });

  it("makes the stored prices live", async () => {
    await saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: 90 } });
    resetCreditPricing();

    const state = await loadCreditPricing();

    expect(state.values.imageGeneration).toBe(90);
    expect(creditPricing().imageGeneration).toBe(90);
  });

  it("falls back per key rather than refusing to boot on a malformed row", async () => {
    fakeDb.state.rows.push({
      id: "rev-junk",
      version: 4,
      values: { imageGeneration: -1, exportUnlock: 200, mystery: 7 },
      changed: {},
      note: null,
      updatedBy: null,
      createdAt: new Date()
    } satisfies Row);

    const state = await loadCreditPricing();

    expect(state.values.imageGeneration).toBe(DEFAULT_CREDIT_COSTS.imageGeneration);
    expect(state.values.exportUnlock).toBe(200);
    expect(state.values).not.toHaveProperty("mystery");
  });
});

describe("saveCreditPricing", () => {
  it("records a revision, bumps the version, and applies the change", async () => {
    const result = await saveCreditPricing({
      values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: 90 },
      updatedBy: "local-admin",
      note: "Gemini raised image prices"
    });

    expect(result.applied).toBe(true);
    expect(result.version).toBe(1);
    expect(result.changed).toEqual({
      imageGeneration: { from: DEFAULT_CREDIT_COSTS.imageGeneration, to: 90 }
    });
    expect(creditPricing().imageGeneration).toBe(90);
  });

  it("records only the keys that moved", async () => {
    await saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: 90 } });
    const second = await saveCreditPricing({
      values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: 90, exportUnlock: 200 }
    });

    expect(second.version).toBe(2);
    expect(second.changed).toEqual({ exportUnlock: { from: DEFAULT_CREDIT_COSTS.exportUnlock, to: 200 } });
  });

  it("writes nothing when the values already match", async () => {
    await saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: 90 } });
    vi.clearAllMocks();

    const repeat = await saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: 90 } });

    expect(repeat.applied).toBe(false);
    expect(repeat.version).toBe(1);
    expect(fakeDb.prisma.creditPricingRevision.create).not.toHaveBeenCalled();
  });

  it("refuses a save from a stale editor", async () => {
    await saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: 90 } });

    await expect(
      saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: 30 }, expectedVersion: 0 })
    ).rejects.toBeInstanceOf(CreditPricingConflictError);
    expect(creditPricing().imageGeneration).toBe(90);
  });

  it("retries on top of a racing writer that claimed the version first", async () => {
    fakeDb.state.stealVersionOnNextCreate = true;

    const result = await saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, exportUnlock: 200 } });

    expect(result.version).toBe(2);
    expect(result.applied).toBe(true);
    // A save carries the whole price list, so without `expectedVersion` the last
    // writer wins outright — and the diff says so rather than hiding it: the
    // racing writer's planRevision: 999 is recorded as being rolled back.
    expect(result.changed).toEqual({
      exportUnlock: { from: DEFAULT_CREDIT_COSTS.exportUnlock, to: 200 },
      planRevision: { from: 999, to: DEFAULT_CREDIT_COSTS.planRevision }
    });
  });

  it("turns that race into a conflict instead, for an editor that sent its version", async () => {
    // The retry re-checks staleness, so a client that opted into optimistic
    // concurrency is told to reload rather than silently clobbering the winner.
    fakeDb.state.stealVersionOnNextCreate = true;

    await expect(
      saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, exportUnlock: 200 }, expectedVersion: 0 })
    ).rejects.toBeInstanceOf(CreditPricingConflictError);
  });

  it("leaves the live prices alone when the write fails", async () => {
    // The whole reason the snapshot is applied after the write and not inside it.
    fakeDb.state.throwAfterCreate = true;

    await expect(saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, exportUnlock: 999 } })).rejects.toThrow(
      /write failed/
    );
    expect(creditPricing().exportUnlock).toBe(DEFAULT_CREDIT_COSTS.exportUnlock);
  });
});

describe("revertCreditPricing", () => {
  it("restores old values as a new forward revision", async () => {
    await saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: 90 } });
    await saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, imageGeneration: 300 } });

    const reverted = await revertCreditPricing({ version: 1 });

    expect(reverted.version).toBe(3);
    expect(reverted.values.imageGeneration).toBe(90);
    expect(creditPricing().imageGeneration).toBe(90);
    // History is never rewritten.
    expect((await listCreditPricingRevisions()).map((row) => row.version)).toEqual([3, 2, 1]);
  });

  it("rejects a version that was never written", async () => {
    await expect(revertCreditPricing({ version: 42 })).rejects.toThrow(/42/);
  });
});

describe("getCreditPricingState", () => {
  it("reports the head without disturbing the live prices", async () => {
    await saveCreditPricing({ values: { ...DEFAULT_CREDIT_COSTS, exportUnlock: 200 }, note: "launch promo" });
    resetCreditPricing();

    const state = await getCreditPricingState();

    expect(state.version).toBe(1);
    expect(state.note).toBe("launch promo");
    expect(state.values.exportUnlock).toBe(200);
    expect(creditPricing().exportUnlock).toBe(DEFAULT_CREDIT_COSTS.exportUnlock);
  });
});
