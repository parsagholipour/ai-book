import type { GenerateJsonOptions, GenerateTextOptions, GenerateWithToolsOptions, TextModelAdapter, Usage } from "@book-maker/core";
export type SourceUsage = { summaryCalls: number; embeddingCalls: number; ocrCalls: number; inputTokens: number; outputTokens: number; elapsedMs: number; extractedCharacters: number };
export function sourceUsageFromStored(value: unknown): SourceUsage {
  const usage: SourceUsage = { summaryCalls: 0, embeddingCalls: 0, ocrCalls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0, extractedCharacters: 0 };
  if (value && typeof value === "object") for (const key of Object.keys(usage) as Array<keyof SourceUsage>) {
    const stored = (value as Record<string, unknown>)[key];
    if (typeof stored === "number" && Number.isFinite(stored)) usage[key] = stored;
  }
  return usage;
}
export class SourceUsageModel implements TextModelAdapter {
  constructor(private readonly inner: TextModelAdapter, private readonly usage: SourceUsage) {}
  private record(usage?: Usage) { this.usage.inputTokens += usage?.promptTokens ?? 0; this.usage.outputTokens += usage?.outputTokens ?? 0; }
  async generateJson<T>(options: GenerateJsonOptions<T>) { this.usage.summaryCalls++; const result = await this.inner.generateJson(options); this.record(result.usage); return result; }
  async generateText(options: GenerateTextOptions) { this.usage.summaryCalls++; const result = await this.inner.generateText(options); this.record(result.usage); return result; }
  async generateWithTools(options: GenerateWithToolsOptions) { this.usage.summaryCalls++; const result = await this.inner.generateWithTools(options); this.record(result.usage); return result; }
  async *streamText(options: GenerateTextOptions) { yield* this.inner.streamText(options); }
}
