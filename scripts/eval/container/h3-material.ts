/**
 * H3 eval (harness plan §H3): a sourced book's material phase — the research expansion and the
 * dossier — replayed on a stored plan's frozen chapters and episodes, under today's pipeline
 * (`today`: chapter-research per chapter + plan research queries, one case-source-search per lead)
 * or the merged one (`merged`: chapter-material-search per pair of leads, the background folded into
 * the chapter's first prompt, plan queries folded into their chapter), or H3b's (`leads`: today's
 * case-source-search per lead with its answer kept as the chapter's notes, chapter-research only for a
 * chapter with no planned leads, plan queries only where they fold into no chapter with leads).
 *
 * Runs inside the worker container (keys, catalogues, PDF fetcher):
 *   docker exec -w /app/apps/worker ai-book-maker-worker-1 pnpm exec tsx /app/scripts/eval/container/h3-material.ts \
 *     --plan <projectId> --arm today|merged|leads --draw 1 [--expansion] [--wording v1|v2|v3] [--concurrency 3] [--out <path>]
 * `container/h3-run-all.sh` is the 2026-10-16 run; `h3-pairs.ts` builds the blind brief pairs from its output.
 *
 * One process per (book, arm, draw), so the catalogues' outage-skip state never crosses arms.
 * Every grounded prompt draws on Google's shared free allowance and is NOT counted by the
 * product's allowance counter (no ProviderCallLog row is written).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as core from "../../../packages/core/src/index.ts";
import { chapterMaterialPrompt, chapterMaterialSections, CHAPTER_MATERIAL_SEARCH_PURPOSE, type MaterialWording } from "../variants/h3/chapterMaterialPrompt.ts";
import { chapterResearchQuery, createChapterMaterialSearch, researchQueriesByChapter, type ChapterMaterialSearch, type MaterialQuery, type MaterialResult } from "../variants/h3/chapterMaterialSearch.ts";
import { createLeadResearch, researchScopeBeyondLeads } from "../../../packages/core/src/generation/leadResearch.ts";
import { resolveGroundingRedirects } from "../../../packages/core/src/adapters/groundingRedirect.ts";
import { chapterResearchNotesForPrompt } from "../../../packages/core/src/generation/chapterResearchContext.ts";
import { config } from "../../../apps/worker/src/runtime/config.ts";
import { loadLiveGenerationTextRouting } from "../../../apps/worker/src/providers/generationTextRouting.ts";
import { fetchSourceDocument } from "../../../apps/worker/src/generation/sourceDocumentFetch.ts";
import { costOf } from "./runtime.ts";

const coreRequire = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
const { GoogleGenAI } = coreRequire("@google/genai") as { GoogleGenAI: new (options: { apiKey: string }) => any };

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const key = argv[index]!.replace(/^--/, "");
  const next = argv[index + 1];
  if (next && !next.startsWith("--")) { args.set(key, next); index += 1; } else args.set(key, "true");
}
const projectId = args.get("plan")!;
const arm = args.get("arm") as "today" | "merged" | "leads";
const draw = args.get("draw") ?? "1";
const withExpansion = args.get("expansion") === "true";
/** v1 (default), v2, v3: the merged prompt's wording (`variants/h3/chapterMaterialPrompt.ts`). */
const wording = (args.get("wording") ?? "v1") as MaterialWording;
const dataDir = "/app/.scratch/eval-data";
const out = args.get("out") ?? `${dataDir}/results/h3/${projectId}__${arm}__d${draw}.json`;
process.umask(0);

const stored = JSON.parse(readFileSync(`${dataDir}/plans/${projectId}.json`, "utf8"));
const plan = stored.planningPackage as core.BookPlan;
const input = stored.inputSnapshot as core.CreateProjectInput;
const tier = (input.mediaSettings as { modelTier?: string } | undefined)?.modelTier ?? "balanced";
const concurrency = Number(args.get("concurrency") ?? (tier === "fast" ? 6 : 3));
const maxChapters = Number(args.get("chapters") ?? "99");
const chapters = plan.chapters.slice(0, maxChapters);

