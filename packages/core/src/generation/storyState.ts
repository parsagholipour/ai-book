import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { withPageQaTriggerReasons } from "./pageQaRewriteTelemetry.js";

export const storyPromiseStatusSchema = z.enum(["open", "paid", "broken"]);

export const storyPromiseSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  status: storyPromiseStatusSchema,
  openedAtPage: z.number().int().min(0),
  paidAtPage: z.number().int().positive().optional()
});

export const storyFactSchema = z.object({
  text: z.string().min(1),
  pageIndex: z.number().int().positive()
});

export const storyEntitySchema = z.object({
  goal: z.string().min(1).optional(),
  knows: z.array(z.string()).default([]),
  location: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  updatedAtPage: z.number().int().positive()
});

export const storyStateSchema = z.object({
  promises: z.array(storyPromiseSchema).default([]),
  facts: z.array(storyFactSchema).default([]),
  entities: z.record(z.string(), storyEntitySchema).default({}),
  unanswered: z.array(z.string()).default([])
});

const storyDeltaEntityUpdateSchema = z.object({
  goal: z.string().min(1).optional(),
  knows: z.array(z.string()).optional(),
  location: z.string().min(1).optional(),
  status: z.string().min(1).optional()
});

export const storyDeltaSchema = z.object({
  promisesOpened: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        text: z.string().min(1)
      })
    )
    .default([]),
  promisesPaid: z.array(z.string().min(1)).default([]),
  promisesBroken: z.array(z.string().min(1)).default([]),
  factsAdded: z.array(z.string().min(1)).default([]),
  entities: z.record(z.string(), storyDeltaEntityUpdateSchema).default({}),
  unansweredAdded: z.array(z.string().min(1)).default([]),
  unansweredResolved: z.array(z.string().min(1)).default([])
});

// Keep stored deltas tolerant, but never silently discard a model's invented
// keys: real extraction replies used `facts`/`payPromises` and parsed as no-ops.
export const storyExtractResultSchema = z.strictObject({
  storyDelta: storyDeltaSchema.extend({
    entities: z.record(z.string(), storyDeltaEntityUpdateSchema.strict()).default({})
  }).strict(),
  contradictions: z.array(z.string()).default([]),
  contradictionEvidence: z.array(z.object({
    issue: z.string().min(1),
    priorPageIndex: z.number().int().positive(),
    priorQuote: z.string().min(1),
    currentQuote: z.string().min(1)
  })).optional()
});

// The dialect marker describes a schema, not a response field. Including it
// made live replies echo `$schema` and need an otherwise unnecessary repair.
const { $schema: _schemaDialect, ...storyExtractOutputSchema } = z.toJSONSchema(storyExtractResultSchema);

export type StoryPromise = z.infer<typeof storyPromiseSchema>;
export type StoryFact = z.infer<typeof storyFactSchema>;
export type StoryEntity = z.infer<typeof storyEntitySchema>;
export type StoryState = z.infer<typeof storyStateSchema>;
export type StoryDelta = z.infer<typeof storyDeltaSchema>;
export type StoryExtractResult = z.infer<typeof storyExtractResultSchema> & {
  /** Diagnostic hypotheses, never instructions to rewrite prose to match derived metadata. */
  unverifiedContradictions?: string[];
  /** Local IDs bound to validated prose findings in the same grouped review. */
  findingIdsByContradiction?: Record<string, string> | undefined;
};

export function validateStoryExtractEvidence(
  extract: StoryExtractResult,
  page: { index: number; markdown: string },
  sourcePages: readonly { index: number; markdown: string }[]
): StoryExtractResult {
  const anchored = new Set((extract.contradictionEvidence ?? []).filter((evidence) =>
    evidence.priorPageIndex < page.index && evidence.priorQuote.trim().length >= 12 &&
    evidence.currentQuote.trim().length >= 12 && page.markdown.includes(evidence.currentQuote) &&
    sourcePages.some((source) => source.index === evidence.priorPageIndex && source.markdown.includes(evidence.priorQuote))
  ).map((evidence) => evidence.issue));
  return { ...extract,
    contradictions: extract.contradictions.filter((issue) => anchored.has(issue)),
    unverifiedContradictions: [...new Set([...(extract.unverifiedContradictions ?? []), ...extract.contradictions.filter((issue) => !anchored.has(issue))])]
  };
}

const STORY_STATE_LINE_CAP = 12;

/** Last N facts sent in the extract prompt. Persisted `Project.storyState` is not trimmed by this. */
export const STORY_STATE_EXTRACT_FACTS_CAP = 24;
/** Last N `knows` entries per kept entity in the extract prompt. */
export const STORY_STATE_EXTRACT_KNOWS_CAP = 8;
/** Last N paid promises in the extract prompt. Open promises are never omitted. */
export const STORY_STATE_EXTRACT_PAID_PROMISES_CAP = 12;

