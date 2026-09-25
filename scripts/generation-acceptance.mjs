import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { summarizeGenerationPerformance } from "./generation-performance.mjs";

const requireCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
export const EXPORT_FORMATS = ["pdf", "epub", "docx"];
const OPEN = new Set(["QUEUED", "ACTIVE"]);
const FAILURES = new Set(["FAILED", "CANCELED"]);
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function expectedStoryIllustrationIndexes(cadence, targetPages) {
  if (!["every-page", "every-third-page"].includes(cadence)) throw new Error(`Unsupported acceptance illustration cadence: ${cadence}`);
  if (!Number.isSafeInteger(targetPages) || targetPages < 1) throw new Error("Expected a positive story-page target");
  return Array.from({ length: targetPages }, (_, index) => index + 1).filter((index) => cadence === "every-page" || index % 3 === 0);
}

/** A changed illustration requirement is an explicit new input, never a matched baseline. */
export function prepareStorybookIllustrations(source, option = "baseline") {
  if (!["baseline", "every-page", "every-third-page"].includes(option)) throw new Error(`Unknown --illustration-cadence ${option}`);
  const input = structuredClone(source);
  const originalCadence = input.mediaSettings?.illustrationCadence;
  if (option === "baseline" && !["template-driven", "every-page", "every-third-page", undefined].includes(originalCadence)) throw new Error("Baseline cadence is unsupported for automatic storybook acceptance");
  const cadence = option === "baseline" ? originalCadence === "every-third-page" ? "every-third-page" : "every-page" : option;
  const expectedPageIndexes = expectedStoryIllustrationIndexes(cadence, input.targetPages);
  if (option !== "baseline") input.mediaSettings = { ...input.mediaSettings, fullIllustrations: true, illustrationCadence: cadence };
  if (option === "every-third-page") {
    input.prompt = input.prompt.replace("Make each page a distinct visual scene", "Make each page a distinct story scene") +
      ` Exactly ${expectedPageIndexes.length} interior illustrations, on story pages ${expectedPageIndexes.join(", ")}. The other ${input.targetPages - expectedPageIndexes.length} story pages contain text without illustrations. Covers and saved character portraits are separate.`;
  }
  return { input, policy: { option, cadence, expectedPageIndexes, baselinePrompt: source.prompt, preparedPrompt: input.prompt,
    baselineInputHash: sha256(JSON.stringify(source)), changedFromBaseline: JSON.stringify(source) !== JSON.stringify(input) } };
}

/** Cover/reference assets never fill a story illustration slot. Reject duplicates and extras. */
export function verifyStoryIllustrations(pages, images, expectedPageIndexes) {
  const expected = new Set(expectedPageIndexes);
  const pageById = new Map(pages.map((page) => [page.id, page.index]));
  if (expected.size !== expectedPageIndexes.length || expectedPageIndexes.some((index) => !pages.some((page) => page.index === index))) throw new Error("Configured illustration indexes do not name unique story pages");
  const scenes = images.filter((image) => image.type === "SCENE_ILLUSTRATION");
  const actualPageIndexes = scenes.map((image) => pageById.get(image.pageId)).sort((a, b) => (a ?? 0) - (b ?? 0));
  if (scenes.length !== expected.size || actualPageIndexes.some((index) => !expected.has(index)) || new Set(actualPageIndexes).size !== expected.size) {
    throw new Error(`Expected exactly ${expected.size} story illustrations on pages ${[...expected].join(", ")}; found ${scenes.length} on ${actualPageIndexes.map((index) => index ?? "unknown page").join(", ")}`);
  }
  return { expectedPageIndexes, actualPageIndexes, sceneAssets: scenes.length, textOnlyStoryPages: pages.length - expected.size,
    characterReferenceAssets: images.filter((image) => image.type === "CHARACTER_REFERENCE").length,
    coverAssets: images.filter((image) => image.type === "COVER").length };
}

