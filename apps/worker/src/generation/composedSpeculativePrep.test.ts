import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSetup } from "../runtime/jobTypes.js";

/**
 * Harness redesign H4: a book whose stance, inventory, episodes and form plan
 * the speculative prep stored before approval composes from byte-identical
 * prompts to the same book that planned them after approval. The plan store
 * reorders every object's keys the way Postgres `jsonb` does, because that is
 * the one difference between an answer held in memory and one read back.
 */

/** `jsonb` keeps object keys shortest first, then bytewise: what a stored answer comes back as. */
function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => [key, jsonbOrder(record[key])])
  );
}

const store = vi.hoisted(() => ({
  chapters: [] as Array<{ id: string; index: number; title: string; targetPages: number; productionBrief: unknown }>,
  pages: [] as Array<{ id: string; index: number; status: string; title: string; markdown: string; summary: string; imagePrompt: string | null; chapterId: string | null; revision: number; updatedAt: Date }>,
  planningPackage: {} as Record<string, unknown>,
  planStatus: "DRAFT",
  prepJob: null as null | { id: string; status: string }
}));

const mocks = vi.hoisted(() => {
  const order = (value: unknown) => (globalThis as unknown as { __jsonbOrder: (value: unknown) => unknown }).__jsonbOrder(value);
  const prisma = {
    chapter: {
      findFirst: vi.fn(async (args: { where: { index: number } }) => store.chapters.find((chapter) => chapter.index === args.where.index)),
      findMany: vi.fn(async () => store.chapters.map((chapter) => ({ ...chapter }))),
      update: vi.fn(async (args: { where: { id: string }; data: { productionBrief: unknown } }) => {
        const chapter = store.chapters.find((candidate) => candidate.id === args.where.id);
        if (chapter) chapter.productionBrief = args.data.productionBrief;
        return chapter;
      })
    },
    page: {
      findMany: vi.fn(async () => [...store.pages].sort((a, b) => a.index - b.index).map((page) => ({ ...page }))),
      createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
        for (const row of args.data) {
          store.pages.push({ id: `page-${String(row.index)}`, index: row.index as number, status: row.status as string, title: row.title as string, markdown: row.markdown as string,
            summary: row.summary as string, imagePrompt: (row.imagePrompt as string | null) ?? null, chapterId: (row.chapterId as string | null) ?? null, revision: 1, updatedAt: new Date(0) });
        }
        return { count: args.data.length };
      }),
      updateMany: vi.fn(async (args: { where: { index: number; status: string }; data: Record<string, unknown> }) => {
        const page = store.pages.find((candidate) => candidate.index === args.where.index && candidate.status === args.where.status);
        if (page) Object.assign(page, args.data);
        return { count: page ? 1 : 0 };
      }),
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async () => ({ count: 0 }))
    },
    project: { update: vi.fn(async () => ({})) },
    planVersion: {
      findUnique: vi.fn(async () => ({ planningPackage: order(store.planningPackage), status: store.planStatus })),
      // A compare-and-swap, as Postgres runs it: a write staked on a document the row no longer holds matches nothing.
      updateMany: vi.fn(async (args: { where: { planningPackage?: { equals: unknown } }; data: { planningPackage: unknown } }) => {
        const expected = args.where.planningPackage?.equals;
        if (expected !== undefined && JSON.stringify(order(expected)) !== JSON.stringify(order(store.planningPackage))) return { count: 0 };
        store.planningPackage = order(args.data.planningPackage) as Record<string, unknown>;
        return { count: 1 };
      }),
      update: vi.fn(async (args: { data: { planningPackage: unknown } }) => {
        store.planningPackage = order(args.data.planningPackage) as Record<string, unknown>;
        return {};
      })
    },
    generationJob: {
      findUnique: vi.fn(async () => (store.prepJob ? { ...store.prepJob } : null)),
      updateMany: vi.fn(async (args: { where: { status: { in: string[] } }; data: { status: string } }) => {
        if (!store.prepJob || !args.where.status.in.includes(store.prepJob.status)) return { count: 0 };
        store.prepJob.status = args.data.status;
        return { count: 1 };
      })
    },
    researchSource: { createMany: vi.fn(async () => ({ count: 0 })) },
    continuityNote: { createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })) },
    $queryRaw: vi.fn(async () => (store.prepJob?.status === "ACTIVE" ? [{ held: 1 }] : [])),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma))
  };
  return {
    prisma,
    resetBookForDirectGeneration: vi.fn(async (_projectId: string, setups: ChapterSetup[]) => {
      store.chapters = setups.map((setup) => ({ id: `chapter-${setup.chapter.index}`, index: setup.chapter.index, title: setup.chapter.title, targetPages: setup.chapter.targetPages, productionBrief: null }));
      store.pages = [];
      return new Map(store.chapters.map((chapter) => [chapter.index, chapter.id]));
    })
  };
});