/** Rolling fact window written by `applyStoryDelta` (and therefore rebuild). */
export const STORY_STATE_PERSIST_FACTS_CAP = 80;
/** Rolling `knows` window per entity written by `applyStoryDelta` (and therefore rebuild). */
export const STORY_STATE_PERSIST_KNOWS_CAP = 16;

export function emptyStoryState(): StoryState {
  return { promises: [], facts: [], entities: {}, unanswered: [] };
}

export function seedStoryStateFromPromises(texts: readonly string[]): StoryState {
  return {
    promises: texts
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text, index) => ({
        id: `plan-${index + 1}`,
        text,
        status: "open" as const,
        openedAtPage: 0
      })),
    facts: [],
    entities: {},
    unanswered: []
  };
}

export function parseStoryState(value: unknown): StoryState {
  const parsed = storyStateSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyStoryState();
}

export function parseStoryDelta(value: unknown): StoryDelta | null {
  const parsed = storyDeltaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function applyStoryDelta(state: StoryState, delta: StoryDelta, pageIndex: number): StoryState {
  const promises = state.promises.map(clonePromise);
  for (const opened of delta.promisesOpened) {
    const text = opened.text.trim();
    if (!text) {
      continue;
    }
    const existing = promises.find(
      (promise) => (opened.id && promise.id === opened.id) || foldKey(promise.text) === foldKey(text)
    );
    if (existing) {
      continue;
    }
    promises.push({
      id: opened.id?.trim() || nextPromiseId(promises),
      text,
      status: "open",
      openedAtPage: pageIndex
    });
  }
  for (const paid of delta.promisesPaid) {
    const match = findPromise(promises, paid);
    if (match && match.status === "open") {
      match.status = "paid";
      match.paidAtPage = pageIndex;
    }
  }
  for (const broken of delta.promisesBroken) {
    const match = findPromise(promises, broken);
    if (match && match.status === "open") {
      match.status = "broken";
    }
  }

  const facts = [
    ...state.facts,
    ...delta.factsAdded
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ text, pageIndex }))
  ];

  const entities: StoryState["entities"] = { ...state.entities };
  for (const [name, update] of Object.entries(delta.entities)) {
    const key = name.trim();
    if (!key) {
      continue;
    }
    const previous = entities[key];
    entities[key] = {
      ...(update.goal
        ? { goal: update.goal }
        : previous?.goal
          ? { goal: previous.goal }
          : {}),
      knows: uniqueStrings([...(previous?.knows ?? []), ...(update.knows ?? [])]),
      ...(update.location
        ? { location: update.location }
        : previous?.location
          ? { location: previous.location }
          : {}),
      ...(update.status
        ? { status: update.status }
        : previous?.status
          ? { status: previous.status }
          : {}),
      updatedAtPage: pageIndex
    };
  }

  const resolved = new Set(delta.unansweredResolved.map(foldKey));
  const unanswered = uniqueStrings([
    ...state.unanswered.filter((item) => !resolved.has(foldKey(item))),
    ...delta.unansweredAdded.map((item) => item.trim()).filter(Boolean)
  ]).filter((item) => !resolved.has(foldKey(item)));

  return capPersistedStoryState({ promises, facts, entities, unanswered });
}

export function rebuildStoryState(
  deltasInIndexOrder: Array<{ pageIndex: number; delta: StoryDelta }>,
  seed: StoryState = emptyStoryState()
): StoryState {
  const ordered = [...deltasInIndexOrder].sort((left, right) => left.pageIndex - right.pageIndex);
  return ordered.reduce((state, item) => applyStoryDelta(state, item.delta, item.pageIndex), seed);
}

/**
 * Prompt-only window for `extractStoryState`. Does not mutate persisted state:
 * open promises stay, paid promises older than the last N are dropped, facts
 * and `knows` are sliced, and idle entities are omitted.
 */
