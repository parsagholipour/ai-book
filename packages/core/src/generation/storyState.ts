import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

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

export const storyExtractResultSchema = z.object({
  storyDelta: storyDeltaSchema,
  contradictions: z.array(z.string()).default([])
});

export type StoryPromise = z.infer<typeof storyPromiseSchema>;
export type StoryFact = z.infer<typeof storyFactSchema>;
export type StoryEntity = z.infer<typeof storyEntitySchema>;
export type StoryState = z.infer<typeof storyStateSchema>;
export type StoryDelta = z.infer<typeof storyDeltaSchema>;
export type StoryExtractResult = z.infer<typeof storyExtractResultSchema>;

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
  return {
    ...report,
    approved: false,
    issues: [...report.issues, ...extra],
    requiredRevisions: [...report.requiredRevisions, ...extra.map((item) => `Fix: ${item}`)]
  };
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
}): Promise<StoryExtractResult> {
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "extract-story-state",
    temperature: 0,
    maxTokens: 1200,
    schema: storyExtractResultSchema,
    messages: [
      {
        role: "system",
        content: [
          "You extract structured story state from one book page.",
          "Return JSON with storyDelta and contradictions.",
          "storyDelta may open, pay, or break promises; add facts; update entities; add or resolve unanswered questions.",
          "contradictions lists ways this page disagrees with currentState. Empty when consistent.",
          "Do not rewrite the page. Do not invent promises the page does not make or pay."
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
            currentState: compactStoryStateForExtract(options.currentState)
          },
          null,
          2
        )
      }
    ]
  });
  return storyExtractResultSchema.parse(result.data);
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