/** Jobs must be supplied oldest first. A completed handoff is not publication. */
export function classifyGenerationCompletion(project, jobs) {
  if (!project) return { state: "failed", reason: "Project was not found" };
  const relevant = jobs.filter((job) => ["PLAN_BOOK", "GENERATE_BOOK", "GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT"].includes(job.type));
  if (relevant.some((job) => OPEN.has(job.status))) return { state: "pending" };
  const compile = relevant.findLast((job) => job.type === "COMPILE_EXPORT");
  const book = relevant.findLast((job) => job.type === "GENERATE_BOOK");
  const plan = relevant.findLast((job) => job.type === "PLAN_BOOK");
  const failed = [compile, book, plan].find((job) => job && FAILURES.has(job.status));
  if (project.status === "FAILED" || failed) {
    return { state: "failed", reason: failed ? `${failed.type} ${failed.status}` : "Project failed" };
  }
  if (compile?.status === "COMPLETED" && ["COMPLETE", "REVIEW_REQUIRED"].includes(project.status)) {
    return { state: "published", reviewRecommended: project.status === "REVIEW_REQUIRED" || compile.qualityReport?.state === "review_recommended" };
  }
  return { state: "pending" };
}

export function verifyStoryPages(pages, expected, qualityReport) {
  if (pages.length !== expected) throw new Error(`Expected ${expected} story pages; found ${pages.length}`);
  const ordered = [...pages].sort((a, b) => a.index - b.index);
  for (const [offset, page] of ordered.entries()) {
    const flagged = page.status === "FAILED_QA" && qualityReport?.state === "review_recommended" && qualityReport.issues?.length > 0;
    if (page.index !== offset + 1 || (!flagged && !["COMPLETED", "REVIEW_REQUIRED"].includes(page.status)) || !page.markdown?.trim()) {
      throw new Error(`Story page ${offset + 1} is missing, unfinished, or empty`);
    }
  }
}

/** An explicit storybook sheet contract is stronger than merely having 30 anchors. */
export function verifyPdfStoryLayout(ranges, physicalPages, policy) {
  if (policy?.mode !== "one-physical-page-per-story" || !Number.isSafeInteger(policy.expectedStoryPages) || policy.expectedStoryPages < 1) throw new Error("Invalid PDF story-page layout policy");
  if (!Number.isSafeInteger(physicalPages) || physicalPages < 1) throw new Error("Invalid physical PDF page count");
  if (!Array.isArray(ranges) || ranges.length !== policy.expectedStoryPages) throw new Error(`Expected ${policy.expectedStoryPages} measured story ranges`);
  const ordered = [...ranges].sort((a, b) => a.index - b.index);
  const storyPhysicalPages = [];
  for (const [offset, range] of ordered.entries()) {
    if (range.index !== offset + 1 || !Number.isSafeInteger(range.startPdfPage) || range.startPdfPage < 1 || range.endPdfPage > physicalPages || range.startPdfPage !== range.endPdfPage) throw new Error(`Story page ${offset + 1} must occupy a single physical page`);
    if (range.startPdfPage <= (storyPhysicalPages.at(-1) ?? 0)) throw new Error(`Story page ${offset + 1} must occupy a distinct physical page in reading order`);
    storyPhysicalPages.push(range.startPdfPage);
  }
  const nonStoryPhysicalPages = Array.from({ length: physicalPages }, (_, i) => i + 1).filter((index) => !storyPhysicalPages.includes(index));
  return { mode: policy.mode, storySheets: storyPhysicalPages.length, storyPhysicalPages, nonStoryPhysicalPages,
    frontMatterPhysicalPages: nonStoryPhysicalPages.filter((index) => index < storyPhysicalPages[0]),
    backMatterPhysicalPages: nonStoryPhysicalPages.filter((index) => index > storyPhysicalPages.at(-1)) };
}

function readableXmlText(node) {
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(readableXmlText).join(" ");
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === "_text" || key === "_cdata") return typeof value === "string" ? [value] : [];
    if (key.startsWith("_") || ["head", "script", "style"].includes(key.split(":").at(-1))) return [];
    return [readableXmlText(value)];
  }).join(" ").trim();
}