vi.mock("@book-maker/db", async () => ({ prisma: mocks.prisma, Prisma: {}, ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks() }));
vi.mock("../runtime/config.js", async (original) => ({ config: { ...(await original<{ config: object }>()).config, MOCK_AI: false } }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: vi.fn(), maybeEnqueueCover: vi.fn() }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: vi.fn(), assertJobNotStopped: vi.fn() }));
vi.mock("./bookState.js", () => ({ resetBookForDirectGeneration: mocks.resetBookForDirectGeneration }));
vi.mock("./characterReferences.js", () => ({ ensureCharacterReferenceAssets: vi.fn() }));
vi.mock("./sourceDossier.js", async (original) => ({ ...await original<object>(), retrieveChapterSources: vi.fn(async () => ({ documents: [], excerpts: [] })) }));
vi.mock("./bookHelpers.js", async () => {
  const core = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    chapterSetupsForPlan: (plan: import("@book-maker/core").BookPlan, targetPages: number) => {
      let next = 1;
      return core.normalizePlanPageTargets(plan, targetPages).chapters.map((chapter) => {
        const startPage = next;
        const endPage = Math.min(targetPages, startPage + chapter.targetPages - 1);
        next = endPage + 1;
        return { chapter, startPage, endPage };
      });
    }
  };
});
vi.mock("./generationContext.js", () => ({ loadContinuityNotes: async () => [], loadResearchNotesForGeneration: async () => [] }));
vi.mock("./pagePublication.js", () => ({
  GeneratedPagePublicationClaimLostError: class extends Error {},
  loadGeneratedPagePublicationSnapshot: async (_projectId: string, pageIndex: number) => {
    const page = store.pages.find((candidate) => candidate.index === pageIndex);
    return page ? { ...page } : null;
  },
  stageGeneratedPageAndBrief: vi.fn(async (options: { pageIndex: number; status: string; revision: number }) => {
    const page = store.pages.find((candidate) => candidate.index === options.pageIndex)!;
    page.status = options.status;
    return { id: page.id, revision: options.revision, updatedAt: new Date(1) };
  }),
  publishStagedGeneratedPage: vi.fn(async () => "completed")
}));
vi.mock("./qualityEnrichment.js", () => ({ keeperStoryExtractForSave: vi.fn(async () => null), persistStoryExtract: async () => null }));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: async () => ({ tier: "balanced", settings: { gates: "fixture" }, pageReviewPromptMode: "normal",
    enabled: (feature: string) => !["bookDevelopment", "caseEvidence", "developmentalEdit", "manuscriptReadPass", "manuscriptReadCuts", "figures"].includes(feature) })
}));
vi.mock("./storyStateStore.js", async () => {
  const core = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return { loadProjectStoryState: async (_projectId: string, promises: string[]) => core.seedStoryStateFromPromises(promises) };
});
vi.mock("./wholeBookPageReview.js", () => ({
  reviewWholeBookDraftPages: async (options: { pages: Array<{ index: number }> }) =>
    options.pages.map((draft) => ({ draft, revision: 1, qualityReport: { approved: true, score: 90, issues: [], requiredRevisions: [], notes: "", checks: {} } }))
}));

import { FakeTextModelAdapter, authorStanceSchema, bookPlanSchema, composedChaptersStrategy, makeFallbackPlan, type BookPlan, type CreateProjectInput, type ProviderSet } from "@book-maker/core";
import { generateBookComposedChapters } from "./composedChaptersPass.js";
import { prepareCompositionSpeculatively } from "./composedSpeculativePrep.js";
import { compositionPrepRecord } from "./composedPrepRecord.js";

