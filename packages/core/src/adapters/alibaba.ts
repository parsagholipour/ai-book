import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import OpenAI from "openai";
import type {
  GenerateTextOptions,
  ImageAdapter,
  ImageRequest,
  ImageResult,
  Usage
} from "./types.js";
import { OpenAIChatCompletionsTextAdapter } from "./openAiChatCompletionsText.js";
import { toOpenAiChatMessages } from "./openaiToolCalling.js";
import {
  AdapterJsonParseError as AlibabaJsonParseError,
  AdapterJsonValidationError as AlibabaJsonValidationError
} from "./json.js";
import {
  DEFAULT_ALIBABA_API_HOST,
  DEFAULT_ALIBABA_IMAGE_MODEL,
  DEFAULT_ALIBABA_TEXT_MODEL,
  normalizeAlibabaModel,
  qwenImageReferenceLimit,
  supportsQwenImageReferenceImages
} from "./alibabaModels.js";
import { alibabaContentRefusal, alibabaRefusalReason } from "./alibabaImageRefusal.js";
import { ImageContentRefusedError, isImageContentRefusalError } from "./imageRefusal.js";
import { ProviderHttpError } from "./retry.js";

export { AlibabaJsonParseError, AlibabaJsonValidationError };

export type AlibabaAdapterOptions = {
  apiKey: string | undefined;
  apiHost?: string | undefined;
  textModel?: string | undefined;
  imageModel?: string | undefined;
};

type QwenImageContentPart = { image: string } | { text: string };

export class AlibabaTextAdapter extends OpenAIChatCompletionsTextAdapter {
  constructor(options: AlibabaAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("ALIBABA_API_KEY is required for Qwen text generation.");
    }

    const model = normalizeAlibabaModel(options.textModel, DEFAULT_ALIBABA_TEXT_MODEL);
    super({
      client: new OpenAI({
        apiKey: options.apiKey,
        baseURL: alibabaCompatibleBaseURL(options.apiHost)
      }),
      model,
      provider: "alibaba",
      providerLabel: "Alibaba Qwen",
      requestParameters: standardRequestParameters,
      reasoningParameters: noReasoningParameters,
      convertMessages: toOpenAiChatMessages,
      usageFromResponse: usageFromOpenAiCompatible,
      includeUsageInTextStream: true
    });
  }
}

function standardRequestParameters(options: GenerateTextOptions): Record<string, unknown> {
  return {
    temperature: options.temperature,
    max_tokens: options.maxTokens
  };
}

function noReasoningParameters(): Record<string, unknown> {
  return {};
}

function usageFromOpenAiCompatible(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as { prompt_tokens?: number; completion_tokens?: number };
  return {
    promptTokens: record.prompt_tokens,
    outputTokens: record.completion_tokens
  };
}

export class AlibabaImageAdapter implements ImageAdapter {
  private readonly apiKey: string;
  private readonly apiBaseURL: string;
  private readonly model: string;