export async function verifyArchive(format, bytes) {
  const JSZip = requireCore("jszip");
  const { xml2js } = requireCore("xml-js");
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const xml = async (name) => {
    const entry = zip.file(name);
    if (!entry) throw new Error(`${format} is missing ${name}`);
    const raw = await entry.async("string");
    return xml2js(raw, { compact: true });
  };
  if (format === "docx") {
    await xml("[Content_Types].xml");
    await xml("_rels/.rels");
    const document = await xml("word/document.xml");
    if (!document["w:document"]?.["w:body"]) throw new Error("DOCX has no document body");
    if (!readableXmlText(document["w:document"]["w:body"])) throw new Error("DOCX has no readable document text");
  } else {
    if (await zip.file("mimetype")?.async("string") !== "application/epub+zip") throw new Error("Invalid EPUB mimetype");
    const container = await xml("META-INF/container.xml");
    const roots = container.container?.rootfiles?.rootfile;
    const root = (Array.isArray(roots) ? roots[0] : roots)?._attributes?.["full-path"];
    if (typeof root !== "string") throw new Error("EPUB has no package root");
    const pkg = (await xml(root)).package;
    if (!pkg?.spine?.itemref || !pkg?.manifest?.item) throw new Error("EPUB has no reading order");
    const items = [pkg.manifest.item].flat();
    const refs = [pkg.spine.itemref].flat();
    let hasReadableContent = false;
    for (const ref of refs) {
      const item = items.find((candidate) => candidate._attributes?.id === ref._attributes?.idref);
      const href = item?._attributes?.href;
      if (typeof href !== "string") throw new Error("EPUB spine names an absent manifest entry");
      const name = new URL(href, `https://archive.invalid/${root}`).pathname.slice(1);
      if (readableXmlText(await xml(decodeURIComponent(name)))) hasReadableContent = true;
    }
    if (!hasReadableContent) throw new Error("EPUB has no readable reading-order text");
  }
  return { entries: Object.keys(zip.files).length };
}

/** Downloads exact published keys; never rerenders or repairs to make a test pass. */
export async function capturePublishedArtifacts({ project, pages, qualityReport, getObject, outputDir, expectedIllustrationPageIndexes, pdfLayoutPolicy, pdfInfo = defaultPdfInfo }) {
  verifyStoryPages(pages, project.targetPages, qualityReport);
  mkdirSync(outputDir, { recursive: true });
  const artifacts = [];
  for (const format of EXPORT_FORMATS) {
    const key = `books/${project.id}/book.${format}`;
    const bytes = await getObject(key);
    if (!bytes?.length) throw new Error(`Published ${format.toUpperCase()} is missing`);
    const path = join(outputDir, `book.${format}`);
    writeFileSync(path, bytes);
    const raw = await getObject(`${key}.provenance.json`);
    const provenance = raw ? JSON.parse(raw.toString("utf8")) : null;
    const digest = sha256(bytes);
    if (!provenance || provenance.digest !== digest || provenance.byteSize !== bytes.length || provenance.revision !== project.contentRevision) {
      throw new Error(`${format.toUpperCase()} provenance does not match the downloaded bytes and current revision`);
    }
    let structure;
    if (format === "pdf") {
      if (!bytes.subarray(0, 8).toString().startsWith("%PDF-")) throw new Error("Invalid PDF header");
      const info = pdfInfo(path);
      const physicalPages = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1]);
      const map = project.pdfPageMap;
      if (!Number.isInteger(physicalPages) || physicalPages < 1) throw new Error("PDF page count could not be read");
      if (map?.totalPdfPages !== physicalPages || map?.pdfDigest !== digest || map?.contentRevision !== project.contentRevision) {
        throw new Error("PDF page map is not for these published bytes");
      }
      if (!Array.isArray(map.pages) || map.pages.length !== pages.length || !pages.every((page) => map.pages.some((range) => range.index === page.index && range.startPdfPage >= 1 && range.endPdfPage <= physicalPages && range.startPdfPage <= range.endPdfPage))) {
        throw new Error("PDF does not map every story page to a valid physical page range");
      }
      structure = { physicalPages, storyPages: pages.length, hasCoverPage: map.hasCoverPage,
        ...(pdfLayoutPolicy ? { storyPageLayout: verifyPdfStoryLayout(map.pages, physicalPages, pdfLayoutPolicy) } : {}),
        ...(expectedIllustrationPageIndexes ? {
          mappedIllustratedStoryPageIndexes: pages.filter((page) => expectedIllustrationPageIndexes.includes(page.index)).map((page) => page.index),
          mappedTextOnlyStoryPageIndexes: pages.filter((page) => !expectedIllustrationPageIndexes.includes(page.index)).map((page) => page.index)
        } : {}) };
    } else structure = await verifyArchive(format, bytes);
    artifacts.push({ format, key, path, byteSize: bytes.length, digest, revision: provenance.revision, ...structure });
    writeFileSync(`${path}.provenance.json`, JSON.stringify(provenance, null, 2));
  }
  return artifacts;
}