(globalThis as unknown as { __jsonbOrder: (value: unknown) => unknown }).__jsonbOrder = jsonbOrder;

const input: CreateProjectInput = {
  prompt: "A global history of aggression and its causes, with a timeline of every major treaty.",
  category: "HISTORY",
  targetPages: 24,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: { fullIllustrations: false, illustrationCadence: "template-driven", includeCover: true, coverTemplate: "auto", finalReview: true, toneProfile: "neutral" }
};

type Call = { purpose: string; messages: string };

/** The fake model, its stance written from sources so the book plans episodes, every request recorded. */
function recordingModel(): { model: FakeTextModelAdapter; calls: Call[] } {
  const model = new FakeTextModelAdapter(input);
  const calls: Call[] = [];
  const text = model.generateText.bind(model);
  const json = model.generateJson.bind(model);
  model.generateText = async (options) => {
    calls.push({ purpose: options.purpose ?? "text", messages: JSON.stringify(options.messages) });
    return text(options);
  };
  model.generateJson = async (options) => {
    calls.push({ purpose: options.purpose ?? "json", messages: JSON.stringify(options.messages) });
    const fixture = jsonFixture(options.purpose);
    if (fixture) {
      const data = options.schema.parse(fixture);
      return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
    }
    const result = await json(options);
    if (options.purpose === "author-stance") {
      const data = options.schema.parse({ ...authorStanceSchema.parse(result.data), research: "sources" });
      return { ...result, data, text: JSON.stringify(data) };
    }
    return result;
  };
  return { model, calls };
}

/** Answers the fake has none of: a brief inventory and the book's episodes. */
function jsonFixture(purpose: string | undefined): unknown {
  if (purpose === "inventory-brief-requirements") {
    const quote = "a timeline of every major treaty";
    return { complete: true, requirements: [{ text: "Treaty timeline", quote, kind: "content", scope: { extent: "whole_book", quote } }] };
  }
  if (purpose === "plan-episodes") {
    return { chapters: makeFallbackPlan(input).chapters.map((chapter) => ({
      index: chapter.index,
      episodes: [{ title: `The treaty of chapter ${chapter.index}`, kind: "document", person: "A delegate", place: "Vienna", date: "1815", document: "The treaty text", why: chapter.summary, searchQueries: [`treaty ${chapter.index} text`, `treaty ${chapter.index} archive`] }]
    })) };
  }
  return undefined;
}

const PREPARED = ["author-stance", "inventory-brief-requirements", "plan-episodes", "plan-chapter-forms"];