  constructor(options: AlibabaAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("ALIBABA_API_KEY is required for Qwen image generation.");
    }
    this.apiKey = options.apiKey;
    this.apiBaseURL = alibabaApiBaseURL(options.apiHost);
    this.model = normalizeAlibabaModel(options.imageModel, DEFAULT_ALIBABA_IMAGE_MODEL);
  }

  capabilities() {
    const maxReferenceImages = qwenImageReferenceLimit(this.model);
    return {
      supportsReferenceImages: maxReferenceImages > 0,
      maxReferenceImages
    };
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    if (request.referenceImagePaths?.length && !supportsQwenImageReferenceImages(this.model)) {
      throw new Error(`Qwen image model ${this.model} cannot consume character reference images.`);
    }

    try {
      return await this.generateSynchronousImage(request);
    } catch (error) {
      if (!asyncQwenImageCanServe(this.model, request) || !shouldFallBackToAsyncQwen(error)) {
        throw error;
      }
      return this.generateAsyncImage(request);
    }
  }

  private async generateSynchronousImage(request: ImageRequest): Promise<ImageResult> {
    const content = await this.qwenMultimodalContent(request);
    const response = await this.postJson(`${this.apiBaseURL}/services/aigc/multimodal-generation/generation`, {
      model: this.model,
      input: {
        messages: [
          {
            role: "user",
            content
          }
        ]
      },
      parameters: {
        negative_prompt: qwenNegativePrompt(),
        prompt_extend: true,
        watermark: false,
        size: qwenImageSize(this.model, request.aspectRatio)
      }
    });

    return this.imageResultFromResponse(response);
  }

  private async qwenMultimodalContent(request: ImageRequest): Promise<QwenImageContentPart[]> {
    const referenceImagePaths = request.referenceImagePaths?.slice(0, qwenImageReferenceLimit(this.model)) ?? [];
    if (referenceImagePaths.length === 0) {
      return [{ text: request.prompt }];
    }

    const referenceParts = await Promise.all(
      referenceImagePaths.map(async (path) => ({
        image: await imageDataUrl(path)
      }))
    );
    return [...referenceParts, { text: request.prompt }];
  }

  /**
   * The text-to-image endpoint, which is exactly and only what its path says.
   *
   * `input` here is `{ prompt }` — this call has no place to put a reference
   * image, and the models {@link supportsAsyncQwenImage} routes to it all
   * declare `supportsReferenceImages: false` in `alibabaModels.ts`. References
   * only ever reach DashScope through the *sync* multimodal endpoint, as
   * `qwenMultimodalContent` image parts.
   *
   * So this used to read `request.prompt` and drop the rest on the floor. A
   * request that arrived here carrying reference images came back as a picture
   * drawn from the prompt alone — no cast likeness, no library face seed — with
   * no event, no run-log line and nothing in the result to say so. On a
   * character reference sheet that picture is written as an ordinary
   * `ImageAsset`, `characterReferenceSetIsSettled` then reports the cast
   * settled, and the off-model sheet is what every page and the cover are drawn
   * against for the life of the plan version — the loss
   * `FallbackImageAdapter.refitForFallback` exists to make *visible*, at 100%
   * instead of partial and with the one thing that makes it survivable missing.
   *
   * Nothing could reach it today, and that is the problem: the guard was two
   * hand-kept lists happening not to overlap, one word apart in either
   * direction from arming it. The endpoint now refuses a request it cannot
   * serve, which is the rule `refitForFallback` states — *an adapter is never
   * handed a request it has already declared it cannot serve* — and the fork
   * above declines first, so the caller keeps the sync failure rather than
   * meeting this one.
   */
  private async generateAsyncImage(request: ImageRequest): Promise<ImageResult> {
    if (referenceImageCount(request) > ASYNC_QWEN_IMAGE_REFERENCE_LIMIT) {
      throw new Error(
        `Qwen async image synthesis (${this.model}) cannot consume character reference images.`
      );
    }

    const createResponse = await this.postJson(
      `${this.apiBaseURL}/services/aigc/text2image/image-synthesis`,
      {
        model: this.model,
        input: {
          prompt: request.prompt
        },
        parameters: {
          negative_prompt: qwenNegativePrompt(),
          prompt_extend: true,
          watermark: false,
          n: 1,
          size: qwenImageSize(this.model, request.aspectRatio)
        }
      },
      { "X-DashScope-Async": "enable" }
    );
    const taskId = outputString(createResponse, "task_id");
    if (!taskId) {
      throw new Error("Qwen image generation did not return a task ID.");
    }

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const taskResponse = await this.getJson(`${this.apiBaseURL}/tasks/${encodeURIComponent(taskId)}`);
      const status = outputString(taskResponse, "task_status");
      if (status === "SUCCEEDED") {
        return this.imageResultFromResponse(taskResponse);
      }
      if (status === "FAILED") {
        // The async endpoint reports a filtered render as a completed task
        // with a failure code rather than as an HTTP error, so the same
        // verdict has to be recognised here too.
        const message = firstString(
          responseAt(taskResponse, ["output", "message"]),
          responseAt(taskResponse, ["message"]),
          responseAt(taskResponse, ["output", "results", 0, "message"])
        );
        const refusal = alibabaContentRefusal(this.model, undefined, alibabaErrorCode(taskResponse), message);
        if (refusal) {
          throw refusal;
        }
        throw new Error(`Qwen image generation failed for task ${taskId}.${message ? ` ${message}` : ""}`);
      }
    }

    throw new Error(`Timed out waiting for Qwen image generation task ${taskId}.`);
  }

  private imageResultFromResponse(response: unknown): ImageResult {
    const imageUrl = firstString(
      responseAt(response, ["output", "choices", 0, "message", "content", 0, "image"]),
      responseAt(response, ["output", "choices", 0, "message", "content", 0, "url"]),
      responseAt(response, ["output", "results", 0, "url"]),
      responseAt(response, ["output", "results", 0, "image"]),
      responseAt(response, ["data", 0, "url"])
    );
    const base64Image = firstString(
      responseAt(response, ["output", "choices", 0, "message", "content", 0, "image_base64"]),
      responseAt(response, ["output", "choices", 0, "message", "content", 0, "b64_json"]),
      responseAt(response, ["data", 0, "b64_json"])
    );
    const revisedPrompt = firstString(
      responseAt(response, ["output", "results", 0, "actual_prompt"]),
      responseAt(response, ["output", "choices", 0, "message", "content", 0, "actual_prompt"])
    );

    const result = {
      provider: "alibaba",
      model: this.model,
      mimeType: "image/png"
    };
    if (base64Image) {
      const output = { ...result, data: Buffer.from(base64Image, "base64") };
      return revisedPrompt ? { ...output, revisedPrompt } : output;
    }
    if (imageUrl) {
      const output = { ...result, url: imageUrl };
      return revisedPrompt ? { ...output, revisedPrompt } : output;
    }

    throw this.missingImageError(response);
  }

  /**
   * Why a 200 carried no picture.
   *
   * The sync multimodal endpoint is a *chat* endpoint, so DashScope can decline
   * by talking: the HTTP call succeeds, the turn ends normally, and the content
   * part holds a sentence where the image belongs. That used to leave here as a
   * bare `Error`, which is retryable everywhere — `withRecoverableNetworkRetry`
   * spent three attempts on it, the fallback provider was tried, and the job's
   * own ladder tried again, all re-asking a question the filter had already
   * answered. A book whose only image provider is Alibaba never reached the
   * copyright rewrite path at all, because that path is keyed on the typed
   * verdict.
   *
   * The verdict still has to be *named*, exactly as it does for Gemini: an
   * empty turn, or one that says something other than "no", is a render that
   * did not happen, and calling that permanent would deny a character its
   * reference sheet for the life of the plan. So a refusal here is either the
   * filter's own code — DashScope also answers `DataInspectionFailed` inside an
   * HTTP 200 on some deployments, and reports a filtered picture as a
   * *succeeded* async task whose result row carries the code — or prose that
   * {@link isSpokenImageRefusal} reads as a decline, with DashScope's own
   * vocabulary handed in as the provider half of that predicate's *vocabulary*
   * reading.
   *
   * **Handed in, rather than ORed beside it.** This used to ask DashScope's
   * vocabulary as a flat predicate of its own, ORed beside
   * `isSpokenImageRefusal(detail)`, and that left half is this reading with
   * every one of its guards missing: no clearance veto, no outage veto above
   * it, and nothing ordering it against the readings below. The bare `/content policy/i` in DashScope's list
   * therefore read `"The image was generated in accordance with the content
   * policy"` — a *drawn* picture narrating its own compliance, the turn
   * `imageRefusal.ts` pins as retryable in as many words — as a settled
   * refusal, on the one endpoint here whose prose is the model talking. Reading
   * order survives the move intact, in both directions: DashScope's words still
   * outrank a bare failure wrapper, and a named outage still outranks
   * DashScope's words, because "the data inspection service is temporarily
   * unavailable" is that inspector being *broken* rather than that inspector
   * answering.
   *
   * The code test still answers before the prose, and it is a regex rather than
   * Gemini's allowlist because `code` is DashScope's general-purpose error
   * field — `InvalidParameter` arrives there too, and only `data inspection` is
   * the filter. That is why the rejected code travels on to
   * {@link spokenImageRefusalReason} as a qualifier: Gemini's native turn has no
   * such field and passes nothing. What it no longer answers before is the
   * *outage* veto, which `alibabaRefusalReason` now asks above both arms —
   * DashScope names its outages after the same inspector it names its verdicts
   * after, so a code arm that went first read `"the data inspection service is
   * temporarily unavailable"` as the inspector answering.
   *
   * A refusal raised here also settles the async fallback, because
   * `shouldFallBackToAsyncQwen` tests the verdict by identity before it tests
   * any HTTP status.
   */
  private missingImageError(response: unknown): Error {
    const code = alibabaErrorCode(response);
    const detail = alibabaSpokenText(response);
    const finishReason = firstString(responseAt(response, ["output", "choices", 0, "finish_reason"]));
    const reason = alibabaRefusalReason(code, detail, "model-turn", finishReason);
    if (reason) {
      return new ImageContentRefusedError({
        provider: "alibaba",
        model: this.model,
        reason,
        detail
      });
    }
    return new Error(
      `Qwen image model ${this.model} did not return an image URL or bytes.${detail ? ` ${detail}` : ""}`
    );
  }

  private async postJson(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });
    return parseAlibabaHttpResponse(response, this.model);
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });
    return parseAlibabaHttpResponse(response, this.model);
  }
}