function defaultPdfInfo(path) {
  return execFileSync("pdfinfo", [path], { encoding: "utf8", timeout: 30_000 });
}

export function summarizeAcceptance({ project, pages, jobs, images, calls, characters, artifacts, startedAt, events = [], tier, maxElapsedMs,
  expectedIllustrationPageIndexes = Array.from({ length: 30 }, (_, index) => index + 1), illustrationCadence = "legacy-every-page", pdfLayoutPolicy }) {
  const issues = [];
  const compileJobs = jobs.filter((job) => job.type === "COMPILE_EXPORT");
  const last = compileJobs.at(-1);
  const completion = classifyGenerationCompletion(project, jobs);
  if (completion.state !== "published") issues.push(completion.reason ?? "Publication has not finished");
  try { verifyStoryPages(pages, 30, last?.qualityReport); } catch (error) { issues.push(error.message); }
  const failed = jobs.filter((job) => FAILURES.has(job.status));
  if (failed.length) issues.push(`${failed.length} failed or canceled jobs; this run required recovery`);
  if (jobs.filter((job) => job.type === "PLAN_BOOK").length !== 1 || jobs.filter((job) => job.type === "GENERATE_BOOK").length !== 1) issues.push("Generation was restarted; run is not an unattended acceptance sample");
  for (const character of characters) {
    if (!images.some((image) => image.type === "CHARACTER_REFERENCE" && image.metadata?.libraryCharacterId === character.id && image.metadata.seededFromPortrait === true)) issues.push(`${character.name} was not seeded from the saved portrait`);
  }
  if (images.filter((image) => image.type === "CHARACTER_REFERENCE").length !== characters.length) issues.push(`Expected exactly ${characters.length} saved character-reference assets`);
  let illustrationInventory = null;
  try { illustrationInventory = verifyStoryIllustrations(pages, images, expectedIllustrationPageIndexes); }
  catch (error) { issues.push(error.message); }
  const operations = compileJobs.filter((job) => job.payload?.finalization);
  if (operations.length !== 1) issues.push(`Expected one durable finalization operation; found ${operations.length}`);
  const qaJobs = new Set(calls.filter((call) => ["final-book-qa", "book.final_qa.chapter_transitions"].includes(call.purpose)).map((call) => call.generationJobId));
  if (qaJobs.size > 1) issues.push("Text QA ran in more than one compile job; inspect handoff checkpoints");
  if (artifacts.length !== EXPORT_FORMATS.length) issues.push("Not all downloads passed integrity checks");
  if (pdfLayoutPolicy && !artifacts.some((artifact) => artifact.format === "pdf" && artifact.storyPageLayout?.mode === pdfLayoutPolicy.mode && artifact.storyPageLayout.storySheets === pdfLayoutPolicy.expectedStoryPages)) issues.push("PDF did not pass the explicit physical story-page layout contract");
  const finishedAt = last?.finishedAt ?? null;
  const elapsedMs = finishedAt && startedAt ? new Date(finishedAt).getTime() - new Date(startedAt).getTime() : null;
  const performance = summarizeGenerationPerformance({ jobs, calls, events, elapsedMs, maxElapsedMs, tier });
  return {
    passed: issues.length === 0 && performance.passed === true, functionalPassed: issues.length === 0,
    issues, performance, completion, projectId: project?.id ?? null,
    startedAt, finishedAt, elapsedMs,
    storyPages: pages.length, illustrationCadence, expectedIllustrationPageIndexes, illustrationInventory, pdfLayoutPolicy: pdfLayoutPolicy ?? null,
    artifacts, review: last?.qualityReport ?? null,
    providerCalls: calls.length, imageCalls: calls.filter((call) => call.purpose === "image.generate").length,
    knownCostHint: calls.reduce((sum, call) => sum + (call.costHint ?? 0), 0),
    callsWithoutCostHint: calls.filter((call) => call.costHint == null).length,
    compilePasses: compileJobs.length, qaCompileJobs: [...qaJobs],
    manualRecoveryAllowed: false,
    humanReview: { state: "pending", checks: ["character likeness", "chapter transitions", "both character arcs", "rendered layouts"] }
  };
}
