import { describe, expect, it } from "vitest";
import { attachmentContentDisposition, servedAttachmentType } from "./attachmentResponse.js";

describe("servedAttachmentType", () => {
  it("keeps the types the upload route accepts, without their parameters", () => {
    expect(servedAttachmentType("image/jpeg")).toBe("image/jpeg");
    expect(servedAttachmentType("IMAGE/PNG")).toBe("image/png");
    expect(servedAttachmentType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(servedAttachmentType("application/pdf")).toBe("application/pdf");
    expect(servedAttachmentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(servedAttachmentType("application/epub+zip")).toBe("application/epub+zip");
    expect(servedAttachmentType("text/markdown")).toBe("text/markdown");
    expect(servedAttachmentType("text/csv")).toBe("text/csv");
  });

  it("serves anything a browser could render as markup or script as bytes", () => {
    for (const type of [
      "text/html",
      "TEXT/HTML; charset=utf-8",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/xml",
      "text/xml",
      "text/javascript",
      "application/javascript",
      "multipart/x-mixed-replace",
      "constructor",
      "__proto__",
      ""
    ]) {
      expect(servedAttachmentType(type)).toBe("application/octet-stream");
    }
  });
});

describe("attachmentContentDisposition", () => {
  it("is always a download, with an ASCII fallback and the exact name as filename*", () => {
    expect(attachmentContentDisposition("notes.txt")).toBe(`attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`);
    expect(attachmentContentDisposition("my (draft)'s notes*.md")).toBe(
      `attachment; filename="my (draft)'s notes*.md"; filename*=UTF-8''my%20%28draft%29%27s%20notes%2A.md`
    );
    expect(attachmentContentDisposition("دفترچه.docx")).toBe(
      `attachment; filename="______.docx"; filename*=UTF-8''${encodeURIComponent("دفترچه.docx")}`
    );
  });

  it("drops header-breaking characters and never throws on a lone surrogate", () => {
    const header = attachmentContentDisposition('a"b\\c\r\nSet-Cookie: x=1\u0000.txt');
    expect(header).not.toMatch(/[\r\n\u0000]/);
    expect(header).toBe(`attachment; filename="a_b_cSet-Cookie: x=1.txt"; filename*=UTF-8''a%22b%5CcSet-Cookie%3A%20x%3D1.txt`);
    expect(attachmentContentDisposition("half\ud800.txt")).toBe(`attachment; filename="half_.txt"; filename*=UTF-8''half_.txt`);
    expect(attachmentContentDisposition("\r\n")).toBe(`attachment; filename="attachment"; filename*=UTF-8''attachment`);
  });
});