// ---------------------------------------------------------------- research adapter (recording)
type CallRow = {
  purpose: string; query: string; leads?: string[]; background?: boolean; startedAt: number; ms: number; ok: boolean; error?: string;
  webSources: number; searchQueries: number; usage?: { promptTokens?: number | undefined; outputTokens?: number | undefined; toolUsePromptTokens?: number | undefined };
  summaryChars: number; sections?: Array<{ key: string; chars: number; sources: number }>; truncated?: boolean;
};
const calls: CallRow[] = [];
const t0 = Date.now();
const gemini = core.createResearchAdapter(config) as core.ResearchAdapter;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const researchModel = (gemini as { identity?: { model: string } }).identity?.model ?? "gemini-2.5-flash";

/** The adapter's material branch, as it will ship in `GeminiResearchAdapter.search` (same config, same post-processing). */
async function materialSearchOnce(query: MaterialQuery): Promise<MaterialResult & { toolUsePromptTokens?: number }> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), core.RESEARCH_REQUEST_TIMEOUT_MS);
  const response = await ai.models.generateContent({
    model: researchModel,
    contents: chapterMaterialPrompt(query.query, query.material!),
    config: { tools: [{ googleSearch: {} }], temperature: 0.1, thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: core.RESEARCH_MAX_OUTPUT_TOKENS, abortSignal: deadline.signal }
  }).catch((error: unknown) => {
    throw deadline.signal.aborted ? new core.ProviderHttpError("Grounded research did not answer within 45 s.", { status: 504 }) : error;
  }).finally(() => clearTimeout(timer));
  const rawText: string = response.text ?? "";
  const truncated = response.candidates?.[0]?.finishReason === "MAX_TOKENS";
  const grounding = response.candidates?.[0]?.groundingMetadata;
  const chunks: any[] = grounding?.groundingChunks ?? [];
  const supports: any[] = grounding?.groundingSupports ?? [];
  const excerpts = new Map<number, string[]>();
  for (const support of supports) {
    const text = typeof support?.segment?.text === "string" ? support.segment.text.trim() : "";
    if (!text) continue;
    for (const index of support?.groundingChunkIndices ?? []) {
      const list = excerpts.get(index) ?? [];
      if (list.length < 4 && !list.includes(text)) list.push(text);
      excerpts.set(index, list);
    }
  }
  const entries = chunks.map((chunk, index) => ({ web: chunk.web, index })).filter((entry) => Boolean(entry.web));
  const grounded = entries.map(({ web, index }) => ({ title: String(web.title ?? "Source"), url: web.uri ? String(web.uri) : undefined, summary: (excerpts.get(index) ?? []).join(" ").slice(0, 600) }));
  const sources = await resolveGroundingRedirects(grounded);
  const byChunk = new Map(entries.map((entry, position) => [entry.index, sources[position]!]));
  const text = truncated ? "" : rawText.trim();
  const usage = response.usageMetadata;
  return {
    query: query.query,
    summary: text,
    ...(truncated ? { truncated: true } : {}),
    provider: "gemini",
    model: response.modelVersion ?? researchModel,
    usage: { promptTokens: usage?.promptTokenCount, outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0) },
    toolUsePromptTokens: usage?.toolUsePromptTokenCount,
    grounding: { searchQueries: Array.isArray(grounding?.webSearchQueries) ? grounding.webSearchQueries.length : 0, webSources: grounded.length },
    sources: sources.length > 0 ? sources : truncated ? [] : [{ title: "Gemini grounded summary", summary: text }],
    sections: chapterMaterialSections(rawText, supports).map((section) => ({
      key: section.key,
      text: truncated ? "" : section.text,
      sources: section.chunkIndexes.flatMap((index) => (byChunk.has(index) ? [byChunk.get(index)!] : []))
    }))
  };
}

