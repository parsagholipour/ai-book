import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  planningPackage: {} as Record<string, unknown>,
  prepJob: null as null | { id: string; status: string }
}));

vi.mock("@book-maker/db", () => ({
  prisma: {
    planVersion: {
      findUnique: vi.fn(async () => ({ planningPackage: structuredClone(store.planningPackage) })),
      updateMany: vi.fn(async (args: { data: { planningPackage: Record<string, unknown> } }) => {
        store.planningPackage = structuredClone(args.data.planningPackage);
        return { count: 1 };
      })
    },
    generationJob: {
      findUnique: vi.fn(async () => (store.prepJob ? { ...store.prepJob } : null)),
      updateMany: vi.fn(async (args: { where: { status: { in: string[] } }; data: { status: string } }) => {
        if (!store.prepJob || !args.where.status.in.includes(store.prepJob.status)) return { count: 0 };
        store.prepJob.status = args.data.status;
        return { count: 1 };
      })
    }
  },
  Prisma: {}
}));
vi.mock("../runtime/config.js", () => ({ config: { MOCK_AI: false } }));
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: vi.fn() }));

import { makeFallbackPlan, type CreateProjectInput } from "@book-maker/core";
import { openPreparedComposition } from "./composedPrepHandoff.js";
import { compositionPrepRecord, preparationFingerprint, type CompositionPrepRecord } from "./composedPrepRecord.js";

const input = { prompt: "A history of treaties", category: "HISTORY", targetPages: 12, complexity: 5, temperature: 0.7, language: "en",
  mediaSettings: { fullIllustrations: false, illustrationCadence: "manual", includeCover: false, coverTemplate: "auto", finalReview: true, toneProfile: "neutral" } } as CreateProjectInput;
const plan = makeFallbackPlan(input);
const settings = { gates: "fixture" };
const stance = { thesis: "Treaties outlast the wars that make them.", positions: ["a", "b", "c"], refusals: [], voiceSample: "x" };

function record(overrides: Partial<CompositionPrepRecord> = {}): CompositionPrepRecord {
  return { version: 1, generationJobId: "prep-job", fingerprint: preparationFingerprint(input, settings, false), planned: ["stance", "inventory", "episodes", "forms"], steps: {}, written: [], ...overrides };
}

function clock() {
  let now = 0;
  const steps: Array<() => void> = [];
  return {
    now: () => now,
    /** Each poll runs the prep's next move, then a second passes. */
    sleep: vi.fn(async (ms: number) => {
      steps.shift()?.();
      now += ms;
    }),
    next: (step: () => void) => steps.push(step)
  };
}

beforeEach(() => {
  store.planningPackage = { ...plan };
  store.prepJob = null;
});

describe("openPreparedComposition", () => {
  it("waits for a running prep step by step, reading each answer where the run would have asked for it", async () => {
    store.prepJob = { id: "prep-job", status: "ACTIVE" };
    store.planningPackage = { ...plan, compositionPrep: record() };
    const time = clock();
    time.next(() => {
      store.planningPackage = { ...store.planningPackage, authorStance: stance, compositionPrep: record({ steps: { stance: "stored" }, written: ["authorStance"] }) };
    });
    const prepared = await openPreparedComposition({ projectId: "p", planId: "v", generationJobId: "book", input, plan, qualitySettings: settings, now: time.now, sleep: time.sleep });
    expect(compositionPrepRecord(store.planningPackage)?.adoptedBy).toBe("book");
    expect(await prepared.stance()).toEqual(stance);
    expect(store.prepJob.status).toBe("ACTIVE");
    // The prep fails its episodes: the run takes them over, and the prep is fenced before it can plan anything else.
    time.next(() => {
      store.planningPackage = { ...store.planningPackage, compositionPrep: { ...compositionPrepRecord(store.planningPackage)!, steps: { stance: "stored", episodes: "failed" } } };
    });
    const afterEpisodes = await prepared.forStep("episodes");
    expect(afterEpisodes.episodes).toBeUndefined();
    expect(store.prepJob.status).toBe("CANCELED");
    // Once fenced, every later step is the run's at once.
    const calls = time.sleep.mock.calls.length;
    await prepared.forStep("forms");
    expect(time.sleep.mock.calls.length).toBe(calls);
  });

  it("fences a prep that answers nothing within the wait, and never waits on a failed brief inventory", async () => {
    store.prepJob = { id: "prep-job", status: "ACTIVE" };
    store.planningPackage = { ...plan, compositionPrep: record({ steps: { inventory: "failed" } }) };
    const time = clock();
    const prepared = await openPreparedComposition({ projectId: "p", planId: "v", input, plan, qualitySettings: settings, now: time.now, sleep: time.sleep, stepWaitMs: 5_000 });
    await prepared.forStep("inventory");
    expect(store.prepJob.status).toBe("ACTIVE");
    await prepared.forStep("stance");
    expect(store.prepJob.status).toBe("CANCELED");
    expect(time.now()).toBeGreaterThanOrEqual(5_000);
  });

  it("cancels a prep still queued and keeps the run's own plan when nothing was prepared", async () => {
    store.prepJob = { id: "prep-job", status: "QUEUED" };
    const prepared = await openPreparedComposition({ projectId: "p", planId: "v", input, plan, qualitySettings: settings });
    expect(store.prepJob.status).toBe("CANCELED");
    expect(prepared.plan).toBe(plan);
    expect(await prepared.stance()).toBeUndefined();
  });

  it("discards every field a prep planned under other inputs, and nothing the planner wrote", async () => {
    store.prepJob = { id: "prep-job", status: "COMPLETED" };
    store.planningPackage = { ...plan, authorStance: stance, episodes: { chapters: [] }, compositionPrep: record({ fingerprint: "other", steps: { stance: "stored", episodes: "stored" }, written: ["episodes"] }) };
    const prepared = await openPreparedComposition({ projectId: "p", planId: "v", generationJobId: "book", input, plan, qualitySettings: settings });
    expect(store.planningPackage.episodes).toBeUndefined();
    expect(store.planningPackage.authorStance).toEqual(stance);
    expect(compositionPrepRecord(store.planningPackage)).toMatchObject({ discardedBy: "book", written: [] });
    expect(prepared.plan.episodes).toBeUndefined();
  });
});
