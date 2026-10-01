import { exportContentDigest, exportProvenanceKey, publishedExportFilename } from "@book-maker/core";
import { objectKey } from "@book-maker/storage";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { seedObject } from "../../testing/objectStorage.js";
import { MockPrismaKnownRequestError, mockPrisma } from "./mobileApiMocks.js";

/**
 * Book sharing's test doubles: the three tables a share touches, backed by
 * arrays so "nothing was written" and "the old slug is still retired" are
 * claims about rows, and a real compiled PDF in the test object store so the
 * preview slice is a real slice.
 */

type Row = Record<string, any>;

export type ShareStore = {
  shares: Row[];
  slugs: string[];
  reports: Row[];
};

function pick(row: Row, select: Row | undefined): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      if ("not" in value) return row[key] !== value.not;
      if ("in" in value) return (value.in as unknown[]).includes(row[key]);
      if ("path" in value) return true;
      return false;
    }
    return row[key] === value;
  });
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === "object" && "increment" in value ? row[key] + value.increment : value;
  }
  row.updatedAt = new Date();
}

export function installShareStore(): ShareStore {
  const store: ShareStore = { shares: [], slugs: [], reports: [] };
  let nextId = 0;
  mockPrisma.bookShare.findUnique.mockImplementation(async ({ where, select }: Row) => {
    const row = store.shares.find((share) => matches(share, where));
    return row ? pick(row, select) : null;
  });
  mockPrisma.bookShare.create.mockImplementation(async ({ data, select }: Row) => {
    if (store.shares.some((share) => share.projectId === data.projectId || share.slug === data.slug)) {
      throw new MockPrismaKnownRequestError("Unique constraint failed", { code: "P2002", meta: { target: ["projectId"] } });
    }
    const now = new Date();
    const row = {
      id: `share-${++nextId}`,
      previewPages: null,
      caption: null,
      captionStatus: "NONE",
      captionVerdict: null,
      showAuthorName: false,
      likenessConfirmedAt: null,
      takedownReason: null,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
      ...data
    };
    store.shares.push(row);
    return pick(row, select);
  });
  mockPrisma.bookShare.update.mockImplementation(async ({ where, data, select }: Row) => {
    const row = store.shares.find((share) => matches(share, where));
    if (!row) throw new MockPrismaKnownRequestError("Record not found", { code: "P2025" });
    apply(row, data);
    return pick(row, select);
  });
  mockPrisma.bookShare.updateMany.mockImplementation(async ({ where, data }: Row) => {
    const hit = store.shares.filter((share) => matches(share, where));
    hit.forEach((row) => apply(row, data));
    return { count: hit.length };
  });
  mockPrisma.shareSlug.create.mockImplementation(async ({ data }: Row) => {
    if (store.slugs.includes(data.slug)) {
      throw new MockPrismaKnownRequestError("Unique constraint failed", { code: "P2002", meta: { target: ["slug"] } });
    }
    store.slugs.push(data.slug);
    return { slug: data.slug, createdAt: new Date() };
  });
  mockPrisma.shareSlug.findUnique.mockImplementation(async ({ where }: Row) =>
    store.slugs.includes(where.slug) ? { slug: where.slug } : null
  );
  mockPrisma.moderationReport.create.mockImplementation(async ({ data }: Row) => {
    const row = { id: `report-${store.reports.length + 1}`, status: "PENDING", ...data };
    store.reports.push(row);
    return row;
  });
  mockPrisma.moderationReport.updateMany.mockImplementation(async ({ where, data }: Row) => {
    const hit = store.reports.filter((report) => matches(report, where));
    hit.forEach((row) => Object.assign(row, data));
    return { count: hit.length };
  });
  return store;
}

/** A share row as the store holds it, for a suite that starts from an existing share. */
export function seedShare(store: ShareStore, overrides: Row = {}): Row {
  const now = new Date("2026-09-30T10:00:00.000Z");
  const row = {
    id: `share-seed-${store.shares.length + 1}`,
    projectId: "project-1",
    userId: "user-a",
    slug: "Seeded0Slug1",
    mode: "PREVIEW",
    previewPages: 2,
    caption: null,
    captionStatus: "NONE",
    captionVerdict: null,
    showAuthorName: false,
    rightsConfirmedAt: now,
    likenessConfirmedAt: null,
    status: "ACTIVE",
    takedownReason: null,
    viewCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
  store.shares.push(row);
  store.slugs.push(row.slug);
  return row;
}

/**
 * A compiled book of `sheets` sheets published for `projectId`: the PDF, its
 * provenance record, and a version-2 page map stamped with its digest whose
 * prose starts after `frontSheets` sheets. Each sheet carries a marker only it
 * holds, so a test can prove which sheets a response contains.
 */
export async function publishSharedBook(projectId: string, sheets: number, frontSheets: number): Promise<{ digest: string; pdfPageMap: Row; bytes: Buffer }> {
  const document = await PDFDocument.create();
  for (let number = 1; number <= sheets; number += 1) {
    const page = document.addPage([300, 400]);
    page.node.set(PDFName.of("Marker"), PDFString.of(`sheet-marker-${number}`));
  }
  const bytes = Buffer.from(await document.save({ useObjectStreams: false }));
  const digest = exportContentDigest(bytes);
  seedObject(objectKey("books", projectId, publishedExportFilename("pdf")), bytes);
  seedObject(
    exportProvenanceKey(projectId, "pdf"),
    JSON.stringify({ revision: 0, digest, byteSize: bytes.length, publishedAt: "2026-09-30T09:00:00.000Z" })
  );
  const pdfPageMap = {
    version: 2,
    totalPdfPages: sheets,
    hasCoverPage: frontSheets > 0,
    pages: [{ index: 1, startPdfPage: frontSheets + 1, endPdfPage: sheets }],
    contentRevision: 0,
    pdfDigest: digest
  };
  return { digest, pdfPageMap, bytes };
}

/** Which sheet markers a PDF holds, read from its uncompressed page dictionaries. */
export async function sheetMarkers(bytes: Buffer): Promise<number[]> {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => {
    const marker = page.node.get(PDFName.of("Marker"));
    return Number(String(marker instanceof PDFString ? marker.decodeText() : "").replace("sheet-marker-", ""));
  });
}