function alibabaCompatibleBaseURL(apiHost: string | undefined): string {
  return normalizeAlibabaURL(apiHost, "compatible-mode/v1");
}

function alibabaApiBaseURL(apiHost: string | undefined): string {
  return normalizeAlibabaURL(apiHost, "api/v1");
}

function normalizeAlibabaURL(apiHost: string | undefined, targetPath: "compatible-mode/v1" | "api/v1"): string {
  const trimmed = (apiHost ?? DEFAULT_ALIBABA_API_HOST).trim().replace(/\/+$/, "");
  const currentPath = targetPath === "compatible-mode/v1" ? "api/v1" : "compatible-mode/v1";
  if (trimmed.endsWith(`/${targetPath}`)) {
    return trimmed;
  }
  if (trimmed.includes(`/${currentPath}`)) {
    return trimmed.replace(new RegExp(`/${escapeRegex(currentPath)}(?:/.*)?$`), `/${targetPath}`);
  }
  if (trimmed.includes(`/${targetPath}/`)) {
    return trimmed.replace(new RegExp(`/${escapeRegex(targetPath)}/.*$`), `/${targetPath}`);
  }
  return `${trimmed}/${targetPath}`;
}

function qwenImageSize(model: string, aspectRatio: string | undefined): string {
  const ratio = aspectRatio ?? "4:3";
  if (model.startsWith("qwen-image-2.0")) {
    return (
      {
        "16:9": "2688*1536",
        "9:16": "1536*2688",
        "1:1": "2048*2048",
        "4:3": "2368*1728",
        "3:4": "1728*2368"
      }[ratio] ?? "2368*1728"
    );
  }

  return (
    {
      "16:9": "1664*928",
      "9:16": "928*1664",
      "1:1": "1328*1328",
      "4:3": "1472*1104",
      "3:4": "1104*1472"
    }[ratio] ?? "1472*1104"
  );
}

