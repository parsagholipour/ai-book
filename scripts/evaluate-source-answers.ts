/** Live-provider evaluation of synthetic sources created by evaluate-source-documents.ts. */
import assert from "node:assert/strict";

if (!process.env.DATABASE_URL?.includes("codex_sources_test")) throw new Error("Use an isolated codex_sources_test database for this evaluation.");
process.env.MOCK_AI = "false";
const { loadConfig, runToolLoop, createSourceTools, SOURCE_INSTRUCTIONS, SourceAwareTextModel } = await import("../packages/core/src/index.ts");
const { prisma, createSourceService } = await import("../packages/db/src/index.ts");
const { createLiveFastJudgmentsTextModel } = await import("../apps/api/src/generationTextModelRouting.ts");
const config = loadConfig();
const model = createLiveFastJudgmentsTextModel(config);
const results: unknown[] = [];
try {
  const documents = await prisma.sourceDocument.findMany({ where: { userId: "source-eval-owner" }, orderBy: { name: "asc" } });
  assert.equal(documents.length, 2, "Run the offline evaluation first to create the synthetic archives.");
  const refs = documents.map((document) => ({ sourceId: document.id, version: 1 }));
  // Deliberately evaluate lexical fallback: the important facts occur past 160k characters.
  const sources = createSourceService("source-eval-owner", refs);
  const questions = [
    { name: "deep ending", question: "According to archive.txt, what was the archive access code and what year did the observatory close?", expected: ["ORCHID-913", "2047"] },
    { name: "conflicting documents", question: "Compare the archive codes and closing years reported by archive.txt and native.pdf. Keep each file's claims separate.", expected: ["ORCHID-913", "2047", "BLUE-774", "2061"] },
    { name: "whole document", question: "Give an overview of the entire archive.txt, including its final section. Use the complete section overview before answering and cite evidence for specific facts.", expected: ["ORCHID-913", "2047"], overview: true },
    { name: "missing evidence", question: "What is the full name of the head astronomer according to these uploaded files? If absent, say it is not stated.", expected: [], missing: true }
  ];
  for (const question of questions) {
    const ledger = createSourceTools(sources);
    const start = Date.now();
    const response = await runToolLoop({ textModel: model, tools: ledger.tools, purpose: "creation-chat", maxTokens: 900, maxModelCalls: 4, finishOnLastCall: true, maxToolResultChars: 1_000_000, temperature: 0,
      messages: [{ role: "system", content: `${SOURCE_INSTRUCTIONS} Answer only from uploaded evidence. Available files: ${JSON.stringify(documents.map(({ id, name }) => ({ sourceId: id, name, version: 1 })))}` }, { role: "user", content: question.question }] });
    const answer = ledger.validate(response.finalText);
    const citations = answer.match(/\[source:[^\]\n]+\]/g) ?? [];
    const factsCorrect = question.expected.every((fact) => answer.includes(fact));
    const citationsValid = answer === response.finalText && (question.missing || citations.length > 0);
    const citesSupportingPassages = question.expected.every((fact) => ledger.passages().some((passage) => passage.content.includes(fact) && citations.includes(`[source:${passage.sourceId}:${passage.version}:${passage.ordinal}]`)));
    const checkedOverview = !question.overview || response.toolEvents.some((event) => event.call.name === "read_source" && event.call.arguments?.ordinal === undefined);
    const missingAcknowledged = !question.missing || /not (stated|provided|specified|mentioned|found)|no (full name|name)|do not (state|provide|specify|mention)|does not (state|provide|specify|mention)|cannot (find|determine)/i.test(answer);
    const passed = response.status === "finished" && factsCorrect && citationsValid && citesSupportingPassages && checkedOverview && missingAcknowledged;
    results.push({ name: question.name, passed, elapsedMs: Date.now() - start, usage: response.usage, model: response.model, provider: response.provider, toolCalls: response.toolEvents.map((event) => event.call.name), answer });
    console.log(JSON.stringify(results.at(-1)));
    assert(passed, `${question.name} failed; inspect the recorded answer.`);
  }
  const start = Date.now();
  const chapter = await new SourceAwareTextModel(model, async () => sources).generateText({ purpose: "compose-chapter", maxTokens: 500, temperature: 0, messages: [{ role: "user", content: "Write one short nonfiction chapter paragraph about the observatory's closure, using archive.txt. Include its closing year and archive access code. Cite the supporting private passage." }] });
  const passed = chapter.text.includes("2047") && chapter.text.includes("ORCHID-913") && /\[source:[^\]]+\]/.test(chapter.text) && !chapter.text.includes("[unverified source]");
  const chapterResult = { name: "generated chapter paragraph", passed, elapsedMs: Date.now() - start, usage: chapter.usage, model: chapter.model, provider: chapter.provider, answer: chapter.text };
  results.push(chapterResult);
  console.log(JSON.stringify(chapterResult));
  assert(passed, "Generated chapter did not retain the cited deep-source facts.");
  console.log(JSON.stringify({ mode: "live provider, synthetic source fixtures, lexical fallback", passed: results.length, total: questions.length + 1 }));
} finally {
  await prisma.$disconnect();
}
