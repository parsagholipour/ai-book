import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaddleSourceOcr } from "./ocr.js";

afterEach(() => vi.unstubAllGlobals());
describe("local PaddleOCR source adapter", () => {
  it("sends a private single-page PDF and returns structured Markdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errorCode: 0, result: { layoutParsingResults: [{ markdown: { text: "# پایان\n\n| نام | مقدار |\n|---|---|\n| علی | ۷۴۲ |" } }] } })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createPaddleSourceOcr("http://ocr:8080", 20_000)(Buffer.from("private page"), "application/pdf");
    expect(result.content).toContain("علی | ۷۴۲");
    expect(result.unreadable).toEqual([]);
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(fetchMock.mock.calls[0]![0].toString()).toBe("http://ocr:8080/layout-parsing");
    expect(request).toMatchObject({ fileType: 0, useDocOrientationClassify: true, useDocUnwarping: true, visualize: false, returnMarkdownImages: false });
    expect(Buffer.from(request.file, "base64").toString()).toBe("private page");
  });
  it("rejects service failures and marks an empty page unreadable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("unavailable", { status: 503 })));
    await expect(createPaddleSourceOcr("http://ocr:8080", 20_000)(Buffer.from("x"), "image/png")).rejects.toThrow("HTTP 503");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ errorCode: 0, result: { layoutParsingResults: [{ markdown: { text: "" } }] } }))));
    expect((await createPaddleSourceOcr("http://ocr:8080", 20_000)(Buffer.from("x"), "image/png")).unreadable).toHaveLength(1);
  });
});