function qwenNegativePrompt(): string {
  return [
    "Low resolution",
    "low quality",
    "distorted anatomy",
    "malformed hands",
    "blurry text",
    "warped text",
    "watermark",
    "signature",
    "logo",
    "chaotic composition"
  ].join(", ");
}

async function imageDataUrl(path: string): Promise<string> {
  const mimeType = mimeTypeForImagePath(path);
  return `data:${mimeType};base64,${(await readFile(path)).toString("base64")}`;
}

function mimeTypeForImagePath(path: string): string {
  const fromExt: Record<string, string> = {
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webp": "image/webp"
  };
  return fromExt[extname(path).toLowerCase()] ?? "image/png";
}

function supportsAsyncQwenImage(model: string): boolean {
  return model === "qwen-image" || model === "qwen-image-plus";
}

/**
 * What `text2image/image-synthesis` can carry, written down rather than left to
 * be inferred from two lists that happen not to overlap.
 *
 * Zero, and structurally so: the request body is `input: { prompt }`, and
 * `alibabaImageModelOptions` marks every model {@link supportsAsyncQwenImage}
 * names — `qwen-image`, `qwen-image-plus` — `supportsReferenceImages: false`.
 */
const ASYNC_QWEN_IMAGE_REFERENCE_LIMIT = 0;

