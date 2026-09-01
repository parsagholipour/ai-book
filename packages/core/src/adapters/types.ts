import type { ZodType } from "zod";
import type { ModelTier, TextModelSelection } from "../schemas/book.js";

/** A tool invocation requested by the model during a generateWithTools call. */
export type ToolCall = {
  /** Provider-assigned id linking the call to its tool-result message. */
  id: string;
  name: string;
  /** Parsed JSON arguments. Handlers validate these against their schema. */
  arguments: unknown;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[] | undefined;
  /** Set on tool messages; links the result to the originating call. */
  toolCallId?: string | undefined;
  /** Set on tool messages; some providers (Gemini) address results by name. */
  toolName?: string | undefined;
};

/** Machine-only causes that can trigger a page-QA rewrite provider call. */
export const PAGE_QA_TRIGGER_REASONS = [
  "model_review",
  "claim_grounding",
  "story_contradiction",
  "style",
  "local_check",
  "smart_unslop",
  "reserved_beat",
  "brief_repair"
] as const;

export type PageQaTriggerReason = (typeof PAGE_QA_TRIGGER_REASONS)[number];

/** A deliberately closed page-QA provider-log payload with no prose fields. */
export type PageQaProviderCallMetadata = {
  qaTriggerReasons: PageQaTriggerReason[];
  /** Candidate produced by this call; the original draft is candidate 1. */
  qaCandidateNumber: number;
  /** One less than the candidate number; the original draft has no rewrite. */
  qaRewriteNumber: number;
};

/** One physical provider attempt within a generated chapter-brief call. */
export type ChapterBriefProviderCallMetadata = {
  chapterBriefLogicalCallId: string;
  chapterBriefTier: ModelTier;
  chapterBriefChapterIndex: number;
  chapterBriefPageStart: number;
  chapterBriefPageEnd: number;
  /** One-based physical JSON attempt, including schema repairs. */
  chapterBriefAttempt: number;
  /** Initial attempt plus the bounded schema-repair allowance. */
  chapterBriefMaxAttempts: number;
  /**
   * Present on physical attempts after a schema-validation failure.
   * Absent on the first attempt and on JSON-syntax repair attempts.
   */
  chapterBriefSchemaRepair?: boolean;
};

/** One sparse production-map repair call (at most twelve findings). */
export type ProductionMapRepairProviderCallMetadata = {
  productionMapRepairCycle: number;
  productionMapRepairBatch: number;
  productionMapRepairFindingCount: number;
  productionMapRepairKind: "sparse-page-patch";
};

export type ProviderCallMetadata =
  | PageQaProviderCallMetadata
  | ChapterBriefProviderCallMetadata
  | ProductionMapRepairProviderCallMetadata;

export function isPageQaProviderCallMetadata(
  value: ProviderCallMetadata | undefined
): value is PageQaProviderCallMetadata {
  return value !== undefined && "qaTriggerReasons" in value;
}

export function isChapterBriefProviderCallMetadata(
  value: ProviderCallMetadata | undefined
): value is ChapterBriefProviderCallMetadata {
  return value !== undefined && "chapterBriefLogicalCallId" in value;
}

export function isProductionMapRepairProviderCallMetadata(
  value: ProviderCallMetadata | undefined
): value is ProductionMapRepairProviderCallMetadata {
  return value !== undefined && "productionMapRepairCycle" in value;
}

/** Stamp physical attempt fields on chapter-brief provider-call metadata. */
export function stampChapterBriefPhysicalAttempt(
  metadata: ProviderCallMetadata | undefined,
  attempt: { index: number; maxAttempts: number; schemaRepair: boolean }
): ProviderCallMetadata | undefined {
  if (!isChapterBriefProviderCallMetadata(metadata)) {
    return metadata;
  }
  const { chapterBriefSchemaRepair: _ignored, ...rest } = metadata;
  return {
    ...rest,
    chapterBriefAttempt: attempt.index,
    chapterBriefMaxAttempts: attempt.maxAttempts,
    ...(attempt.schemaRepair ? { chapterBriefSchemaRepair: true } : {})
  };
}

export type GenerateTextOptions = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  purpose?: string;
  projectId?: string;
  providerCallMetadata?: ProviderCallMetadata;
  onOutputTextChunk?: (chunk: string) => void | Promise<void>;
  /**
   * Best-effort cancellation of the in-flight provider request. Adapters that
   * can pass it to their HTTP client do; the rest ignore it. Without this a
   * user stop was only observed *between* calls, so a 64k-token whole-book
   * draft ran to completion — and was billed — after the stop landed.
   */
  signal?: AbortSignal;
};

export type GenerateJsonOptions<T> = GenerateTextOptions & {
  schema: ZodType<T>;
};

/** Schema of a tool exposed to the model; adapters convert it to JSON Schema. */
export type ToolDefinition<TArgs = unknown> = {
  name: string;
  description: string;
  parameters: ZodType<TArgs>;
};

