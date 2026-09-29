import { describe, expect, it } from "vitest";

import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import { AdapterJsonValidationError, parseSchemaWithContext } from "../adapters/json.js";
import { isRecoverableNetworkError } from "../adapters/retry.js";
import type { GenerateJsonOptions, JsonResult, TextModelAdapter } from "../adapters/types.js";
import { runQuickAuthorAssist, type QuickAuthorAssistRequest } from "./authorAssist.js";
import { AuthorAssistInputError, AuthorAssistUnavailableError, type AuthorAssistBook } from "./authorAssistTypes.js";

type Reply = unknown | Error | ((options: GenerateJsonOptions<unknown>) => unknown);

/** A text model that answers from a script, validating like a real adapter does. */
function scripted(...replies: Reply[]) {
  const requests: GenerateJsonOptions<unknown>[] = [];
  const textModel: TextModelAdapter = {
    async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
      requests.push(options as GenerateJsonOptions<unknown>);
      if (replies.length === 0) throw new Error("script exhausted");
      const next = replies.shift();
      if (next instanceof Error) throw next;
      const value = typeof next === "function" ? (next as (o: GenerateJsonOptions<unknown>) => unknown)(options as GenerateJsonOptions<unknown>) : next;
      const text = JSON.stringify(value);
      return { data: parseSchemaWithContext("Scripted", options.schema, value, options.purpose, text), text, model: "scripted", provider: "scripted" };
    },
    generateText: () => Promise.reject(new Error("generateText is not used")),
    async *streamText() {},
    generateWithTools: unsupportedGenerateWithTools
  };
  return { textModel, requests };
}

const book: AuthorAssistBook = { title: "The Salt Road", kind: "story", language: "en" };

function request(overrides: Partial<QuickAuthorAssistRequest>): QuickAuthorAssistRequest {
  return { kind: "rewrite", book, chapter: { title: "The Well", notes: "" }, ...overrides };
}

function payload(options: GenerateJsonOptions<unknown>): Record<string, unknown> {
  return JSON.parse(options.messages.at(-1)!.content) as Record<string, unknown>;
}

describe("runQuickAuthorAssist: validation", () => {
  it.each([
    ["rewrite", {}, "SELECTION_REQUIRED"],
    ["proofread", { selection: "   \n" }, "SELECTION_REQUIRED"],
    ["describe", { selection: "" }, "SELECTION_REQUIRED"],
    ["ask", { selection: "Text." }, "INSTRUCTION_REQUIRED"],
    ["ask", { instruction: "  " }, "INSTRUCTION_REQUIRED"],
    ["rewrite", { selection: "x".repeat(6001) }, "INPUT_TOO_LONG"],
    ["continue", { before: "x".repeat(4001) }, "INPUT_TOO_LONG"],
    ["continue", { after: "x".repeat(1501) }, "INPUT_TOO_LONG"],
    ["ask", { instruction: "x".repeat(501) }, "INPUT_TOO_LONG"],
    ["rewrite", { selection: "Text.", preset: "louder" }, "INVALID_INPUT"],
    ["summarize", { selection: "Text." }, "INVALID_INPUT"]
  ] as const)("%s %j is refused with %s before any model call", async (kind, fields, code) => {
    const { textModel, requests } = scripted();
    const error = await runQuickAuthorAssist(request({ kind: kind as never, ...(fields as object) }), { textModel }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorAssistInputError);
    expect((error as AuthorAssistInputError).code).toBe(code);
    expect(requests).toHaveLength(0);
  });

  it("serves continue and brainstorm with no text at all", async () => {
    const { textModel } = scripted({ text: "It began to rain." }, { ideas: [{ title: "Rain", text: "It rains." }] });
    await expect(runQuickAuthorAssist(request({ kind: "continue" }), { textModel })).resolves.toMatchObject({
      suggestions: [{ text: "It began to rain." }]
    });
    await expect(runQuickAuthorAssist(request({ kind: "brainstorm" }), { textModel })).resolves.toMatchObject({
      ideas: [{ title: "Rain", text: "It rains." }]
    });
  });
});