function referenceImageCount(request: ImageRequest): number {
  return request.referenceImagePaths?.length ?? 0;
}

/**
 * Whether the async endpoint can serve *this request*, rather than whether it
 * can serve this model.
 *
 * The fork used to ask only the second question, and the safety of that was an
 * accident of arithmetic between two hand-kept lists:
 * `supportsQwenImageReferenceImages` names the `qwen-image-2.0` family and
 * {@link supportsAsyncQwenImage} names two models that are not in it, so no
 * reference-carrying request could reach {@link AlibabaImageAdapter.generateAsyncImage}
 * — today. Nothing ties the lists together and nothing would fail if they
 * overlapped: DashScope enabling async synthesis for `qwen-image-2.0` is one
 * word in a list this file already keeps by hand, and it would turn a single
 * transient 500 on a character-reference render into a settled, silent,
 * off-model reference sheet.
 *
 * Declining costs the render nothing it can afford to keep. The sync failure
 * travels on as the `ProviderHttpError` it is, to
 * `withRecoverableNetworkRetry` — whose next attempt re-runs the multimodal
 * endpoint, references and all — and to `FallbackImageAdapter`, whose other
 * provider takes references too and whose `refitForFallback` writes down
 * whatever it has to trim. Every one of those can draw the picture the caller
 * actually asked for; the async endpoint is the only path here that would draw
 * a different one and call it the same.
 *
 * A reference-less request is unaffected, which is every request the fallback
 * has ever served.
 */
function asyncQwenImageCanServe(model: string, request: ImageRequest): boolean {
  return supportsAsyncQwenImage(model) && referenceImageCount(request) <= ASYNC_QWEN_IMAGE_REFERENCE_LIMIT;
}

/**
 * Whether a failed synchronous render is worth a second, fully billed attempt
 * through the async endpoint.
 *
 * The fallback exists for failures *specific to the sync path* — a gateway
 * timeout, a 5xx, a connection that died. It used to catch everything, so a
 * 401 (bad key), a 400 (content policy) or a 429 (quota) launched a second
 * generation guaranteed to fail the same way, and the surfaced error was the
 * async attempt's rather than the root cause.
 *
 * A content refusal is that same 400, and it stopped being a `ProviderHttpError`
 * the moment it started being typed as one: `DataInspectionFailed` now arrives
 * as an `ImageContentRefusedError`, which has no status to test, so the
 * transport-shaped default below would have waved it straight through to a
 * second fully billed render of the prompt DashScope had just declined. The
 * verdict is checked by *identity* before the status is, exactly as
 * `isRecoverableNetworkError` checks it.
 */
