import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { SourceOcr } from "./extraction.js";
import { createGeminiSourceOcr } from "./geminiOcr.js";

const paddlePageSchema = z.object({ markdown: z.object({ text: z.string() }) });
const paddleResponseSchema = z.object({
  errorCode: z.number().int(),
  errorMsg: z.string().optional(),
  result: z.object({ layoutParsingResults: z.array(z.unknown()) }).optional()
});
export function createSourceOcr(config: AppConfig): SourceOcr | undefined {
  if (config.MOCK_AI) return async () => ({ content: "[Mock visual extraction]", unreadable: [] });
  const local = config.SOURCE_OCR_URL ? createPaddleSourceOcr(config.SOURCE_OCR_URL, config.SOURCE_OCR_TIMEOUT_MS) : undefined;
  const apiKey = config.GEMINI_API_KEY?.trim();
  const google = apiKey ? createGeminiSourceOcr(apiKey, config.GEMINI_OCR_MODEL || config.GEMINI_TEXT_MODEL, config.SOURCE_OCR_TIMEOUT_MS) : undefined;
  if (!local) return google;
  if (!google) return local;
  return async (data, mimeType) => {
    let localResult: Awaited<ReturnType<SourceOcr>> | undefined;
    try {
      localResult = await local(data, mimeType);
      if (localResult.content.trim() && !localResult.unreadable.length) return localResult;
    } catch { /* The cloud fallback also handles transport and invalid-response failures. */ }
    try {
      const result = await google(data, mimeType);
      // A cloud response with no text must not erase text already read locally.
      if (localResult?.content.trim() && !result.content.trim()) {
        return { ...result, content: localResult.content, unreadable: [...localResult.unreadable, ...result.unreadable] };
      }
      return result;
    } catch (error) {
      // Keep partial/empty local extraction and its unreadable markers for retry.
      if (localResult) return localResult;
      throw error;
    }
  };
}

/** PaddleOCR-VL runs as a private Docker service and returns structured Markdown. */
export function createPaddleSourceOcr(baseUrl: string, timeoutMs: number): SourceOcr {
  const endpoint = new URL("layout-parsing", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return async (data, mimeType) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file: data.toString("base64"),
        fileType: mimeType === "application/pdf" ? 0 : 1,
        useDocOrientationClassify: true,
        useDocUnwarping: true,
        visualize: false,
        returnMarkdownImages: false
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`Local OCR failed with HTTP ${response.status}.`);
    const parsed = paddleResponseSchema.parse(await response.json());
    if (parsed.errorCode !== 0 || !parsed.result) throw new Error(`Local OCR failed: ${parsed.errorMsg ?? `code ${parsed.errorCode}`}.`);
    const pages = parsed.result.layoutParsingResults.map((page) => paddlePageSchema.safeParse(page));
    const content = pages.map((page) => page.success ? page.data.markdown.text.trim() : "").filter(Boolean).join("\n\n");
    const incomplete = pages.some((page) => !page.success || !page.data.markdown.text.trim());
    return { content, unreadable: !content ? ["Local OCR found no readable text on this page"] : incomplete ? ["Local OCR could not read every page region"] : [] };
  };
}