describe("runQuickAuthorAssist: kinds", () => {
  it("rewrite returns one cleaned replacement that keeps the selection's whitespace", async () => {
    const { textModel, requests } = scripted({ text: 'Here is the clearer version:\n"The well had run dry."' });
    const result = await runQuickAuthorAssist(request({ selection: "\nThe well was dry, it was.\n\n", preset: "clearer" }), { textModel });
    expect(result).toEqual({
      kind: "rewrite",
      suggestions: [{ text: "\nThe well had run dry.\n\n" }],
      corrections: [],
      ideas: [],
      answer: null
    });
    expect(requests[0]!.purpose).toBe("author-assist-rewrite");
    expect(payload(requests[0]!)).toMatchObject({ task: "rewrite", preset: "clearer", selection: "\nThe well was dry, it was.\n\n" });
  });

  it("proofread keeps only corrections the client can apply exactly", async () => {
    const selection = "Teh well was dry and teh sky was white.";
    const { textModel, requests } = scripted({
      corrections: [
        { find: "teh sky", replace: "the sky", reason: "spelling" },
        { find: "Teh well", replace: "The well", reason: "spelling" },
        { find: "teh", replace: "the", reason: "ambiguous" },
        { find: "green", replace: "white", reason: "not in selection" }
      ]
    });
    const result = await runQuickAuthorAssist(request({ kind: "proofread", selection }), { textModel });
    expect(result.corrections).toEqual([
      { find: "Teh well", replace: "The well", reason: "spelling" },
      { find: "teh sky", replace: "the sky", reason: "spelling" }
    ]);
    expect(result.suggestions).toEqual([]);
    expect(requests[0]!.purpose).toBe("author-assist-proofread");
  });

  it("proofread with nothing to fix is a successful empty result", async () => {
    const { textModel } = scripted({ corrections: [] });
    await expect(runQuickAuthorAssist(request({ kind: "proofread", selection: "All good." }), { textModel })).resolves.toMatchObject({
      corrections: []
    });
  });

  it("continue strips an echo of the cursor's last words and joins at the cursor", async () => {
    const before = "They reached the well at noon and looked down into the dark.";
    const { textModel, requests } = scripted({ text: "looked down into the dark. Nothing moved below." });
    const result = await runQuickAuthorAssist(request({ kind: "continue", before, after: "Later, " }), { textModel });
    expect(result.suggestions).toEqual([{ text: " Nothing moved below. " }]);
    expect(requests[0]!.purpose).toBe("author-assist-continue");
  });

  it("continue keeps the paragraph break the model opened", async () => {
    const { textModel } = scripted({ text: "\n\nMorning came." });
    const result = await runQuickAuthorAssist(request({ kind: "continue", before: "She slept." }), { textModel });
    expect(result.suggestions[0]!.text).toBe("\n\nMorning came.");
  });

  it("describe returns the richer replacement", async () => {
    const { textModel, requests } = scripted({ text: "The well was dry, its stones cracked and warm to the touch." });
    const result = await runQuickAuthorAssist(request({ kind: "describe", selection: "The well was dry." }), { textModel });
    expect(result.suggestions).toEqual([{ text: "The well was dry, its stones cracked and warm to the touch." }]);
    expect(requests[0]!.purpose).toBe("author-assist-describe");
  });

  it("brainstorm returns up to three clean ideas", async () => {
    const { textModel } = scripted({
      ideas: [
        { title: "A rope", text: "They find a rope." },
        { title: "A voice", text: "Someone calls from below." },
        { title: "A map", text: "The well is on an old map." },
        { title: "A fourth", text: "Extra." }
      ]
    });
    const result = await runQuickAuthorAssist(request({ kind: "brainstorm", before: "The well was dry." }), { textModel });
    expect(result.ideas.map((idea) => idea.title)).toEqual(["A rope", "A voice", "A map"]);
  });

  it("ask returns the answer, clipped when it runs long", async () => {
    const long = "This sentence is an editor's point. ".repeat(80);
    const { textModel, requests } = scripted({ answer: "The pacing is fine." }, { answer: long });
    const first = await runQuickAuthorAssist(request({ kind: "ask", instruction: "Is it slow?" }), { textModel });
    expect(first.answer).toBe("The pacing is fine.");
    expect(payload(requests[0]!)).toMatchObject({ instruction: "Is it slow?" });
    const second = await runQuickAuthorAssist(request({ kind: "ask", instruction: "Is it slow?" }), { textModel });
    expect(second.answer!.length).toBeLessThanOrEqual(1400);
    expect(second.answer!.endsWith(".")).toBe(true);
  });
});

describe("runQuickAuthorAssist: failures", () => {
  it("repairs a reply that does not match the schema once", async () => {
    const { textModel, requests } = scripted({ rewrite: "wrong key" }, { text: "Fixed." });
    const result = await runQuickAuthorAssist(request({ selection: "Old." }), { textModel });
    expect(result.suggestions).toEqual([{ text: "Fixed." }]);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages[0]!.content).toContain("did not match the required schema");
  });

  it("reports an unusable reply as unavailable", async () => {
    const empty = scripted({ text: "   " });
    await expect(runQuickAuthorAssist(request({ selection: "Old." }), { textModel: empty.textModel })).rejects.toBeInstanceOf(
      AuthorAssistUnavailableError
    );
    const invalid = scripted({ nope: 1 }, { nope: 2 });
    const error = await runQuickAuthorAssist(request({ selection: "Old." }), { textModel: invalid.textModel }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorAssistUnavailableError);
    expect((error as AuthorAssistUnavailableError).code).toBe("ASSIST_UNAVAILABLE");
    expect((error as Error).cause).toBeInstanceOf(AdapterJsonValidationError);
    const noIdeas = scripted({ ideas: [{ title: "", text: "" }] });
    await expect(runQuickAuthorAssist(request({ kind: "brainstorm" }), { textModel: noIdeas.textModel })).rejects.toBeInstanceOf(
      AuthorAssistUnavailableError
    );
  });

  it("wraps a provider failure without hiding that it is a network error", async () => {
    const network = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const { textModel } = scripted(network);
    const error = await runQuickAuthorAssist(request({ selection: "Old." }), { textModel }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthorAssistUnavailableError);
    expect((error as Error).cause).toBe(network);
    expect(isRecoverableNetworkError(error)).toBe(true);
  });

  it("lets a cancellation through untouched, and forwards the signal", async () => {
    const controller = new AbortController();
    const abort = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    const { textModel, requests } = scripted(abort);
    await expect(runQuickAuthorAssist(request({ selection: "Old." }), { textModel, signal: controller.signal })).rejects.toBe(abort);
    expect(requests[0]!.signal).toBe(controller.signal);
  });
});