function shouldFallBackToAsyncQwen(error: unknown): boolean {
  if (isImageContentRefusalError(error)) {
    // The filter read the prompt and answered. The async endpoint runs the same
    // inspectors, so re-asking buys one more billed refusal and loses the
    // typed verdict the caller needs.
    return false;
  }
  if (!(error instanceof ProviderHttpError)) {
    // Network-shaped failures (no HTTP status at all) may be transport issues
    // the async path avoids.
    return true;
  }
  return error.status >= 500 || error.status === 408;
}

async function parseAlibabaHttpResponse(response: Response, model: string): Promise<unknown> {
  const text = await response.text();
  const data = text ? safeJsonParse(text) : {};
  if (!response.ok) {
    const message =
      firstString(responseAt(data, ["message"]), responseAt(data, ["error", "message"]), responseAt(data, ["output", "message"])) ??
      text.slice(0, 500) ??
      response.statusText;
    // DashScope answers its own content and IP filters with a 400 and a
    // `DataInspectionFailed` code. That is a verdict, not an outage: the
    // caller above needs it typed so it stops paying to re-ask.
    const refusal = alibabaContentRefusal(model, response.status, alibabaErrorCode(data), message);
    if (refusal) {
      throw refusal;
    }
    // ProviderHttpError, not a bare Error: the status has to travel as a
    // *field* for `isRecoverableNetworkError` to see it — a DashScope 429
    // whose status lived only in the message text matched no retry pattern
    // and was never retried, the exact failure the ProviderHttpError design
    // exists to prevent. The speech adapters got this fix; this path had not.
    const retryAfterHeader = Number(response.headers.get("retry-after"));
    throw new ProviderHttpError(`Alibaba Qwen API request failed (${response.status}): ${message}`, {
      status: response.status,
      ...(Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? { retryAfterMs: retryAfterHeader * 1000 }
        : {})
    });
  }
  return data;
}

/**
 * DashScope's own code, wherever this response put it.
 *
 * `output.results[0].code` is the last read and the one that used to be missing
 * here: the async endpoint reports a filtered picture as a *result row* carrying
 * a code instead of a URL, on a task that says `FAILED` as readily as
 * `SUCCEEDED`. `missingImageError` spelled that read out for itself, so the
 * SUCCEEDED half was covered and the FAILED half was not — a `DataInspectionFailed`
 * in the row left the poll as a bare `Error`, retryable to
 * `withRecoverableNetworkRetry`, to the image fallback and to BullMQ, which is a
 * settled verdict bought three times over and a copyright rewrite never offered.
 * One read, four call sites, and the precedence is the one `missingImageError`
 * already had: the task's own code outranks a row's.
 */
function alibabaErrorCode(data: unknown): string | undefined {
  return firstString(
    responseAt(data, ["code"]),
    responseAt(data, ["error", "code"]),
    responseAt(data, ["output", "code"]),
    responseAt(data, ["output", "results", 0, "code"])
  );
}

/**
 * Everything a picture-less response said in sentences.
 *
 * The multimodal endpoint answers in chat parts, so a model that talked instead
 * of drawing put its words in `content` — as an array of parts, or as a bare
 * string on the models that return one. The task and error messages are
 * gathered beside them because the same verdict arrives spelled only there on
 * the other endpoints, and the classifier reads all prose the same way.
 */
function alibabaSpokenText(response: unknown): string | undefined {
  const spoken: unknown[] = [];
  const content = responseAt(response, ["output", "choices", 0, "message", "content"]);
  if (Array.isArray(content)) {
    for (const part of content) {
      spoken.push(responseAt(part, ["text"]));
    }
  } else {
    spoken.push(content);
  }
  spoken.push(
    responseAt(response, ["output", "results", 0, "message"]),
    responseAt(response, ["output", "message"]),
    responseAt(response, ["message"])
  );
  const text = [
    ...new Set(spoken.map((value) => firstString(value)).filter((value): value is string => Boolean(value)))
  ]
    .join(" ")
    .trim();
  return text || undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function outputString(value: unknown, key: string): string | undefined {
  return firstString(responseAt(value, ["output", key]));
}

function responseAt(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
