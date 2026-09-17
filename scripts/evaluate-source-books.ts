import { MemoryObjectStore, setObjectStoreForTests } from "../packages/storage/src/index.ts";
setObjectStoreForTests(new MemoryObjectStore());
/** Opt-in acceptance: production worker, PostgreSQL, private Redis, live models and PDF. */
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { eightyPageSourcePdf } from "./source-book-pdf-fixture.js";

assert(new URL(process.env.DATABASE_URL!).pathname.startsWith("/codex_sources_test_books_"), "Use a disposable books-test database");
assert(process.env.REDIS_URL === "redis://127.0.0.1:16389", "Use the dedicated test Redis on port 16389");
const root = resolve(process.env.SOURCE_BOOK_EVAL_OUTPUT ?? ".scratch/source-book-live");
const pdf80 = process.env.SOURCE_BOOK_EVAL_PDF80 === "true";
await mkdir(root, { recursive: true });
Object.assign(process.env, { MOCK_AI: "false", FULL_DOCUMENT_SOURCES: "true", BOOK_STORAGE_DIR: join(root, "books"), IMAGE_STORAGE_DIR: join(root, "images"), ATTACHMENT_STORAGE_DIR: join(root, "attachments") });

// A transport fuse only: all requests reach the real provider, all responses are
// unchanged. Count actual usage, cap each response and refuse further paid calls
// after the run budget. No fake models or fabricated generation results.
const originalFetch = globalThis.fetch;
const calls: Array<{ model?: string; status: number; input: number; output: number; elapsedMs: number }> = await readFile(join(root, "usage.json"), "utf8").then(JSON.parse).catch(() => []);
let reservedOutput = 0;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "api.deepseek.com") {
    const body = await request.clone().json();
    const usedInput = calls.reduce((sum, call) => sum + call.input, 0);
    const usedOutput = calls.reduce((sum, call) => sum + call.output, 0);
    const cap = Math.min(body.max_tokens ?? 5000, 5000, 24000 - usedOutput - reservedOutput);
    assert(calls.length < (pdf80 ? 140 : 35) && usedInput < 160000 && 24000 - usedOutput - reservedOutput >= 800, "Live test token/call budget exhausted");
    body.max_tokens = cap;
    reservedOutput += cap;
    const start = Date.now();
    try {
      const response = await originalFetch(new Request(request, { method: "POST", body: JSON.stringify(body) }));
      const raw = await response.clone().text();
      const payloads = raw.startsWith("data:") ? raw.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6))) : [JSON.parse(raw)];
      const usage = payloads.findLast((item) => item.usage)?.usage ?? {};
      calls.push({ model: body.model, status: response.status, input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0, elapsedMs: Date.now() - start });
      console.log("LIVE CALL", JSON.stringify(calls.at(-1)));
      await writeFile(join(root, "usage.json"), JSON.stringify(calls, null, 2));
      return response;
    } finally { reservedOutput -= cap; }
  }
  // Embeddings are allowed; no image/audio or web-research spending in this run.
  assert((url.hostname === "api.openai.com" && url.pathname.endsWith("/embeddings")) || (url.hostname === "generativelanguage.googleapis.com" && /:(batchEmbedContents|embedContent)$/.test(url.pathname)), `Unexpected paid service: ${url.hostname}${url.pathname}`);
  return originalFetch(request);
};

const core = await import("../packages/core/src/index.ts");
const { prisma, createSourceService } = await import("../packages/db/src/index.ts");
const { saveSourceUpload, hydrateSourceAttachments } = await import("../apps/api/src/mobile/sourceAttachments.ts");
const { processNextSource } = await import("../apps/worker/src/runtime/sourceProcessing.ts");
const { processWorkerJob } = await import("../apps/worker/src/processJob.ts");
const { queue, connection } = await import("../apps/worker/src/runtime/queue.ts");
const { createLiveFastJudgmentsTextModel } = await import("../apps/api/src/generationTextModelRouting.ts");
const { enrichCreationTurnWithSearch, deterministicCreationTurn } = await import("../apps/api/src/mobileCreation.ts");
const { loadProjectForChat } = await import("../apps/api/src/mobile/projectChat.ts");
const { generateGroundedProjectAnswer } = await import("../apps/api/src/mobile/groundedAnswer.ts");
const results: Record<string, unknown> = await readFile(join(root, "results.json"), "utf8").then(JSON.parse).catch(() => ({}));
results.passed = false;
delete results.failure;
const started = Date.now();

