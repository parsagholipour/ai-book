import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  chapterEpisodeSchema, configurePrimarySourceThrottle, createProjectSchema, FakeTextModelAdapter, makeFallbackPlan
} from "@book-maker/core";
import { MemoryObjectStore, readRunLog, setObjectStoreForTests } from "@book-maker/storage";

vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: vi.fn() }));

import { createRunLogger } from "../providers/runLogging.js";
import { retrieveChapterSources } from "./sourceDossier.js";

const input = createProjectSchema.parse({ prompt: "Explain public-key cryptography", category: "SCIENCE", targetPages: 20, language: "en" });
const chapter = makeFallbackPlan(input).chapters[0]!;
const episodes = [chapterEpisodeSchema.parse({ title: "RSA", searchQueries: ["RSA original paper", "RSA technical documentation"] })];
const source = { title: "Original paper", url: "https://example.org/paper" };
const foreignText = "این متن درباره تاریخ و دانش مردم است ".repeat(30);
const logger = () => createRunLogger({ id: "bull", name: "generate-book", data: { projectId: "p", generationJobId: "run" } } as Parameters<typeof createRunLogger>[0]);
const read = async (filePath: string) => (await readRunLog(filePath)).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const options = () => ({
  projectId: "p", input, chapter, episodes, textModel: new FakeTextModelAdapter(input),
  searchSources: async () => [source],
  fetch: async (url: string) => ({ status: url === source.url ? 200 : 404, text: url === source.url ? foreignText : "" })
});

beforeEach(() => {
  setObjectStoreForTests(new MemoryObjectStore());
  configurePrimarySourceThrottle({ intervalMs: 0 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { setObjectStoreForTests(null); vi.restoreAllMocks(); });

it("persists real search/drop decisions with chapter and round context before retrieval finishes", async () => {
  const runLog = logger();
  const base = options();
  let searchesAtFetch = 0;
  const dossier = await retrieveChapterSources({ ...base, runLog, fetch: async (url) => {
    if (url === source.url) searchesAtFetch = (await read(runLog.filePath)).filter((entry) => entry.event.endsWith("dossier.search")).length;
    return base.fetch(url);
  } });
  const events = await read(runLog.filePath);
  const searches = events.filter((entry) => entry.event.endsWith("dossier.search"));
  const drops = events.filter((entry) => entry.event.endsWith("dossier.document_dropped"));
  expect(searchesAtFetch).toBe(2);
  expect(searches.map((entry) => [entry.query, entry.round])).toEqual([[episodes[0]!.searchQueries[0], 1], [episodes[0]!.searchQueries[1], 2]]);
  expect(drops).toHaveLength(2);
  expect(drops[0]).toMatchObject({ reason: "not the book's language", chapterIndex: chapter.index, round: 1, retrievalStage: "chapter_sources" });
  expect(events.every((entry) => entry.job.projectId === "p" && entry.chapterIndex === chapter.index)).toBe(true);
  expect(events.at(-1)).toMatchObject({ event: "generation.composed_chapters.dossier.coverage", rounds: 2, status: "no_supporting_passages" });
  expect(dossier.excerpts).toEqual([]);
});

it("drains earlier decisions when extraction is cancelled", async () => {
  const runLog = logger();
  const base = options();
  const stopped = new Error("User requested stop");
  stopped.name = "StopRequestedError";
  vi.spyOn(base.textModel, "generateJson").mockRejectedValue(stopped);
  const text = "The original paper describes how public and private keys encrypt a message using modular exponentiation. ".repeat(40);
  await expect(retrieveChapterSources({ ...base, runLog, evidence: true,
    fetch: async (url) => ({ status: url === source.url ? 200 : 404, text: url === source.url ? text : "" })
  })).rejects.toBe(stopped);
  const events = await read(runLog.filePath);
  expect(events.some((entry) => entry.event.endsWith("dossier.search") && entry.round === 1)).toBe(true);
  expect(events.some((entry) => entry.event.endsWith("dossier.coverage"))).toBe(false);
});

it.each(["sync", "async"])("does not let a %s trace failure interrupt retrieval", async (kind) => {
  const append = vi.fn(() => {
    if (kind === "sync") throw new Error("storage unavailable");
    return Promise.reject(new Error("storage unavailable"));
  });
  await expect(retrieveChapterSources({ ...options(), runLog: { append } })).resolves.toEqual({ excerpts: [], documents: [] });
  expect(append).toHaveBeenCalledWith("generation.composed_chapters.dossier.coverage", expect.objectContaining({ rounds: 2 }));
});

it("tells a lead search which lead each round's query was searched for, in place of the plain search", async () => {
  const leads = [...episodes, chapterEpisodeSchema.parse({ title: "Diffie-Hellman", searchQueries: [] })];
  const searchSources = vi.fn(async () => [source]);
  const leadSearch = vi.fn(async (_query: string, _lead: string | undefined) => [] as Array<{ title: string; url: string }>);
  await retrieveChapterSources({ ...options(), episodes: leads, searchSources, leadSearch });
  expect(searchSources).not.toHaveBeenCalled();
  expect(leadSearch.mock.calls).toEqual(expect.arrayContaining([
    ["RSA original paper", "RSA"],
    [`Diffie-Hellman ${chapter.title} original source documentation`, "Diffie-Hellman"],
    ["RSA technical documentation", "RSA"]
  ]));
  expect(leadSearch).toHaveBeenCalledTimes(4);
});
