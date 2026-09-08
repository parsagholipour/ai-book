import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { SourceOcr } from "./extraction.js";

const paddleResponseSchema = z.object({
  errorCode: z.number().int(),
  errorMsg: z.string().optional(),
  result: z.object({ layoutParsingResults: z.array(z.object({ markdown: z.object({ text: z.string() }) })) }).optional()
});
export function createSourceOcr(config: AppConfig): SourceOcr | undefined {
  if (config.MOCK_AI) return async () => ({ content: "[Mock visual extraction]", unreadable: [] });
  if (config.SOURCE_OCR_URL) return createPaddleSourceOcr(config.SOURCE_OCR_URL, config.SOURCE_OCR_TIMEOUT_MS);
  return undefined;
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
    const content = parsed.result.layoutParsingResults.map((page) => page.markdown.text.trim()).filter(Boolean).join("\n\n");
    return { content, unreadable: content ? [] : ["Local OCR found no readable text on this page"] };
  };
}
