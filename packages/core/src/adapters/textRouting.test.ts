import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "./fake.js";
import { MECHANICAL_TEXT_PURPOSES } from "./modelTiers.js";
import { RoutingTextModelAdapter } from "./textRouting.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  ToolCallsResult
} from "./types.js";

/**
 * `book.final_qa.chapter_transitions` is passed by apps/worker (compileExport.ts),
 * which this core test does not read; the worker's own suites exercise the call
 * that carries it.
 */
const PURPOSES_EMITTED_OUTSIDE_CORE: ReadonlySet<string> = new Set(["book.final_qa.chapter_transitions"]);

/**
 * Every other purpose core passes today: the prose writers and revisers, the
 * three small text calls that have never been routed anywhere else, and the two
 * research queries, which reach the research adapter and are routed by nothing.
 *
 * Listed rather than ignored so that adding a purpose is a decision. Routing is
 * "prose unless named", so the trap is silence: a mechanical call left off
 * `MECHANICAL_TEXT_PURPOSES` runs a strict-schema request on a premium book's
 * prose model and nothing anywhere says so.
 */
const PROSE_LANE_PURPOSES: ReadonlySet<string> = new Set([
  "generate-whole-book",
  "generate-chapter-draft",
  "generate-page",
  "generate-page-batch",
  "write-page-with-tools",
  "polish-page",
  "revise-page",
  "plan-book",
  "revise-plan",
  "build-voice-character-persona",
  "extract-voice-character-candidates",
  "creation-attachment-digest",
  "detect-language",
  "chapter-research",
  "plan-research"
]);

/** Model-call purposes are identifier-shaped; `purpose` is also a page brief's own field, whose values are sentences. */
const PURPOSE_IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/**
 * Every purpose `packages/core` passes to a provider call, read out of the
 * source because nothing collects them at runtime — a purpose is a string
 * literal at its call site, and two of them are spelled as an exported
 * constant instead (`COVER_DESIGN_SELECTION_PURPOSE`,
 * `COPYRIGHT_SAFE_IMAGE_PROMPT_PURPOSE`), which is how one of them stayed off
 * the mechanical list unnoticed.
 */
async function purposesEmittedByCore(): Promise<ReadonlySet<string>> {
  const files = await coreSourceFiles(fileURLToPath(new URL("../", import.meta.url)));
  const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

  const constants = new Map<string, string>();
  for (const [, name, value] of combined.matchAll(/export const ([A-Z][A-Z0-9_]*) = "([^"]*)"/g)) {
    if (name && value) {
      constants.set(name, value);
    }
  }

  const purposes = new Set<string>();
  for (const [, literal, identifier] of combined.matchAll(/\bpurpose:\s*(?:"([^"]*)"|([A-Za-z_]\w*))/g)) {
    const value = literal ?? (identifier ? constants.get(identifier) : undefined);
    if (value && PURPOSE_IDENTIFIER.test(value)) {
      purposes.add(value);
    }
  }
  return purposes;
}

async function coreSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await coreSourceFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

class RecordingTextAdapter implements TextModelAdapter {
  purposes: Array<string | undefined> = [];

  constructor(private readonly name: string) {}

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    this.purposes.push(options.purpose);
    return { text: this.name, model: this.name, provider: this.name };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    this.purposes.push(options.purpose);
    return { text: this.name, model: this.name, provider: this.name, data: undefined as T };
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    this.purposes.push(options.purpose);
    yield this.name;
  }

  generateWithTools(): Promise<ToolCallsResult> {
    return unsupportedGenerateWithTools();
  }
}

function routedAdapters() {
  const prose = new RecordingTextAdapter("prose-model");
  const mechanical = new RecordingTextAdapter("mechanical-model");
  const routing = new RoutingTextModelAdapter(
    { selection: { provider: "gemini", model: "prose-model" }, adapter: prose },
    { selection: { provider: "gemini", model: "mechanical-model" }, adapter: mechanical }
  );
  return { prose, mechanical, routing };
}