async function runBook(plan: BookPlan, model: FakeTextModelAdapter) {
  await generateBookComposedChapters({
    projectId: "project-1", planId: "plan-1", input, plan, providers: { text: model } as unknown as ProviderSet,
    strategy: composedChaptersStrategy, generationJobId: "book-job"
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.chapters = [];
  store.pages = [];
  store.planStatus = "DRAFT";
  store.prepJob = null;
});

describe("speculative composition prep", () => {
  it("composes from byte-identical prompts whether the stance, inventory, episodes and forms were planned before approval or after", async () => {
    const plan = makeFallbackPlan(input);

    store.planningPackage = jsonbOrder(plan) as Record<string, unknown>;
    const after = recordingModel();
    await runBook(plan, after.model);
    const afterPurposes = after.calls.map((call) => call.purpose);
    for (const purpose of PREPARED) expect(afterPurposes).toContain(purpose);

    store.chapters = [];
    store.pages = [];
    store.planningPackage = jsonbOrder(plan) as Record<string, unknown>;
    store.prepJob = { id: "prep-job", status: "ACTIVE" };
    const prep = recordingModel();
    const events: unknown[] = [];
    const prepared = await prepareCompositionSpeculatively({ projectId: "project-1", planId: "plan-1", generationJobId: "prep-job", input, plan, textModel: prep.model, runLog: { append: async (event, data) => { events.push([event, data]); return ""; } } });
    expect(prepared).toEqual({ outcome: "prepared", steps: { stance: "stored", inventory: "stored", episodes: "stored", forms: "stored" } });
    expect(prep.calls.map((call) => call.purpose).sort()).toEqual([...PREPARED].sort());
    store.prepJob.status = "COMPLETED";
    store.planStatus = "APPROVED";

    const before = recordingModel();
    await runBook(bookPlanFromStore(), before.model);
    const beforePurposes = before.calls.map((call) => call.purpose);
    for (const purpose of PREPARED) expect(beforePurposes).not.toContain(purpose);

    // Every request the run made after the prepared steps is the request it made without the prep.
    const rest = (calls: Call[]) => calls.filter((call) => !PREPARED.includes(call.purpose));
    const composeOf = (calls: Call[]) => calls.filter((call) => call.purpose === "compose-chapter").map((call) => call.messages);
    expect(composeOf(before.calls)).toHaveLength(plan.chapters.length);
    expect(composeOf(before.calls)).toEqual(composeOf(after.calls));
    expect(rest(before.calls)).toEqual(rest(after.calls));
    // The prep's own requests are the ones the run made for those steps.
    expect(prep.calls.filter((call) => call.purpose === "plan-chapter-forms")).toEqual(after.calls.filter((call) => call.purpose === "plan-chapter-forms"));
    expect(compositionPrepRecord(store.planningPackage)?.adoptedBy).toBe("book-job");
  });

  it("discards what it planned when the run's inputs differ, and the run plans every step again", async () => {
    const plan = makeFallbackPlan(input);
    store.planningPackage = jsonbOrder(plan) as Record<string, unknown>;
    store.prepJob = { id: "prep-job", status: "ACTIVE" };
    await prepareCompositionSpeculatively({ projectId: "project-1", planId: "plan-1", generationJobId: "prep-job", input, plan, textModel: recordingModel().model });
    store.prepJob.status = "COMPLETED";
    // An approval that switched the illustrations off rewrote the input the prep planned under.
    const approved = { ...input, mediaSettings: { ...input.mediaSettings, fullIllustrations: true } };
    const run = recordingModel();
    await generateBookComposedChapters({ projectId: "project-1", planId: "plan-1", input: approved, plan: bookPlanFromStore(), providers: { text: run.model } as unknown as ProviderSet, strategy: composedChaptersStrategy, generationJobId: "book-job" });
    for (const purpose of PREPARED) expect(run.calls.map((call) => call.purpose)).toContain(purpose);
    expect(compositionPrepRecord(store.planningPackage)).toMatchObject({ discardedBy: "book-job", written: [] });
  });

  it("cancels a prep still queued, and stops a running one's writes the moment the run takes a step over", async () => {
    const plan = makeFallbackPlan(input);
    store.planningPackage = jsonbOrder(plan) as Record<string, unknown>;
    store.prepJob = { id: "prep-job", status: "QUEUED" };
    await runBook(plan, recordingModel().model);
    expect(store.prepJob.status).toBe("CANCELED");
    // A canceled prep can write nothing: its first write is refused and it ends without a call.
    const late = recordingModel();
    expect(await prepareCompositionSpeculatively({ projectId: "project-1", planId: "plan-1", generationJobId: "prep-job", input, plan, textModel: late.model }))
      .toMatchObject({ outcome: "fenced" });
    expect(late.calls).toEqual([]);
  });

  it("strips nothing the planner wrote and writes nothing twice on a redelivery", async () => {
    const plan = makeFallbackPlan(input);
    store.planningPackage = jsonbOrder(plan) as Record<string, unknown>;
    store.prepJob = { id: "prep-job", status: "ACTIVE" };
    await prepareCompositionSpeculatively({ projectId: "project-1", planId: "plan-1", generationJobId: "prep-job", input, plan, textModel: recordingModel().model });
    const again = recordingModel();
    expect(await prepareCompositionSpeculatively({ projectId: "project-1", planId: "plan-1", generationJobId: "prep-job", input, plan, textModel: again.model }))
      .toMatchObject({ outcome: "already-prepared" });
    expect(again.calls).toEqual([]);
    expect(compositionPrepRecord(store.planningPackage)?.written.sort()).toEqual(["authorStance", "compositions", "episodes", "requirementInventory"].sort());
  });
});

function bookPlanFromStore(): BookPlan {
  // What `generate-book` parses at its start.
  return bookPlanSchema.parse(store.planningPackage);
}
