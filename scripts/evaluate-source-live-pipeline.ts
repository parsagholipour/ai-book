/** Real-provider, image-only PDF acceptance test. Uses only synthetic fixture data. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DATABASE_URL?.includes("codex_sources_test")) throw new Error("Use an isolated codex_sources_test database.");
process.env.MOCK_AI = "false";
process.env.FULL_DOCUMENT_SOURCES = "true";
const storage = await mkdtemp(join(tmpdir(), "source-live-pipeline-"));
process.env.ATTACHMENT_STORAGE_DIR = storage;

const { prisma, createSourceService } = await import("../packages/db/src/index.ts");
const { saveSourceUpload } = await import("../apps/api/src/mobile/sourceAttachments.ts");
const { processNextSource } = await import("../apps/worker/src/runtime/sourceProcessing.ts");
const { createLiveFastJudgmentsTextModel } = await import("../apps/api/src/generationTextModelRouting.ts");
const { createSourceTools, loadConfig, runToolLoop, SOURCE_INSTRUCTIONS } = await import("../packages/core/src/index.ts");

async function main() {
const started = Date.now();
try {
  const width = 1240, height = 1754;
  const pdf = imagePdf(scanBitmap(width, height), width, height);

  await prisma.user.create({ data: { id: "source-live-owner", email: "source-live-owner@example.invalid" } });
  await prisma.mobileCreationDraft.create({ data: { id: "source-live-draft", userId: "source-live-owner", payload: { payloadVersion: 3, rawIdea: "Qeshm Observatory archive", messages: [{ id: "m1", role: "user", content: "Use the scan" }] } } });
  const upload = await saveSourceUpload({ userId: "source-live-owner", draftId: "source-live-draft", root: storage, data: pdf, filename: "qeshm-scan.pdf", requestId: "live-scan" });
  assert.equal(await processNextSource(), true);
  const extraction = await prisma.sourceExtraction.findUniqueOrThrow({ where: { sourceId_version: { sourceId: upload.attachment.id, version: 1 } }, include: { chunks: true } });
  assert.equal(extraction.status, "ready", extraction.error ?? "Image-only PDF should become ready");
  for (const fact of ["QESHM OBSERVATORY", "2088", "CYAN-482", "MINA FARAHANI", "GLASS PLATES", "742", "VAULT SEVEN"]) assert(extraction.fullContent.toUpperCase().includes(fact), `OCR omitted ${fact}`);
  const usage = extraction.usage as { ocrCalls?: number; summaryCalls?: number; embeddingCalls?: number; inputTokens?: number; outputTokens?: number; elapsedMs?: number };
  assert.equal(usage.ocrCalls, 1);
  assert((usage.inputTokens ?? 0) > 0, "Real OCR/summary calls should report input tokens");
  assert((usage.outputTokens ?? 0) > 0, "Real OCR/summary calls should report output tokens");
  assert((usage.summaryCalls ?? 0) > 0);
  assert((usage.embeddingCalls ?? 0) > 0);

  const service = createSourceService("source-live-owner", [{ sourceId: upload.attachment.id, version: 1 }]);
  const ledger = createSourceTools(service);
  const answerStarted = Date.now();
  const answer = await runToolLoop({
    textModel: createLiveFastJudgmentsTextModel(loadConfig()), purpose: "creation-chat", temperature: 0, maxTokens: 700,
    maxModelCalls: 4, finishOnLastCall: true, maxToolResultChars: 1_000_000, tools: ledger.tools,
    messages: [{ role: "system", content: SOURCE_INSTRUCTIONS }, { role: "user", content: "From the scanned source, give the closure year, archive passcode, custodian, inventory count, and final lens location. Cite the evidence." }]
  });
  const validated = ledger.validate(answer.finalText);
  for (const fact of ["2088", "CYAN-482", "MINA FARAHANI", "742", "VAULT SEVEN"]) assert(validated.toUpperCase().includes(fact), `Answer omitted ${fact}`);
  assert(validated.includes(`[source:${upload.attachment.id}:1:`), "Answer omitted a returned passage citation");
  assert(!validated.includes("[unverified source]"), "Answer contained an invalid citation");
  const cited = ledger.passages().find((passage) => validated.includes(`[source:${passage.sourceId}:${passage.version}:${passage.ordinal}]`));
  assert(cited && ["2088", "CYAN-482", "MINA FARAHANI", "742", "VAULT SEVEN"].every((fact) => cited.content.toUpperCase().includes(fact)), "Cited passage does not support every requested fact");

  console.log(JSON.stringify({
    mode: "local PaddleOCR-VL + live summaries/embeddings + live cited answer; synthetic image-only PDF",
    passed: true,
    processingElapsedMs: usage.elapsedMs,
    answerElapsedMs: Date.now() - answerStarted,
    totalElapsedMs: Date.now() - started,
    providerUsage: usage,
    answerUsage: answer.usage,
    answerModel: answer.model,
    answerProvider: answer.provider,
    extracted: extraction.fullContent,
    answer: validated
  }, null, 2));
} finally {
  await prisma.$disconnect();
  await rm(storage, { recursive: true, force: true });
}
}

function imagePdf(image: Buffer, width: number, height: number): Buffer {
  const content = Buffer.from("q 595 0 0 842 0 0 cm /Im1 Do Q\n");
  const bodies = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Length ${image.length} >>\nstream\n`), image, Buffer.from("\nendstream")]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("endstream")])
  ];
  const chunks = [Buffer.from("%PDF-1.4\n%\xff\xff\xff\xff\n", "latin1")];
  const offsets = [0];
  for (const [index, body] of bodies.entries()) { offsets.push(Buffer.concat(chunks).length); chunks.push(Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")); }
  const xref = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  return Buffer.concat(chunks);
}

function scanBitmap(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(width / 8 * height, 0xff);
  const lines = ["ARCHIVE SCAN", "FINAL RECOVERY LOG", "STATION QESHM OBSERVATORY", "CLOSURE YEAR 2088", "ARCHIVE PASSCODE CYAN-482", "CUSTODIAN MINA FARAHANI", "INVENTORY TABLE", "ITEM COUNT", "GLASS PLATES 742", "FINAL NOTE NORTHERN LENS", "SEALED IN VAULT SEVEN"];
  const scale = 6;
  for (const [line, text] of lines.entries()) for (const [index, character] of [...text].entries()) {
    const glyph = FONT[character] ?? FONT[" "]!;
    for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) if (glyph[row]![column] === "1") {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const x = 55 + index * scale * 6 + column * scale + dx;
        const y = 90 + line * 120 + row * scale + dy;
        bytes[y * (width / 8) + Math.floor(x / 8)]! &= ~(1 << (7 - x % 8));
      }
    }
  }
  return bytes;
}

const FONT: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"]
};

await main();