const research = {
  async search(query: MaterialQuery): Promise<MaterialResult> {
    const row: CallRow = { purpose: query.purpose ?? "?", query: query.query.slice(0, 300), startedAt: Date.now() - t0, ms: 0, ok: false, webSources: 0, searchQueries: 0, summaryChars: 0,
      ...(query.material ? { leads: [...query.material.leads], background: Boolean(query.material.background) } : {}) };
    calls.push(row);
    const started = Date.now();
    try {
      // The worker's LoggingResearchAdapter retries recoverable failures (a 504 deadline included).
      const result = await core.withRecoverableNetworkRetry(
        () => (query.purpose === CHAPTER_MATERIAL_SEARCH_PURPOSE ? materialSearchOnce(query) : gemini.search(query)),
        { attempts: 3 } as never
      ) as MaterialResult & { toolUsePromptTokens?: number };
      row.ok = true;
      row.webSources = result.grounding?.webSources ?? 0;
      row.searchQueries = result.grounding?.searchQueries ?? 0;
      row.usage = { promptTokens: result.usage?.promptTokens, outputTokens: result.usage?.outputTokens, toolUsePromptTokens: result.toolUsePromptTokens };
      row.summaryChars = result.summary.length;
      if (result.truncated) row.truncated = true;
      if (result.sections) row.sections = result.sections.map((section) => ({ key: section.key, chars: section.text.length, sources: section.sources.filter((source) => source.url).length }));
      return result;
    } catch (error) {
      row.error = error instanceof Error ? error.message.slice(0, 200) : String(error);
      throw error;
    } finally {
      row.ms = Date.now() - started;
    }
  }
};

// ---------------------------------------------------------------- text model (extract-excerpts), recorded
// The live route's extract-excerpts model (gpt-6-luna) answered "429 You have no credits remaining" on 2026-10-16 and its
// configured fallback (DeepInfra V4 Flash) "429 Model busy", so every arm extracts on DeepSeek V4 Flash direct, thinking off.
const extractSelection = { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false };
const extractAdapter = core.createTextModelAdapter(config, extractSelection as never, { maxRetries: 0 });
const textModel = {
  generateText: (options: never) => core.withRecoverableNetworkRetry(() => extractAdapter.generateText(options), { attempts: 3 } as never),
  generateJson: (options: never) => core.withRecoverableNetworkRetry(() => extractAdapter.generateJson(options), { attempts: 3 } as never)
} as unknown as core.TextModelAdapter;
void loadLiveGenerationTextRouting;
const textUsage: Array<{ purpose: string; promptTokens: number; outputTokens: number; ms: number }> = [];
// No `bindForCall`, so `generateJsonWithRetry` calls through this wrapper and the live model resolves its route per call.
const record = async <T extends { usage?: { promptTokens?: number | undefined; outputTokens?: number | undefined } | undefined }>(purpose: string | undefined, call: Promise<T>): Promise<T> => {
  const started = Date.now();
  const result = await call;
  textUsage.push({ purpose: purpose ?? "?", promptTokens: result.usage?.promptTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0, ms: Date.now() - started });
  return result;
};
const recordingText = {
  generateText: (options: never) => record((options as { purpose?: string }).purpose, textModel.generateText(options)),
  generateJson: (options: never) => record((options as { purpose?: string }).purpose, textModel.generateJson(options))
} as unknown as core.TextModelAdapter;

// ---------------------------------------------------------------- the frozen episodes, as prepareBookMaterial settles them
const storedEpisodes = plan.episodes;
const episodesByChapter = new Map<number, core.ChapterEpisode[]>(chapters.map((chapter) => {
  const own = storedEpisodes?.chapters.find((entry) => entry.index === chapter.index)?.episodes ?? [];
  return [chapter.index, own.length > 0 ? own : [core.chapterEpisodeSchema.parse({
    title: chapter.title, kind: "document", why: chapter.summary,
    searchQueries: [chapter.title + " " + chapter.keyBeats.join(" "), `${plan.title} ${chapter.title} original source documentation`]
  })]];
}));