export function compactStoryStateForExtract(state: StoryState): StoryState {
  const facts = state.facts.slice(-STORY_STATE_EXTRACT_FACTS_CAP).map((fact) => ({
    text: fact.text,
    pageIndex: fact.pageIndex
  }));
  const openPromises = state.promises.filter((promise) => promise.status === "open");
  const paidByPayoff = state.promises
    .filter((promise) => promise.status === "paid")
    .slice()
    .sort(
      (left, right) => (left.paidAtPage ?? left.openedAtPage) - (right.paidAtPage ?? right.openedAtPage)
    );
  const keptPaidIds = new Set(
    paidByPayoff.slice(-STORY_STATE_EXTRACT_PAID_PROMISES_CAP).map((promise) => promise.id)
  );
  const promises = state.promises
    .filter(
      (promise) => promise.status === "open" || promise.status === "broken" || keptPaidIds.has(promise.id)
    )
    .map(clonePromise);

  const entities: StoryState["entities"] = {};
  for (const [name, entity] of Object.entries(state.entities)) {
    if (!keepEntityForExtract(name, entity, facts, openPromises)) {
      continue;
    }
    entities[name] = {
      ...cloneEntity(entity),
      knows: entity.knows.slice(-STORY_STATE_EXTRACT_KNOWS_CAP)
    };
  }

  return { promises, facts, entities, unanswered: [...state.unanswered] };
}

export function formatStoryStateLines(state: StoryState, cap = STORY_STATE_LINE_CAP): string[] {
  const lines: string[] = [];
  for (const promise of state.promises) {
    if (lines.length >= cap) {
      break;
    }
    const payoff = promise.paidAtPage ? ` on page ${promise.paidAtPage}` : "";
    lines.push(`Promise ${promise.id} [${promise.status}]: ${promise.text}${payoff}`);
  }
  for (const [name, entity] of Object.entries(state.entities)) {
    if (lines.length >= cap) {
      break;
    }
    const bits = [
      entity.goal ? `goal ${entity.goal}` : "",
      entity.location ? `at ${entity.location}` : "",
      entity.status ? entity.status : "",
      entity.knows.length > 0 ? `knows ${entity.knows.slice(-3).join("; ")}` : ""
    ].filter(Boolean);
    lines.push(`${name} (p${entity.updatedAtPage}): ${bits.join("; ") || "present"}`);
  }
  for (const fact of state.facts.slice(-4)) {
    if (lines.length >= cap) {
      break;
    }
    lines.push(`Fact p${fact.pageIndex}: ${fact.text}`);
  }
  for (const question of state.unanswered.slice(0, 3)) {
    if (lines.length >= cap) {
      break;
    }
    lines.push(`Open: ${question}`);
  }
  return lines.slice(0, cap);
}

export function withStoryContradictions<T extends {
  approved: boolean;
  issues: string[];
  requiredRevisions: string[];
}>(report: T, contradictions: string[], unpaid: string[] = []): T {
  const extra = [...contradictions, ...unpaid].map((item) => item.trim()).filter(Boolean);
  if (extra.length === 0) {
    return report;
  }
  return withPageQaTriggerReasons({
    ...report,
    approved: false,
    issues: [...report.issues, ...extra],
    requiredRevisions: [...report.requiredRevisions, ...extra.map((item) => `Fix: ${item}`)]
  }, ["story_contradiction"]);
}

export function unpaidPromiseIssues(
  state: StoryState,
  pageIndex: number,
  targetPages: number
): string[] {
  if (pageIndex !== targetPages) {
    return [];
  }
  const open = state.promises.filter((promise) => promise.status === "open");
  if (open.length === 0) {
    return [];
  }
  return open.map((promise) => `Unpaid promise on the final page: ${promise.text}`);
}