export type ToolChoice = "auto" | "required";

export type GenerateWithToolsOptions = GenerateTextOptions & {
  tools: ToolDefinition[];
  /** "required" forces a tool call when the provider supports it; defaults to "auto". */
  toolChoice?: ToolChoice | undefined;
};

export type Usage = {
  promptTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheHitTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  /** Billed reasoning tokens inside output_tokens; not added again to cost. */
  reasoningTokens?: number | undefined;
};

export type TextResult = {
  text: string;
  model: string;
  provider: string;
  usage?: Usage;
};

export type JsonResult<T> = TextResult & {
  data: T;
};

/**
 * One assistant turn from a tools-enabled call: the model either requested
 * tool calls (toolCalls non-empty, text usually empty) or answered with text.
 */
export type ToolCallsResult = TextResult & {
  toolCalls: ToolCall[];
};

export type BoundTextModelCall = {
  adapter: TextModelAdapter;
  selection?: TextModelSelection | undefined;
};

export interface TextModelAdapter {
  generateText(options: GenerateTextOptions): Promise<TextResult>;
  generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>>;
  streamText(options: GenerateTextOptions): AsyncGenerator<string>;
  generateWithTools(options: GenerateWithToolsOptions): Promise<ToolCallsResult>;
  /** Resolve a live router once so every retry of this logical call stays pinned. */
  bindForCall?(purpose: string | undefined): Promise<BoundTextModelCall>;
}

export async function bindTextModelCall(
  adapter: TextModelAdapter,
  purpose: string | undefined
): Promise<BoundTextModelCall> {
  return adapter.bindForCall ? adapter.bindForCall(purpose) : { adapter };
}

export type ResearchQuery = {
  query: string;
  projectId?: string | undefined;
  purpose?: string | undefined;
};

export type ResearchResult = {
  query: string;
  summary: string;
  sources: Array<{
    title: string;
    url?: string | undefined;
    summary: string;
    publishedAt?: string | undefined;
  }>;
};

export interface ResearchAdapter {
  search(query: ResearchQuery): Promise<ResearchResult>;
}

export type ImageRequest = {
  prompt: string;
  projectId?: string | undefined;
  pageId?: string | undefined;
  referenceImagePaths?: string[] | undefined;
  /**
   * The same prompt, said again for the references a layer below the caller
   * actually attached.
   *
   * `prompt` and `referenceImagePaths` are not independent, and nothing in
   * `prompt: string` says so. The sentences a caller writes about an
   * attachment are *indexed* — "use the 5 attached character reference images
   * as the authoritative design source", "the last 2 reference images are the
   * reader's own saved artwork for Ada and Bea … match it exactly" — so
   * shortening the array under a fixed prompt does not drop information, it
   * re-points those sentences at different pictures. The model is then told
   * one character's sheet is another character's face and matches it exactly:
   * a wrong face, silently, on a path with no reference-image quality signal.
   *
   * So a caller that attaches references hands over the way to state them
   * again for a shorter list, and `FallbackImageAdapter.refitForFallback` is
   * the layer that calls it. A caller that omits it gets **no** partial
   * attachment: an unre-statable trim sends the picture out with none, which
   * loses the sheets but cannot mis-attribute a face.
   */
  promptForReferenceImages?: ((attached: readonly string[]) => string) | undefined;
  aspectRatio?: string | undefined;
};

export type ImageResult = {
  provider: string;
  model: string;
  mimeType: string;
  data?: Buffer | undefined;
  url?: string | undefined;
  revisedPrompt?: string | undefined;
  fallback?: ImageFallbackMetadata | undefined;
  copyrightRewrite?: ImageCopyrightRewrite | undefined;
};

/**
 * Present when an IP filter refused the caller's prompt and the picture was
 * drawn from a rewritten one instead. It rides the result so the asset row can
 * record it: the stored `prompt` is what the book asked for, and this is what
 * was actually drawn, which is the difference between an original stand-in and
 * a book that quietly is not illustrated the way it says it is.
 */