// ---------------------------------------------------------------- retrieveChapterSources, with the material hook as it will ship
type DossierEvent = { name: string; data: Record<string, unknown> };
async function retrieveChapterSources(chapter: core.ChapterPlan, episodes: core.ChapterEpisode[], options: {
  searchSources?: core.PrimarySourceSearch; materialSearch?: ChapterMaterialSearch; deadline: number; events: DossierEvent[];
  /** H3b: the round's search, told which lead each query was searched for. */
  leadSearch?: (query: string, lead: string | undefined) => Promise<Array<{ title: string; url: string }>>;
}): Promise<core.BookDossier & { rounds: number }> {
  const found: core.BookDossier[] = [];
  let rounds = 0;
  for (let round = 0; round < 2; round += 1) {
    if (Date.now() >= options.deadline) break;
    rounds += 1;
    const roundEpisodes: core.ChapterEpisode[] = episodes.map((episode) => ({ ...episode,
      searchQueries: [episode.searchQueries[round] || `${episode.title} ${chapter.title} original source documentation`] }));
    const searchSources = options.materialSearch
      ? options.materialSearch.forRound(roundEpisodes.slice(0, 3).map((episode) => episode.searchQueries[0]!))
      : options.leadSearch
        ? (query: string) => options.leadSearch!(query, roundEpisodes.find((episode) => episode.searchQueries[0] === query)?.title)
        : options.searchSources;
    const result = await core.buildChapterDossier({
      input, chapter, episodes: roundEpisodes, textModel: recordingText, fetch: fetchSourceDocument as never, searchSources, queryOffset: 0,
      deadline: options.deadline, evidence: true,
      log: (event, detail) => options.events.push({ name: event, data: { ...detail, round: round + 1 } })
    });
    found.push({ ...result, excerpts: result.excerpts.map((excerpt) => ({ ...excerpt,
      id: `ch${excerpt.chapterIndex}-s${createHash("sha256").update(`${excerpt.documentUrl}\n${excerpt.text}`).digest("hex").slice(0, 16)}` })) });
    if (result.excerpts.length) break;
  }
  const excerpts = new Map<string, core.BookDossier["excerpts"][number]>();
  const documents = new Map<string, core.BookDossier["documents"][number]>();
  for (const dossier of found) {
    for (const excerpt of dossier.excerpts) excerpts.set(`${excerpt.chapterIndex}\n${excerpt.documentUrl}\n${excerpt.text}`, excerpt);
    for (const document of dossier.documents) documents.set(`${document.chapterIndex}\n${document.url}`, document);
  }
  return { excerpts: [...excerpts.values()], documents: [...documents.values()], rounds };
}

// ---------------------------------------------------------------- run
type Row = core.ResearchSource & { writtenAt: number };
const rows: Row[] = [];
const write = (sources: core.ResearchSource[]) => { const at = Date.now() - t0; for (const source of sources) rows.push({ ...source, writtenAt: at }); };

const { byChapter, unmatched } = researchQueriesByChapter(plan);
// H3b: a chapter with planned leads gets its notes from their answers; only the others keep chapter-research.
const chaptersWithLeads = new Set(chapters.filter((chapter) => (storedEpisodes?.chapters.find((entry) => entry.index === chapter.index)?.episodes.length ?? 0) > 0).map((chapter) => chapter.index));
const leadResearch = arm === "leads" ? createLeadResearch((query) => research.search({ query, purpose: "case-source-search" })) : undefined;
let expansionMs: number | undefined;
const expansionPlan = arm === "merged" ? { ...plan, chapters: [], researchQueries: unmatched }
  : arm === "leads" ? { ...plan, chapters: chapters.filter((chapter) => !chaptersWithLeads.has(chapter.index)), researchQueries: researchScopeBeyondLeads(plan, chaptersWithLeads).researchQueries }
    : { ...plan, chapters };
const expansion = withExpansion
  // Merged: the chapters' own queries and the research queries folded into a chapter ride the dossier's prompts.
  ? core.expandChapterResearch({ input, plan: expansionPlan, research, cap: 12 })
    .then((sources) => { expansionMs = Date.now() - t0; write(sources); })
  : Promise.resolve();

const caseSourceSearch: core.PrimarySourceSearch = async (query) =>
  (await research.search({ query, purpose: "case-source-search" })).sources.flatMap((source) => (source.url ? [{ title: source.title, url: source.url }] : []));