describe("RoutingTextModelAdapter", () => {
  it("routes every mechanical purpose to the mechanical model", async () => {
    const { mechanical, routing } = routedAdapters();

    for (const purpose of MECHANICAL_TEXT_PURPOSES) {
      const result = await routing.generateText({ messages: [], purpose });
      expect(result.model).toBe("mechanical-model");
      expect(routing.selectionForPurpose(purpose).model).toBe("mechanical-model");
    }
    expect(mechanical.purposes).toEqual([...MECHANICAL_TEXT_PURPOSES]);
  });

  it("routes prose and unknown purposes to the prose model", async () => {
    const { prose, routing } = routedAdapters();

    for (const purpose of ["generate-page", "plan-book", "polish-page", "some-future-purpose"]) {
      const result = await routing.generateJson({ messages: [], purpose, schema: undefined as never });
      expect(result.model).toBe("prose-model");
    }
    expect((await routing.generateJson({ messages: [], schema: undefined as never })).model).toBe("prose-model");
    expect(routing.selectionForPurpose("generate-page").model).toBe("prose-model");
    expect(routing.selectionForPurpose(undefined).model).toBe("prose-model");
    expect(prose.purposes).toHaveLength(5);
  });

  it("routes plan-book to a purpose override when one is registered", async () => {
    const prose = new RecordingTextAdapter("prose-model");
    const mechanical = new RecordingTextAdapter("mechanical-model");
    const plan = new RecordingTextAdapter("plan-thinking-model");
    const routing = new RoutingTextModelAdapter(
      { selection: { provider: "gemini", model: "prose-model", thinkingBudget: 2048 }, adapter: prose },
      { selection: { provider: "gemini", model: "mechanical-model", thinkingBudget: 0 }, adapter: mechanical },
      new Map([
        ["plan-book", { selection: { provider: "gemini", model: "plan-thinking-model", thinkingBudget: 4096 }, adapter: plan }]
      ])
    );

    expect((await routing.generateJson({ messages: [], purpose: "plan-book", schema: undefined as never })).model).toBe(
      "plan-thinking-model"
    );
    expect(routing.selectionForPurpose("plan-book").thinkingBudget).toBe(4096);
    expect(routing.selectionForPurpose("generate-page").thinkingBudget).toBe(2048);
    routing.setPurposeOverridesEnabled(false);
    expect(routing.selectionForPurpose("plan-book").model).toBe("prose-model");
  });

  it("routes streamText by purpose", async () => {
    const { routing } = routedAdapters();

    const chunks: string[] = [];
    for await (const chunk of routing.streamText({ messages: [], purpose: "review-page" })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["mechanical-model"]);
  });

  it("pins mechanical purposes to the strings generation code actually passes", async () => {
    const emitted = await purposesEmittedByCore();

    for (const purpose of MECHANICAL_TEXT_PURPOSES) {
      if (PURPOSES_EMITTED_OUTSIDE_CORE.has(purpose)) {
        continue;
      }
      expect([...emitted], `purpose "${purpose}" is no longer used by generation code`).toContain(purpose);
    }
  });

  it("classifies every purpose core passes, so a new one cannot silently take the prose lane", async () => {
    const emitted = await purposesEmittedByCore();

    const unclassified = [...emitted].filter(
      (purpose) => !MECHANICAL_TEXT_PURPOSES.has(purpose) && !PROSE_LANE_PURPOSES.has(purpose)
    );
    expect(
      unclassified,
      "A new purpose defaults to the tier's prose model. Decide which it is: add it to " +
        "MECHANICAL_TEXT_PURPOSES (modelTiers.ts) if it is a strict-schema, judging or " +
        "find-and-replace call, or to PROSE_LANE_PURPOSES here if it writes reader-facing prose " +
        "or reaches a different adapter altogether."
    ).toEqual([]);
  });
});
