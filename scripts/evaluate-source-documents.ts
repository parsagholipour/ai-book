/** Offline integration evaluation. Requires an isolated database with this schema. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (!process.env.DATABASE_URL?.includes("codex_sources_test")) throw new Error("Use an isolated codex_sources_test database for this evaluation.");
process.env.MOCK_AI = "true";
process.env.FULL_DOCUMENT_SOURCES = "true";
const root = await mkdtemp(join(tmpdir(), "source-evaluation-"));
process.env.ATTACHMENT_STORAGE_DIR = root;
const { prisma, createSourceService } = await import("../packages/db/src/index.ts");
const { saveSourceUpload, hydrateSourceAttachments, retrySourceUpload } = await import("../apps/api/src/mobile/sourceAttachments.ts");
const { processNextSource } = await import("../apps/worker/src/runtime/sourceProcessing.ts");
const { mobileCreationDraftPayloadSchema, deterministicCreationTurn, enrichCreationTurnWithSearch } = await import("../apps/api/src/mobileCreation.ts");
const { FakeTextModelAdapter, SourceAwareTextModel, createSourceTools, sourceCitation } = await import("../packages/core/src/index.ts");
const { sourceFixturePdf } = await import("../packages/core/src/sources/testing/pdfFixture.ts");
const checks: string[] = [];
const started = Date.now();
try {
  await prisma.user.create({ data: { id: "source-eval-owner", email: "source-eval-owner@example.invalid" } });
  await prisma.mobileCreationDraft.create({ data: { id: "source-eval-draft", userId: "source-eval-owner", payload: mobileCreationDraftPayloadSchema.parse({ payloadVersion: 3, rawIdea: "A history of the observatory", messages: [{ id: "m0", role: "user", content: "Use my archive" }] }) } });
  const content = "Earlier chronological background.\n".repeat(5000) + "\nFINAL SECTION\nThe observatory closed in 2047. Its archive access code was ORCHID-913.";
  const upload = { userId: "source-eval-owner", draftId: "source-eval-draft", root, data: Buffer.from(content), filename: "archive.txt", requestId: "same-upload" };
  const first = await saveSourceUpload(upload);
  const duplicate = await saveSourceUpload({ ...upload, expectedRevision: 1 });
  assert.equal(first.attachment.id, duplicate.attachment.id);
  assert.equal(first.revision, duplicate.revision);
  assert.equal(await prisma.sourceDocument.count(), 1);
  await assert.rejects(saveSourceUpload({ ...upload, data: Buffer.from("different bytes") }), /another file/);
  checks.push("Duplicate/replayed upload and conflicting payload");
  // Simulate a dead worker with an expired lease. The durable row is picked up.
  await prisma.sourceExtraction.update({ where: { sourceId_version: { sourceId: first.attachment.id, version: 1 } }, data: { status: "extracting", leaseToken: "dead-worker", leaseExpiresAt: new Date(0) } });
  assert.equal(await processNextSource(), true);
  const [ready] = await hydrateSourceAttachments(upload.userId, [first.attachment]);
  assert.equal(ready?.processing?.status, "ready");
  assert.equal((await prisma.mobileCreationDraft.findUniqueOrThrow({ where: { id: upload.draftId } })).revision, first.revision);
  checks.push("Expired worker lease recovery without changing chat revision");
  const refs = [{ sourceId: first.attachment.id, version: 1 }];
  const sources = createSourceService(upload.userId, refs, { embed: async () => { throw new Error("offline"); } });
  const passages = await sources.search("observatory archive access code");
  const ending = passages.find((passage) => passage.content.includes("ORCHID-913"));
  assert(ending);
  assert((await sources.overview())[0]!.sections.at(-1)!.summary.includes("ORCHID-913"));
  assert.equal((await createSourceService("foreign-account", refs).search("archive")).length, 0);
  assert.equal(await createSourceService("foreign-account", refs).read(first.attachment.id, 1, ending.ordinal), null);
  checks.push("Deep final-section retrieval, complete overview, embedding outage, cross-account isolation");
  const citation = sourceCitation(ending);
  const chatModel = new FakeTextModelAdapter(undefined, [
    { toolCalls: [{ name: "search_sources", arguments: { query: "observatory archive access code" } }] },
    { toolCalls: [{ name: "finish_turn", arguments: { assistantMessage: `The archive code is ORCHID-913. ${citation}`, question: null } }] }
  ]);
  const request = { messages: [{ role: "user" as const, content: "What was the archive code?" }], attachments: [ready!], sourceService: sources };
  const turn = await enrichCreationTurnWithSearch({ textModel: chatModel, research: { search: async () => { throw new Error("No web search expected"); } } }, request, deterministicCreationTurn(request));
  assert(turn.assistantMessage?.includes(citation));
  checks.push("Creation answer with a validated deep-source citation");
  class EvidenceWriter extends FakeTextModelAdapter {
    override async generateText(options: Parameters<FakeTextModelAdapter["generateText"]>[0]) {
      const material = options.messages.at(-1)!.content;
      assert(material.includes("ORCHID-913"));
      assert(material.includes(citation));
      return { text: `The archive opened with ORCHID-913. ${citation}`, model: "fixture-writer", provider: "fixture" };
    }
  }
  const chapter = await new SourceAwareTextModel(new EvidenceWriter(), async () => sources).generateText({ purpose: "compose-chapter", messages: [{ role: "user", content: "Write the observatory archive chapter" }] });
  assert(chapter.text.includes(citation));
  const { classifyProjectChatMessage } = await import("../apps/api/src/bookEditIntent.ts");
  const answer = await classifyProjectChatMessage({ message: "What was the archive access code in my uploaded file?", stage: "complete", pages: [], sourceService: sources,
    textModel: new FakeTextModelAdapter(undefined, [
      { toolCalls: [{ name: "search_sources", arguments: { query: "observatory archive access code" } }] },
      { toolCalls: [{ name: "decide", arguments: { action: "answer", confidence: 1, reasoning: "Source passage supports the answer", assistantMessage: `ORCHID-913. ${citation}` } }] }
    ]) });
  assert(answer.assistantMessage.includes(citation));
  checks.push("Fixture chapter and later book-chat answer use the same cited deep fact");
  const ledger = createSourceTools(sources);
  assert.equal(ledger.validate(citation), "[unverified source]");
  await ledger.tools[0]!.execute({ query: "archive access code" });
  assert.equal(ledger.validate(citation), citation);
  checks.push("Citation correctness validated against returned passages");
  // A summary-stage crash retries without the original or another extraction.
  await prisma.sourceExtraction.update({ where: { sourceId_version: refs[0]! }, data: { status: "partial", extractionComplete: true, error: "Summary interrupted" } });
  await rm(join(root, upload.draftId, first.attachment.id));
  await retrySourceUpload(upload.userId, upload.draftId, first.attachment.id, "retry-1");
  await retrySourceUpload(upload.userId, upload.draftId, first.attachment.id, "retry-1");
  assert.equal(await prisma.sourceExtraction.count(), 2);
  assert.equal(await processNextSource(), true);
  const retried = await prisma.sourceExtraction.findUniqueOrThrow({ where: { sourceId_version: { ...refs[0]!, version: 2 } } });
  assert.equal(retried.status, "ready");
  assert.equal((await sources.read(first.attachment.id, 1, ending.ordinal))!.content, ending.content);
  checks.push("Idempotent retry uses extraction checkpoint; frozen passage survives original expiry");
  const native = await saveSourceUpload({ ...upload, requestId: "native-pdf", filename: "native.pdf", data: sourceFixturePdf([{ text: "The terminal archive code is BLUE-774 and the closing year is 2061." }]) });
  await processNextSource();
  const nativeJob = await prisma.sourceExtraction.findUniqueOrThrow({ where: { sourceId_version: { sourceId: native.attachment.id, version: 1 } } });
  assert.equal(nativeJob.status, "ready");
  assert(nativeJob.fullContent.includes("BLUE-774"));
  assert.equal((nativeJob.usage as { ocrCalls: number }).ocrCalls, 0);
  checks.push("Native PDF processing avoids OCR");
  const project = await prisma.project.create({ data: { userId: upload.userId, title: "Source evaluation", prompt: "History of the observatory", category: "HISTORY", targetPages: 1, complexity: 1, temperature: 0.3, mediaSettings: { mobile: { attachments: [first.attachment] } } } });
  const plan = await prisma.planVersion.create({ data: { projectId: project.id, version: 1, planningPackage: {}, messages: [] } });
  const { backfillLegacyPlanSources } = await import("../apps/worker/src/runtime/sourceLegacyPlans.ts");
  // Restore the legacy version's readable status before upgrading its snapshot.
  await prisma.sourceExtraction.update({ where: { sourceId_version: refs[0]! }, data: { status: "ready" } });
  await backfillLegacyPlanSources();
  const snapshot = (await prisma.planVersion.findUniqueOrThrow({ where: { id: plan.id } })).inputSnapshot as { mediaSettings: { mobile: { sourceRefs: unknown[] } } };
  assert.deepEqual(snapshot.mediaSettings.mobile.sourceRefs, refs);
  await prisma.mobileCreationDraft.delete({ where: { id: upload.draftId } });
  assert.equal((await sources.read(first.attachment.id, 1, ending.ordinal))!.content, ending.content);
  checks.push("Legacy plan snapshot upgrade and retained citation after draft deletion");
  console.log(JSON.stringify({ mode: "offline fixture models; no live accuracy claims", checks, passed: checks.length, elapsedMs: Date.now() - started, sourceUsage: retried.usage, nativePdfUsage: nativeJob.usage }, null, 2));
} finally {
  await prisma.$disconnect();
  await rm(root, { recursive: true, force: true });
}