const dossierDeadline = Date.now() + 10 * 60_000;
const chapterResults = await core.mapWithConcurrency(chapters, concurrency, async (chapter) => {
  const started = Date.now();
  const events: DossierEvent[] = [];
  const material = arm === "merged"
    ? createChapterMaterialSearch({ research, wording, topic: chapterResearchQuery(plan, chapter), alsoCover: byChapter.get(chapter.index) ?? [] })
    : undefined;
  const episodes = episodesByChapter.get(chapter.index)!;
  const dossier = await retrieveChapterSources(chapter, episodes, {
    ...(material ? { materialSearch: material } : leadResearch ? { leadSearch: leadResearch.searchFor(chapter) } : { searchSources: caseSourceSearch }),
    deadline: dossierDeadline, events
  });
  const searchDoneMs = Date.now() - started;
  if (material) write(await material.research());
  const eventCounts: Record<string, number> = {};
  for (const event of events) eventCounts[event.name] = (eventCounts[event.name] ?? 0) + 1;
  const extracted = events.filter((event) => event.name === "dossier.extracted").reduce((sum, event) => sum + Number(event.data.returned ?? 0), 0);
  const rejected = events.filter((event) => event.name === "dossier.excerpt_rejected").length;
  return {
    index: chapter.index, title: chapter.title, episodes: episodes.length, rounds: dossier.rounds, ms: Date.now() - started, dossierMs: searchDoneMs,
    documents: dossier.documents.map((document) => ({ url: document.url, title: document.title, host: document.host, words: document.words })),
    excerptsProposed: extracted, excerptsRejected: rejected, excerptsKept: dossier.excerpts.length,
    excerptWords: dossier.excerpts.reduce((sum, excerpt) => sum + excerpt.words, 0),
    excerpts: dossier.excerpts.map((excerpt) => ({ documentUrl: excerpt.documentUrl, episodeTitle: excerpt.episodeTitle, words: excerpt.words, text: excerpt.text.slice(0, 300) })),
    ...(material ? { material: material.report() } : {}),
    eventCounts, failures: events.filter((event) => /failed|deadline/.test(event.name)).map((event) => ({ name: event.name, ...event.data })).slice(0, 20),
    finishedAt: Date.now() - t0,
    dossier
  };
});
const dossierMs = Date.now() - t0;
await expansion;
// H3b: every lead's answer and cited sources, written with the dossier's rows (recordDossierSources).
if (leadResearch) write(leadResearch.rows());
// The dossier's documents become `primary-source:` rows (recordDossierSources), after every chapter.
const seenDocuments = new Set<string>();
write(chapterResults.flatMap((chapter) => chapter.dossier.documents.flatMap((document) => {
  if (!document.url || seenDocuments.has(document.url)) return [];
  seenDocuments.add(document.url);
  const excerpt = chapter.dossier.excerpts.find((entry) => entry.documentUrl === document.url);
  return [{ query: `primary-source: ${document.title}`, title: document.title, url: document.url, summary: excerpt ? excerpt.text.slice(0, 400) : document.title }];
})));
const materialMs = Math.max(dossierMs, expansionMs ?? 0);