async function execute(type: "PLAN_BOOK" | "GENERATE_BOOK", projectId: string, extra: Record<string, unknown> = {}) {
  const payload = { projectId, ...extra };
  const row = await prisma.generationJob.create({ data: { projectId, type, payload } });
  await processWorkerJob({ id: row.id, name: type === "PLAN_BOOK" ? "plan-book" : "generate-book", data: { ...payload, generationJobId: row.id }, attemptsMade: 0, opts: { attempts: 1 } });
  const completed = await prisma.generationJob.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(completed.status, "COMPLETED", completed.error ?? type);
}

try {
  assert(await prisma.project.count() <= 1, "Only one test project is allowed");
  // Keep normal local and final QA; omit optional editorial passes for the
  // user's low-token acceptance run. This settings row exists only in test DB.
  await prisma.generationQualityRevision.upsert({ where: { version: 1 }, update: {}, create: { version: 1, settings: { planThinkingBoost: [], planCritic: [], smartUnslop: [], storyExtractAudit: [], styleAuditor: [] }, note: "Low-token live acceptance" } });
  const user = await prisma.user.upsert({ where: { email: "live-book@example.invalid" }, update: {}, create: { email: "live-book@example.invalid" } });
  const draft = await prisma.mobileCreationDraft.findFirst({ where: { userId: user.id } }) ?? await prisma.mobileCreationDraft.create({ data: { userId: user.id, payload: { payloadVersion: 3, rawIdea: "An observatory archive story", messages: [{ id: "m0", role: "user", content: "Use the uploaded archive" }] } } });
  const source = "# Qeshm Observatory story bible\nThis is a fictional setting. Mina Farahani is the archive custodian. The observatory closed in 2088. The archive passcode is CYAN-482. The inventory contains 742 glass plates. The northern lens is sealed in Vault Seven. Mina must recover the inventory before the last ferry leaves. She succeeds by opening the archive and moving the plates into sealed transport crates. The lens stays in Vault Seven.\n# Boundaries\nNo other custodian is named. The exact date of the last ferry is not given. Do not invent an official date or a different access code.\n# Ending\nMina checks all 742 plates, seals the crates, and leaves the northern lens secured in Vault Seven. The archive record is preserved.";
  const fixture = pdf80 ? eightyPageSourcePdf() : undefined;
  const filename = fixture ? "observatory-80-pages.pdf" : "observatory.txt";
  if (fixture) {
    const fixturePath = join(root, filename);
    await writeFile(fixturePath, fixture.pdf);
    assert.equal(Number(execFileSync("pdfinfo", [fixturePath], { encoding: "utf8" }).match(/^Pages:\s+(\d+)/m)?.[1]), 80);
    assert(!/^\s*\d+\s+\d+\s+image\s/m.test(execFileSync("pdfimages", ["-list", fixturePath], { encoding: "utf8" })), "Fixture must contain no image pages");
  }
  const upload = await saveSourceUpload({ userId: user.id, draftId: draft.id, root: process.env.ATTACHMENT_STORAGE_DIR!, data: fixture?.pdf ?? Buffer.from(source), filename, requestId: "live-book" });
  await processNextSource();
  const [attachment] = await hydrateSourceAttachments(user.id, [upload.attachment]);
  assert.equal(attachment!.processing?.status, "ready");
  const refs = [{ sourceId: upload.attachment.id, version: 1 }];
  const sources = createSourceService(user.id, refs);
  if (fixture) {
    const extraction = await prisma.sourceExtraction.findUniqueOrThrow({ where: { sourceId_version: refs[0]! }, include: { chunks: { orderBy: { ordinal: "asc" } } } });
    assert.equal(extraction.totalSections, 80);
    assert.equal((extraction.usage as any).ocrCalls, 0);
    assert.equal(new Set(extraction.chunks.map((chunk) => chunk.section)).size, 80);
    assert(extraction.chunks.every((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0), "Every PDF page must have a real embedding");
    for (let page = 1; page <= 80; page++) assert(extraction.fullContent.includes(`QESHM-P${String(page).padStart(3, "0")}-RECORD`), `Missing PDF page ${page}`);
    assert(extraction.fullContent.indexOf("FINAL RECORD") > 160000, "Final evidence must be beyond the old excerpt boundary");
    for (const [query, fact, page] of [["Mina custodian closure", "2088", 1], ["archive passcode inventory", "CYAN-482", 40], ["FINAL RECORD northern lens vault", "Vault Seven", 80]] as const) {
      assert((await sources.search(query)).some((passage) => passage.content.includes(fact) && passage.locator.startsWith(`Page ${page}`)), `Retrieval lost page ${page}`);
    }
    results.input = { pages: 80, bytes: fixture.pdf.length, extractedCharacters: extraction.fullContent.length, finalFactOffset: extraction.fullContent.indexOf("FINAL RECORD"), sections: extraction.totalSections, chunks: extraction.chunks.length, usage: extraction.usage };
    await writeFile(join(root, "extraction.json"), JSON.stringify({ ...results.input as object, summaries: extraction.chunks.map(({ section, summary }) => ({ section, summary })) }, null, 2));
    console.log("PASS 80-page native extraction and distant retrieval", JSON.stringify(results.input));
  }
  const model = createLiveFastJudgmentsTextModel(core.loadConfig());
  const question = "Before we plan the book, what are the archive passcode and inventory count in my uploaded file? Cite the source; answer briefly.";
  const request = { messages: [{ role: "user" as const, content: question }], attachments: [attachment!], sourceService: sources };
  const turn = results.creationMessage ? { assistantMessage: String(results.creationMessage) } : await enrichCreationTurnWithSearch({ textModel: model, research: { search: async () => { throw new Error("No web research needed"); } } }, request, deterministicCreationTurn(request));
  console.log("CREATION TURN", JSON.stringify(turn));
  assert(turn.assistantMessage?.includes("CYAN-482") && turn.assistantMessage.includes("742") && turn.assistantMessage.includes("[source:"), "Creation message must cite the exact source facts");
  results.creationMessage = turn.assistantMessage;
  console.log("PASS creation message");
  const input = core.createProjectSchema.parse({ title: "The Last Archive Ferry", category: "STORY", targetPages: 3, complexity: 2, temperature: 0.3, language: "en", prompt: `Write a complete three-page short story in one chapter about Mina recovering the Qeshm Observatory archive before the final ferry. Treat ${filename} as the authoritative story bible. Preserve its closure year, passcode, inventory count and lens location exactly. Put concise source citations with those details. Give the story a resolved ending. About 180–230 words per page. No pictures. No external research.`, mediaSettings: { modelTier: "fast", generationStrategy: "whole-book-single-pass", fullIllustrations: false, includeCover: false, coverArtSource: "none", finalReview: true, mobile: { sourceRefs: refs } } });
  const project = await prisma.project.findFirst({ where: { userId: user.id } }) ?? await prisma.project.create({ data: { userId: user.id, title: input.title!, prompt: input.prompt, category: input.category, targetPages: input.targetPages, complexity: input.complexity, temperature: input.temperature, language: input.language, mediaSettings: input.mediaSettings, status: "PLANNING" } });
  if (!project.currentPlanId) await execute("PLAN_BOOK", project.id, { inputSnapshot: input });
  const planned = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, include: { currentPlan: true } });
  assert(["PLAN_READY", "GENERATING", "COMPILING", "COMPLETE"].includes(planned.status), planned.status);
  const plan = core.bookPlanSchema.parse(planned.currentPlan!.planningPackage);
  assert.equal(plan.chapters.reduce((sum, chapter) => sum + chapter.targetPages, 0), 3);
  assert(JSON.stringify(plan).includes("Mina"), "Plan must use source character");
  for (const fact of ["2088", "CYAN-482", "742", "Vault Seven"]) assert(JSON.stringify(plan).includes(fact), `Plan lost ${fact}`);
  assert.deepEqual((planned.currentPlan!.inputSnapshot as any).mediaSettings.mobile.sourceRefs, refs);
  assert.equal(await prisma.projectSource.count({ where: { projectId: project.id } }), 1);
  await writeFile(join(root, "plan.json"), JSON.stringify(plan, null, 2));
  results.plan = { id: planned.currentPlan!.id, chapters: plan.chapters.length, pages: 3 };
  console.log("PASS persisted live plan");
  if (!await prisma.generationJob.count({ where: { projectId: project.id, type: "GENERATE_BOOK", status: "COMPLETED" } })) await execute("GENERATE_BOOK", project.id, { planId: planned.currentPlan!.id });
  // Deliver real worker-created follow-ups against the isolated DB/Redis.
  for (let count = 0; count < 8; count++) {
    const jobs = await prisma.generationJob.findMany({ where: { projectId: project.id, status: "QUEUED", type: "COMPILE_EXPORT" }, orderBy: { createdAt: "asc" } });
    if (!jobs.length) break;
    for (const job of jobs) {
      assert.equal(job.type, "COMPILE_EXPORT", "This text-only test should enqueue only export");
      const delivery = await queue.getJob(job.bullJobId!);
      assert(delivery, "Worker follow-up must reach Redis");
      await processWorkerJob(delivery);
    }
  }
  const finished = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, include: { pages: { orderBy: { index: "asc" } }, jobs: true } });
  assert.equal(finished.pages.length, 3, "Exactly three generated pages");
  assert(finished.pages.every((page) => page.status === "COMPLETED" && page.markdown.split(/\s+/).length >= 100), "All pages must contain reviewed prose");
  assert(finished.jobs.filter((job) => ["PLAN_BOOK", "GENERATE_BOOK", "COMPILE_EXPORT"].includes(job.type)).every((job) => job.status === "COMPLETED"), "All book worker jobs must finish");
  const text = finished.pages.map((page) => page.markdown).join("\n\n");
  for (const fact of ["2088", "CYAN-482", "742", "Vault Seven"]) assert(text.includes(fact), `Book lost ${fact}`);
  assert(!text.includes("[unverified source]"));
  const markers = [...text.matchAll(/\[source:([^:]+):(\d+):(\d+)\]/g)];
  assert(markers.length > 0, "Book must retain source evidence");
  for (const marker of markers) assert(await sources.read(marker[1]!, Number(marker[2]), Number(marker[3])), "Book citation must resolve");
  const pdf = join(root, "books", project.id, "book.pdf");
  const info = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
  const pdfPages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  assert(pdfPages > 0 && pdfPages <= 15, "Export must stay below user's 15-page ceiling");
  const pdfText = execFileSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
  for (const fact of ["2088", "CYAN-482", "742"]) assert(pdfText.includes(fact), `PDF lost ${fact}`);
  await writeFile(join(root, "manuscript.md"), text);
  results.book = { projectId: project.id, status: finished.status, generatedPages: finished.pages.length, pdfPages, pdf, citations: markers.length, jobs: finished.jobs.map(({ type, status }) => ({ type, status })) };
  console.log("PASS live book and PDF", JSON.stringify(results.book));
  const chatProject = await loadProjectForChat(user.id, project.id);
  assert(chatProject);
  const answer = await generateGroundedProjectAnswer(chatProject, "What was the archive passcode, how many glass plates were there, and where was the lens left? Cite my uploaded source.", "FAILED LIVE ANSWER", model, undefined, [], sources);
  console.log("BOOK ANSWER", answer);
  for (const fact of ["CYAN-482", "742", "Vault Seven"]) assert(answer.includes(fact), `Book chat lost ${fact}`);
  assert(answer.includes("[source:") && !answer.includes("[unverified source]"));
  const missing = await generateGroundedProjectAnswer(chatProject, "What exact calendar date did the last ferry depart? If the uploaded archive does not give it, say so. Answer briefly.", "FAILED LIVE ANSWER", model, undefined, [], sources);
  console.log("MISSING EVIDENCE ANSWER", missing);
  results.bookMessages = { answer, missing };
  assert(/not (give|specif|state|provid|mention)|no exact|doesn.t (give|specif|state|provid|mention)|isn.t (given|specified)/i.test(missing), "Book chat must acknowledge missing evidence");
  assert(!/at dusk/i.test(missing) || /(?:book|manuscript|story).{0,50}(?:dusk|time)|(?:dusk|time).{0,50}(?:book|manuscript)/i.test(missing), "Do not attribute the manuscript's invented departure time to the upload");
  results.bookMessages = { answer, missing };
  results.passed = true;
  results.invocationElapsedMs = Date.now() - started;
  results.usage = { calls: calls.length, inputTokens: calls.reduce((sum, call) => sum + call.input, 0), outputTokens: calls.reduce((sum, call) => sum + call.output, 0) };
  console.log("PASS", JSON.stringify(results, null, 2));
} catch (error) {
  results.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  results.usage = { calls: calls.length, inputTokens: calls.reduce((sum, call) => sum + call.input, 0), outputTokens: calls.reduce((sum, call) => sum + call.output, 0) };
  await writeFile(join(root, "results.json"), JSON.stringify(results, null, 2));
  const { closeSharedBrowser } = await import("../packages/core/src/generation/browserPool.js");
  await closeSharedBrowser();
  await queue.close();
  await connection.quit();
  await prisma.$disconnect();
  globalThis.fetch = originalFetch;
}