export type ImageCopyrightRewrite = {
  /** The provider's own word for the block that triggered the rewrite. */
  refusalReason: string;
  /**
   * Protected names removed from the prompt **and verified absent from
   * everything the render was drawn from**.
   *
   * Empty whenever `unverifiedReferenceImages` is set, which is the whole of
   * the difference between the two: `survivingReplacedNames`
   * (`generation/copyrightSafeImagePrompt.ts`) re-reads the rewritten prompt
   * and can say a name is gone from it, and nothing anywhere can say a name is
   * gone from an attached reference sheet.
   */
  replaced: string[];
  /**
   * How many reference images **the render that produced these bytes was
   * handed**, present only when it was handed any.
   *
   * The retry rewrites the prompt and nothing else, so the sheets travel — they
   * are what keeps a character looking like itself from one page to the next.
   * But a book seeded from a library character whose portrait *is* the
   * protected one, or a page whose `CHARACTER_REFERENCE` sheet was drawn from
   * it, hands the second provider the likeness in pixels with generic text
   * beside it; the render can then land, and land as the very character the
   * prompt no longer names. So the claim narrows to what was checked and this
   * key says why it narrowed. The run log's
   * `image.generate.copyright_rewrite` keeps the model's own `replaced` list
   * and the reference paths, which is where the unverified half went.
   *
   * **The render, not the request**, because the two come apart on exactly the
   * path that matters: the retry deletes `promptForReferenceImages`, so a
   * rewritten render that falls over to the second provider reaches
   * `FallbackImageAdapter.refitForFallback` with no re-stater and goes out with
   * the attachment emptied. Counting the request there recorded five unread
   * likeness inputs over a picture drawn from the rewritten text alone — and
   * dropped the `replaced` list in the one case where `survivingReplacedNames`
   * had fully earned it. {@link ImageFallbackMetadata.references} is what the
   * layer that made the cut says about it.
   */
  unverifiedReferenceImages?: number | undefined;
  prompt: string;
};

export type ImageFallbackAttempt = {
  provider: string;
  model: string;
  error?: Record<string, unknown> | undefined;
};

/**
 * How many character reference images the fallback render actually went out
 * with, when that is fewer than the caller attached.
 *
 * A quality drop nobody can see is the thing this record exists to prevent: a
 * page drawn without the sheets that keep a character looking like itself is a
 * real loss, just a smaller one than the book failing, and the run log is the
 * only place anyone would find it. It rides
 * {@link ImageFallbackMetadata.references} as well as the run-log event,
 * because a caller that has to speak for what the render read — the copyright
 * retry's provenance row — cannot see the cut from anywhere else.
 */
export type ImageFallbackReferenceTrim = {
  /** References the caller attached, sized against the primary's budget. */
  requested: number;
  /** References the fallback render was handed. */
  sent: number;
  dropped: number;
  /** What the fallback adapter declared it can take. */
  limit: number;
  /**
   * Whether the caller could state its prompt again for what was sent.
   *
   * `false` is why `sent` may be 0 under a non-zero `limit`: a prompt making
   * indexed claims about an attachment nobody can re-state is worse partly
   * honoured than not honoured at all. It is also why the prompt that went out
   * is not the prompt that came in — a `false` here means
   * `NO_REFERENCE_IMAGES_CORRECTION` was appended to it.
   */
  restated: boolean;
};

export type ImageFallbackMetadata = {
  used: true;
  primary: ImageFallbackAttempt & { error: Record<string, unknown> };
  fallback: ImageFallbackAttempt;
  /**
   * Present only when the fallback attempt could not be handed the attachment
   * the caller sized against the primary.
   *
   * Absent therefore means "the fallback render got what was asked for", which
   * is the reading every consumer needs: what a picture was drawn from is not
   * knowable from the request once a second adapter with a smaller budget is
   * involved, and this is the only place the layer that made the cut says so.
   */
  references?: ImageFallbackReferenceTrim | undefined;
};

export type ImageAdapterCapabilities = {
  supportsReferenceImages: boolean;
  maxReferenceImages: number;
};

export interface ImageAdapter {
  capabilities?(): ImageAdapterCapabilities;
  generateImage(request: ImageRequest): Promise<ImageResult>;
}

/**
 * What an image adapter that declares no `capabilities()` is assumed to
 * support: nothing.
 *
 * `capabilities()` is optional, so every wrapper that forwards it — the
 * provider fallback, the run-log decorator, the copyright-safe retry — and
 * every caller that sizes a reference-sheet attachment from it has to answer
 * for a delegate that does not implement the method. The answer decides how
 * many character reference sheets a render attaches, so it belongs beside the
 * interface it is the default for rather than being spelled out again at each
 * wrapper, where a later change to it would have to be found four times.
 */
export function imageAdapterCapabilities(adapter: ImageAdapter): ImageAdapterCapabilities {
  return adapter.capabilities?.() ?? { supportsReferenceImages: false, maxReferenceImages: 0 };
}

export interface EmbeddingAdapter {
  embed(text: string): Promise<number[]>;
}

export type SpeechRequest = {
  text: string;
  voice: string;
  /** Provider-neutral narrator persona selected by the listener. */
  narrator?: string | undefined;
  /** Human-readable language name, used as pronunciation guidance. */
  language?: string | undefined;
  /** Performance direction — how to read, never what to read. */
  stylePrompt?: string | undefined;
  projectId?: string | undefined;
};

export type SpeechResult = {
  provider: string;
  model: string;
  /** Raw PCM16 with its format, so consecutive results can be joined exactly. */
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  durationMs: number;
  /** Set when the provider refused the styled request and the text was read without direction. */
  stylePromptDropped?: boolean | undefined;
};

export interface SpeechAdapter {
  synthesize(request: SpeechRequest): Promise<SpeechResult>;
}