// ---------------------------------------------------------------- what each chapter's writer is handed (loadResearchNotesForGeneration, in memory)
const searchableTerms = (value: string) => new Set(value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((term) => term.length > 4));
function writerNotes(chapter: core.ChapterPlan): string[] {
  const depth = 12;
  const stored = [...rows].sort((a, b) => b.writtenAt - a.writtenAt);
  const notes = stored.filter((source) => source.url).map((source) => `${source.title}: ${source.summary}`);
  const chapterTerms = searchableTerms(`${chapter.title} ${chapter.summary} ${chapter.keyBeats.join(" ")}`);
  const isBrief = (source: Row) => source.title === "Research brief";
  const score = (source: Row) => {
    const own = source.query.includes(chapter.title);
    const terms = searchableTerms(`${source.query} ${source.title} ${source.summary}`);
    let shared = 0;
    for (const term of chapterTerms) if (terms.has(term)) shared += 1;
    if (own) return 1000 + (isBrief(source) ? 100 : 0) + shared;
    return isBrief(source) ? -1 : shared;
  };
  const matching = stored
    .filter((source) => { const terms = searchableTerms(`${source.query} ${source.title} ${source.summary}`); return [...chapterTerms].some((term) => terms.has(term)); })
    .map((source) => ({ source, score: score(source) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(({ source }) => (isBrief(source) ? source.summary : `${source.title}: ${source.summary}`));
  const general = notes.filter((note) => !matching.includes(note)).slice(0, 4);
  return chapterResearchNotesForPrompt([...matching, ...general].slice(0, depth + 4));
}

// ---------------------------------------------------------------- $
const searchSelection = { provider: "gemini", model: researchModel };
const searchTokensUsd = calls.reduce((sum, call) => sum + (costOf(searchSelection, {
  promptTokens: (call.usage?.promptTokens ?? 0) + (call.usage?.toolUsePromptTokens ?? 0), outputTokens: call.usage?.outputTokens ?? 0, reasoningTokens: 0, cacheHitTokens: 0
}) ?? 0), 0);
const groundedPrompts = calls.filter((call) => call.ok && call.webSources > 0).length;
const extractUsd = textUsage.reduce((sum, call) => sum + (costOf(extractSelection, { promptTokens: call.promptTokens, outputTokens: call.outputTokens, reasoningTokens: 0, cacheHitTokens: 0 }) ?? 0), 0);

const primaryDocument = (url: string, host: string) => {
  if (host !== "web") return true;
  try {
    const parsed = new URL(url);
    return /\.pdf$/i.test(parsed.pathname) || /(?:^|\.)(?:gov|edu|int|mil)(?:\.[a-z]{2})?$|\.(?:ac|gov|gob|gouv|go)\.[a-z]{2}$/i.test(parsed.hostname) || /\/(?:docs|documentation|standards|publications|papers|pubs)\//i.test(parsed.pathname);
  } catch { return false; }
};
const byPurpose: Record<string, number> = {};
for (const call of calls) byPurpose[call.purpose] = (byPurpose[call.purpose] ?? 0) + 1;
const documents = chapterResults.flatMap((chapter) => chapter.documents);
const summary = {
  projectId, title: plan.title, tier, arm, draw, ...(arm === "merged" ? { wording } : {}), chapters: chapters.length, concurrency, expansion: withExpansion,
  ...(leadResearch ? { leads: { ...leadResearch.report(), chaptersWithoutLeads: chapters.length - chaptersWithLeads.size, researchQueriesSearched: expansionPlan.researchQueries.length } } : {}),
  groundedPromptsSent: calls.length, groundedPromptsWithSources: groundedPrompts, byPurpose,
  failedCalls: calls.filter((call) => !call.ok).length,
  materialUngrounded: calls.filter((call) => call.purpose === CHAPTER_MATERIAL_SEARCH_PURPOSE && call.ok && call.webSources === 0).length,
  documents: documents.length, distinctDocumentUrls: new Set(documents.map((document) => document.url)).size,
  primaryDocuments: documents.filter((document) => primaryDocument(document.url, document.host)).length,
  excerptsProposed: chapterResults.reduce((sum, chapter) => sum + chapter.excerptsProposed, 0),
  excerptsKept: chapterResults.reduce((sum, chapter) => sum + chapter.excerptsKept, 0),
  excerptWords: chapterResults.reduce((sum, chapter) => sum + chapter.excerptWords, 0),
  chaptersWithoutExcerpts: chapterResults.filter((chapter) => chapter.excerptsKept === 0).length,
  secondRounds: chapterResults.filter((chapter) => chapter.rounds > 1).length,
  distinctCitedUrls: new Set(rows.filter((row) => row.url && !row.query.startsWith("primary-source:")).map((row) => row.url)).size,
  researchRows: rows.length, briefRows: rows.filter((row) => row.title === "Research brief").length,
  materialMs, dossierMs, expansionMs: expansionMs ?? null,
  firstChapterReadyMs: Math.min(...chapterResults.map((chapter) => chapter.finishedAt)),
  usd: { searchTokens: Number(searchTokensUsd.toFixed(4)), groundingFeeAtList: Number((groundedPrompts * 0.035).toFixed(4)), extract: Number(extractUsd.toFixed(4)),
    total: Number((searchTokensUsd + groundedPrompts * 0.035 + extractUsd).toFixed(4)) }
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  summary,
  chapters: chapterResults.map(({ dossier: _dossier, ...chapter }) => ({ ...chapter, writerNotes: writerNotes(plan.chapters.find((entry) => entry.index === chapter.index)!) })),
  calls, textUsage, rows
}, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