export async function extractStoryState(options: {
  textModel: TextModelAdapter;
  pageIndex: number;
  title: string;
  markdown: string;
  summary: string;
  currentState: StoryState;
  previousPages?: readonly { index: number; markdown: string }[];
}): Promise<StoryExtractResult> {
  const priorPages = (options.previousPages ?? []).filter((page) => page.index < options.pageIndex);
  const marker = "\n[Middle prose omitted; unknown context.]\n";
  const edgeChars = Math.floor((1800 - marker.length) / 2);
  const sourcePages = priorPages.slice(-8).map((page) => ({ ...page,
    markdown: page.markdown.length <= 1800 ? page.markdown : `${page.markdown.slice(0, edgeChars)}${marker}${page.markdown.slice(-edgeChars)}`,
    complete: page.markdown.length <= 1800
  }));
  const sourceContext = { complete: sourcePages.length === options.pageIndex - 1 && sourcePages.every((page, index) => page.index === index + 1 && page.complete),
    omittedPageCount: Math.max(0, options.pageIndex - 1 - sourcePages.length),
    shortenedPageIndexes: sourcePages.filter((page) => !page.complete).map((page) => page.index) };
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "extract-story-state",
    temperature: 0,
    maxTokens: 1200,
    schema: storyExtractResultSchema,
    jsonContractInMessages: true,
    messages: [
      {
        role: "system",
        content: [
          "You extract structured story state from one book page.",
          "Return storyDelta, contradictions and contradictionEvidence.",
          "storyDelta may open, pay, or break promises; add facts; update entities; add or resolve unanswered questions.",
          "currentState is fallible derived bookkeeping, not authoritative prose. A paid promise flag alone never proves that every object was found or that a later discovery is wrong.",
          "For each contradiction cite priorPageIndex and exact priorQuote from sourcePages, plus exact currentQuote from this page in contradictionEvidence. Compare actual statements, allowing normal changes over time. Without both prose anchors leave contradictions empty; do not invent evidence or rewrite valid prose to satisfy a state marker.",
          "sourceContext marks missing pages and shortened excerpts. Omitted prose is unknown, never proof that an event did not happen. The omission marker is not story text and cannot be quoted as evidence.",
          "Do not rewrite the page. Do not invent promises the page does not make or pay.",
          "Do not turn a character intention, boast or mistaken belief into a guarantee of literal success. Store it as an entity goal. A change of goal, cooperation or learned lesson can pay the dramatic commitment. All unansweredAdded and unansweredResolved fields belong inside storyDelta, never at the root.",
          "Return only changes introduced by this page, not a copy of currentState. Keep entries concise.",
          "factsAdded contains strings, not fact objects. promisesPaid and promisesBroken contain existing promise IDs or exact promise texts.",
          "entities maps names to updates using only goal, knows, location, and status. Put technical properties in factsAdded; omit page timestamps.",
          `Required JSON schema: ${JSON.stringify(storyExtractOutputSchema)}`
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            pageIndex: options.pageIndex,
            title: options.title,
            markdown: options.markdown,
            summary: options.summary,
            currentState: compactStoryStateForExtract(options.currentState),
            sourcePages,
            sourceContext
          },
          null,
          2
        )
      }
    ]
  });
  const extracted = storyExtractResultSchema.parse(result.data);
  // A quote must be both visible in this request and present in the original
  // source: an omission marker can never fabricate a continuous passage.
  const visible = { ...extracted, contradictionEvidence: extracted.contradictionEvidence?.filter((evidence) =>
    sourcePages.some((page) => page.index === evidence.priorPageIndex && page.markdown.includes(evidence.priorQuote))) };
  return validateStoryExtractEvidence(visible,
    { index: options.pageIndex, markdown: options.markdown }, priorPages);
}

function capPersistedStoryState(state: StoryState): StoryState {
  const entities: StoryState["entities"] = {};
  for (const [name, entity] of Object.entries(state.entities)) {
    entities[name] = {
      ...cloneEntity(entity),
      knows: entity.knows.slice(-STORY_STATE_PERSIST_KNOWS_CAP)
    };
  }
  return {
    promises: state.promises,
    facts: state.facts.slice(-STORY_STATE_PERSIST_FACTS_CAP),
    entities,
    unanswered: state.unanswered
  };
}

function keepEntityForExtract(
  name: string,
  entity: StoryEntity,
  facts: StoryFact[],
  openPromises: StoryPromise[]
): boolean {
  if (openPromises.some((promise) => mentionsName(promise.text, name))) {
    return true;
  }
  if (facts.some((fact) => mentionsName(fact.text, name))) {
    return true;
  }
  const oldestKeptPage = facts[0]?.pageIndex;
  return oldestKeptPage != null && entity.updatedAtPage >= oldestKeptPage;
}

function mentionsName(haystack: string, name: string): boolean {
  const needle = foldKey(name);
  if (!needle) {
    return false;
  }
  const hay = foldKey(haystack);
  return (
    hay === needle || hay.startsWith(`${needle} `) || hay.endsWith(` ${needle}`) || hay.includes(` ${needle} `)
  );
}

function clonePromise(promise: StoryPromise): StoryPromise {
  return {
    id: promise.id,
    text: promise.text,
    status: promise.status,
    openedAtPage: promise.openedAtPage,
    ...(promise.paidAtPage ? { paidAtPage: promise.paidAtPage } : {})
  };
}

function cloneEntity(entity: StoryEntity): StoryEntity {
  return {
    ...(entity.goal ? { goal: entity.goal } : {}),
    knows: [...entity.knows],
    ...(entity.location ? { location: entity.location } : {}),
    ...(entity.status ? { status: entity.status } : {}),
    updatedAtPage: entity.updatedAtPage
  };
}

function findPromise(promises: StoryPromise[], key: string): StoryPromise | undefined {
  const folded = foldKey(key);
  return promises.find((promise) => promise.id === key || foldKey(promise.text) === folded);
}

function nextPromiseId(promises: StoryPromise[]): string {
  let max = 0;
  for (const promise of promises) {
    const match = /^p(\d+)$/.exec(promise.id);
    if (!match?.[1]) {
      continue;
    }
    max = Math.max(max, Number(match[1]));
  }
  return `p${max + 1}`;
}

function foldKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = foldKey(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}
