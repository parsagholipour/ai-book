import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { FakeFileDigestAdapter } from "../adapters/fileUnderstanding.js";
import {
  CREATION_ATTACHMENT_CONTENT_MAX,
  CreationAttachmentError,
  detectCreationAttachmentType,
  ingestCreationAttachment,
  sanitizeAttachmentName
} from "./creationAttachments.js";

describe("detectCreationAttachmentType", () => {
  it("classifies photos by mime type and by extension", () => {
    expect(detectCreationAttachmentType("notes.jpg", undefined)).toEqual({
      kind: "photo",
      format: "image",
      mimeType: "image/jpeg"
    });
    expect(detectCreationAttachmentType("sketch", "image/png")?.kind).toBe("photo");
    expect(detectCreationAttachmentType("IMG_0001.HEIC", "application/octet-stream")?.mimeType).toBe(
      "image/heic"
    );
  });

  it("classifies documents", () => {
    expect(detectCreationAttachmentType("brief.pdf", "application/pdf")?.format).toBe("pdf");
    expect(detectCreationAttachmentType("draft.docx", undefined)?.format).toBe("docx");
    expect(detectCreationAttachmentType("book.epub", undefined)?.format).toBe("epub");
    expect(detectCreationAttachmentType("notes.md", "text/markdown")?.format).toBe("text");
    expect(detectCreationAttachmentType("page.html", undefined)?.format).toBe("html");
  });

  it("rejects unsupported types", () => {
    expect(detectCreationAttachmentType("song.mp3", "audio/mpeg")).toBeNull();
    expect(detectCreationAttachmentType("archive.zip", "application/zip")).toBeNull();
    expect(detectCreationAttachmentType("app.exe", "application/octet-stream")).toBeNull();
  });
});

describe("ingestCreationAttachment", () => {
  it("ingests a plain-text document without any model call", async () => {
    const text = "My pricing framework.\nStep 1: anchor high.\nStep 2: offer three tiers.";
    const attachment = await ingestCreationAttachment({
      data: Buffer.from(text, "utf8"),
      name: "pricing-notes.txt",
      mimeType: "text/plain"
    });
    expect(attachment.kind).toBe("document");
    expect(attachment.content).toContain("anchor high");
    expect(attachment.summary.length).toBeGreaterThan(0);
    expect(attachment.truncated).toBe(false);
    expect(attachment.id).toMatch(/^att_/);
  });

  it("strips markup from HTML documents", async () => {
    const html = "<html><head><style>p{color:red}</style></head><body><h1>Guide</h1><p>Real&nbsp;content &amp; more</p></body></html>";
    const attachment = await ingestCreationAttachment({
      data: Buffer.from(html, "utf8"),
      name: "guide.html"
    });
    expect(attachment.content).toContain("Real content & more");
    expect(attachment.content).not.toContain("<p>");
    expect(attachment.content).not.toContain("color:red");
  });

  it("extracts text from a DOCX file", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Chapter one intro.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph here.</w:t></w:r></w:p></w:body></w:document>`
    );
    const data = await zip.generateAsync({ type: "nodebuffer" });
    const attachment = await ingestCreationAttachment({ data, name: "draft.docx" });
    expect(attachment.content).toContain("Chapter one intro.");
    expect(attachment.content).toContain("Second paragraph here.");
  });

  it("extracts chapter text from an EPUB file", async () => {
    const zip = new JSZip();
    zip.file("OEBPS/ch1.xhtml", "<html><body><p>Once upon a market.</p></body></html>");
    zip.file("OEBPS/ch2.xhtml", "<html><body><p>The second chapter.</p></body></html>");
    const data = await zip.generateAsync({ type: "nodebuffer" });
    const attachment = await ingestCreationAttachment({ data, name: "book.epub" });
    expect(attachment.content).toContain("Once upon a market.");
    expect(attachment.content).toContain("The second chapter.");
  });

  it("bounds long documents and marks them truncated", async () => {
    const text = Array.from({ length: 4000 }, (_, i) => `Line ${i} of the manuscript.`).join("\n");
    const attachment = await ingestCreationAttachment({
      data: Buffer.from(text, "utf8"),
      name: "manuscript.txt"
    });
    expect(attachment.content.length).toBeLessThanOrEqual(CREATION_ATTACHMENT_CONTENT_MAX);
    expect(attachment.truncated).toBe(true);
  });

  it("uses the file digest adapter for photos", async () => {
    const attachment = await ingestCreationAttachment(
      { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), name: "cover-idea.jpg" },
      { fileDigest: new FakeFileDigestAdapter() }
    );
    expect(attachment.kind).toBe("photo");
    expect(attachment.summary).toContain("cover-idea.jpg");
    expect(attachment.content.length).toBeGreaterThan(0);
  });

  it("fails photos with a friendly error when no digest adapter exists", async () => {
    await expect(
      ingestCreationAttachment({ data: Buffer.from([1, 2, 3]), name: "photo.png" })
    ).rejects.toMatchObject({ code: "INGESTION_UNAVAILABLE" });
  });

  it("rejects unsupported and empty files", async () => {
    await expect(
      ingestCreationAttachment({ data: Buffer.from([1]), name: "track.mp3" })
    ).rejects.toBeInstanceOf(CreationAttachmentError);
    await expect(
      ingestCreationAttachment({ data: Buffer.alloc(0), name: "notes.txt" })
    ).rejects.toMatchObject({ code: "EMPTY_FILE" });
  });

  it("summarizes long text with the summary model when provided", async () => {
    const summaryModel = {
      generateText: async () => ({ text: "", model: "fake", provider: "fake" }),
      streamText: async function* () {
        yield "";
      },
      generateJson: async () => ({
        data: { summary: "A concise digest of the manuscript." },
        text: "{}",
        model: "fake",
        provider: "fake"
      })
    };
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} with detail.`).join(" ");
    const attachment = await ingestCreationAttachment(
      { data: Buffer.from(text, "utf8"), name: "long.txt" },
      { summaryModel: summaryModel as never }
    );
    expect(attachment.summary).toBe("A concise digest of the manuscript.");
  });
});

describe("sanitizeAttachmentName", () => {
  it("removes path separators and control characters", () => {
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe(".. .. etc passwd");
    expect(sanitizeAttachmentName("notes\u0000\u001f.txt")).toBe("notes.txt");
    expect(sanitizeAttachmentName("   ")).toBe("attachment");
  });
});
