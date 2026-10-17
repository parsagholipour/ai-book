/**
 * E1b arm G1: the compose call with fidelity enforced, for a writer other than luna (run it as
 * `fidelity+model=gemini:gemini-3.7-flash+effort=none`). Two layers, both outside product code:
 *
 * - Prompt (nonfiction only, rewritten in place in the logged system prompt): the creative contract's
 *   licence to draw people, dates and numbers from the writer's own knowledge becomes a record rule, and the
 *   quote promise ("words you are confident were said") becomes "words that appear verbatim in what you were
 *   given". Fiction is untouched; grounded-contract prompts carry none of these strings and are untouched.
 * - Code: `fidelityGuard` on the staged chapter (see fidelityGuard.ts).
 *
 * A fiction fixture's prompt and guard are G0's, so its result is G0's stored one (`peer`) when present.
 */
import { chapterFinal, rewriteSystem } from "./common.ts";
import { fidelityGuard, guardDocuments, guardModeFor, suppliedMaterial } from "./fidelityGuard.ts";
import type { Variant } from "./types.ts";

const NONFICTION = new Set(["analytical-history", "instructional"]);
/** The E1 arm whose fiction outputs G1 shares (same prompt, no guard). */
export const GEMINI_E1_LABEL = "baseline+model=gemini_gemini-3.7-flash+effort=none";

export const RECORD_RULE =
  "researchNotes and everything else you were given for this chapter are its record, and its particulars come from that record: the people, places, dates, documents, objects and numbers that make a page particular, the telling detail over the safe generality. You are an author who knows this subject, so your own knowledge explains, connects and gives context, but it brings in no named person, organisation, date, statistic or study that the record does not hold.";
export const TOOLKIT_RECORD_RULE =
  "researchNotes and everything else you were given for this chapter are its record. The book's own example people, their situations and their numbers are yours to make; a real person, organisation, date, statistic or study appears only where the record holds it, and your own knowledge of the subject supplies the method and the explanation around it.";
export const QUOTE_RULE =
  "Quotation marks are a promise. Put them only around words that appear verbatim in what you were given, and say who said them; anything else a person or a document said is told in your own words, attributed, without marks.";
export const TOOLKIT_QUOTE_RULE =
  "Quotation marks around a real person's or a document's words are a promise: use them only for words that appear verbatim in what you were given, and say who said them; anything else a real person or a document said is told in your own words, attributed, without marks.";

const LICENCE =
  "researchNotes are a starting point, not a boundary. You are an author who knows this subject: draw on your own knowledge for the people, places, dates, documents, objects and numbers that make a page particular, and prefer the telling detail to the safe generality.";
const PROMISE = "Quotation marks are a promise. Put them only around words you are confident were said or written in that form, and say who said them; otherwise give the sense in your own words without marks.";
const TOOLKIT_PROMISE = "Quotation marks around a real person's or a document's words are a promise: use them only for words you are confident were said or written in that form, and say who said them.";
const BEYOND = "Beyond them, write as an author who knows this subject.";

/** The logged system prompt with the fidelity rules in place, and which rewrites applied. */
export function withFidelityRules(system: string): { system: string; applied: string[] } {
  const toolkit = guardModeFor(system) === "toolkit";
  const applied: string[] = [];
  let out = system;
  const swap = (id: string, from: string, to: string) => {
    if (!out.includes(from)) return;
    out = out.replace(from, to);
    applied.push(id);
  };
  swap("record", LICENCE, toolkit ? TOOLKIT_RECORD_RULE : RECORD_RULE);
  swap("quote", PROMISE, QUOTE_RULE);
  swap("toolkit-quote", TOOLKIT_PROMISE, TOOLKIT_QUOTE_RULE);
  swap("beyond", BEYOND, "Beyond them, explain as an author who knows this subject.");
  return { system: out, applied };
}

export const fidelity: Variant = {
  name: "fidelity",
  description: "E1b G1: nonfiction compose with the record rule and the verbatim-quote rule in place of the creative licence, then the fidelity quote guard on the staged chapter. Fiction reuses the E1 Gemini arm's result.",
  purposes: ["compose-chapter"],
  async run(context) {
    const { fixture } = context;
    if (!NONFICTION.has(fixture.writingMode)) {
      const peer = context.peer?.(GEMINI_E1_LABEL);
      if (peer && !peer.error) {
        return {
          output: peer.output,
          finalText: peer.finalText ?? chapterFinal(fixture, peer.output),
          calls: [],
          reported: { latencyMs: peer.latencyMs, usage: peer.usage, costUsd: peer.costUsd, model: peer.model },
          extra: { reusedFrom: GEMINI_E1_LABEL }
        };
      }
    }
    const nonfiction = NONFICTION.has(fixture.writingMode);
    let applied: string[] = [];
    const messages = nonfiction
      ? rewriteSystem(fixture.messages, (system) => {
          const rewritten = withFidelityRules(system);
          applied = rewritten.applied;
          return rewritten.system;
        })
      : fixture.messages;
    const record = await context.call({
      purpose: fixture.purpose,
      messages,
      ...(fixture.request.temperature !== undefined ? { temperature: fixture.request.temperature } : {}),
      ...(fixture.request.maxTokens !== undefined ? { maxTokens: fixture.request.maxTokens } : {})
    });
    const staged = chapterFinal(fixture, record.text);
    if (!nonfiction) return { output: record.text, finalText: staged, calls: [record] };
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const guard = fidelityGuard(staged, { material: suppliedMaterial(messages, fixture.payload), mode: guardModeFor(system), documents: guardDocuments(fixture.payload) });
    return {
      output: record.text,
      finalText: guard.markdown,
      calls: [record],
      extra: {
        rewrites: applied,
        guard: { mode: guardModeFor(system), unverified: guard.unverified, stripped: guard.stripped, flagged: guard.flagged, unpairedParagraphs: guard.unpairedParagraphs, spans: guard.spans.filter((span) => span.action !== "verbatim") },
        unguardedFinalText: staged
      }
    };
  }
};
