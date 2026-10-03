import { vi } from "vitest";
import { createBillingTestDb } from "./billingTestDb.ts";

/** Billing tables plus serializable, rollback-capable voice call transitions. */
export function createVoiceRelayTestDb() {
  const db = createBillingTestDb();
  const voice = { calls: new Map<string, Record<string, any>>(), enabled: true, seq: 0 };
  function matches(row: Record<string, any>, where: Record<string, any>): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === "OR") return value.some((part: Record<string, any>) => matches(row, part));
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if ("in" in value) return value.in.includes(row[key]);
        if ("not" in value) return row[key] !== value.not;
        if ("lte" in value) return row[key] != null && row[key] <= value.lte;
        throw new Error(`Unmodelled voice predicate: ${key}`);
      }
      return row[key] === value;
    });
  }
  const prisma = Object.assign(db.prisma, {
    user: { findUnique: vi.fn(async () => ({ status: voice.enabled ? "ACTIVE" : "DISABLED", disabledAt: null })) },
    voiceCall: {
      findFirst: vi.fn(async ({ where }: any) => {
        const row = [...voice.calls.values()].find((call) => matches(call, where));
        return row ? { ...row } : null;
      }),
      findMany: vi.fn(async ({ where, take }: any) => [...voice.calls.values()]
        .filter((call) => matches(call, where)).slice(0, take ?? 100).map((call) => ({ ...call }))),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `call-${++voice.seq}`, projectId: null, characterId: null, libraryCharacterId: null,
          status: "ACTIVE", reservationEntryIds: [], heldCredits: 0, chargedCredits: 0, elapsedSeconds: 0,
          relayTokenHash: null, relaySession: null, relayLeaseId: null, relayLeaseExpiresAt: null,
          relayConnectedAt: null, relayFundedSeconds: 0, relayReservedMinutes: 0, ...data
        };
        voice.calls.set(row.id, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = voice.calls.get(where.id);
        if (!row) throw new Error("Voice call missing");
        Object.assign(row, data);
        return { ...row };
      })
    }
  });
  function reset() {
    db.reset();
    voice.calls.clear(); voice.enabled = true; voice.seq = 0;
    let tail = Promise.resolve();
    prisma.$transaction.mockImplementation(async (work) => {
      const result = tail.then(async () => {
        const snapshot = structuredClone({ billing: db.state, voice });
        try { return await work(prisma); }
        catch (error) { Object.assign(db.state, snapshot.billing); Object.assign(voice, snapshot.voice); throw error; }
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    });
  }
  return { ...db, prisma, voice, reset, Prisma: { ...db.Prisma, DbNull: null } };
}
