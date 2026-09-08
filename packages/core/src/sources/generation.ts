import { bindTextModelCall, type GenerateJsonOptions, type GenerateTextOptions, type GenerateWithToolsOptions, type TextModelAdapter } from "../adapters/types.js";
import { SOURCE_INSTRUCTIONS, sourceCitation, type SourcePassage, type SourceService } from "./types.js";

/** Shared by every generation stage, including composed chapters and review calls. */
export class SourceAwareTextModel implements TextModelAdapter {
  private readonly returned = new WeakMap<GenerateTextOptions, Set<string>>();
  constructor(private readonly delegate: TextModelAdapter, private readonly service: () => Promise<SourceService>, private readonly evidence = new Map<string, SourcePassage[]>()) {}
  async bindForCall(purpose: string | undefined) {
    const bound = await bindTextModelCall(this.delegate, purpose);
    return { ...bound, adapter: new SourceAwareTextModel(bound.adapter, this.service, this.evidence) };
  }
  setPurposeOverridesEnabled(enabled: boolean) {
    const delegate = this.delegate as TextModelAdapter & { setPurposeOverridesEnabled?: (enabled: boolean) => void };
    delegate.setPurposeOverridesEnabled?.(enabled);
  }
  async *streamText(options: GenerateTextOptions) {
    const prepared = await this.withEvidence(options);
    let text = "";
    for await (const chunk of this.delegate.streamText(prepared)) text += chunk;
    yield this.validate(text, prepared);
  }
  async generateText(options: GenerateTextOptions) {
    const prepared = await this.withEvidence(options);
    const result = await this.delegate.generateText(prepared);
    return { ...result, text: this.validate(result.text, prepared) };
  }
  async generateJson<T>(options: GenerateJsonOptions<T>) {
    const prepared = await this.withEvidence(options);
    const result = await this.delegate.generateJson(prepared);
    const clean = (value: unknown): unknown => typeof value === "string" ? this.validate(value, prepared)
      : Array.isArray(value) ? value.map(clean)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clean(entry)])) : value;
    const data = options.schema.parse(clean(result.data));
    return { ...result, data, text: JSON.stringify(data) };
  }
  private validate(text: string, options: GenerateTextOptions): string {
    return text.replace(/\[source:[^\]\n]+\]/g, (reference) => this.returned.get(options)?.has(reference) ? reference : "[unverified source]");
  }
  async generateWithTools(options: GenerateWithToolsOptions) {
    const prepared = await this.withEvidence(options);
    const result = await this.delegate.generateWithTools(prepared);
    return { ...result, text: this.validate(result.text, prepared), toolCalls: result.toolCalls.map((call) => ({ ...call, arguments: JSON.parse(this.validate(JSON.stringify(call.arguments ?? {}), prepared)) })) };
  }
  private async withEvidence<T extends GenerateTextOptions>(options: T): Promise<T> {
    const service = await this.service();
    const user = options.messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n");
    const query = user.slice(-8000);
    let passages = this.evidence.get(query);
    if (!passages) {
      passages = await service.search(query);
      this.evidence.set(query, passages);
      if (this.evidence.size > 24) this.evidence.delete(this.evidence.keys().next().value!);
    }
    // A reviewer sees the exact sources cited by the candidate, even when a
    // different query would rank another passage first.
    const cited = await Promise.all([...user.matchAll(/\[source:([^:\]\s]+):(\d+):(\d+)\]/g)].slice(0, 30).map((match) => service.read(match[1]!, Number(match[2]), Number(match[3]))));
    const selected = [...new Map([...passages, ...cited.filter((p): p is SourcePassage => p !== null)].map((p) => [sourceCitation(p), p])).values()];
    const fullOverview = await service.overview();
    const overview = fullOverview.map(({ sections, ...document }) => ({
      ...document,
      totalSections: sections.length,
      // The hierarchical document summary covers every section. Additional
      // section detail follows the passages relevant to this particular stage.
      relevantSections: sections.filter((section) => selected.some((passage) => passage.sourceId === document.sourceId && passage.ordinal === section.ordinal))
    }));
    const prepared = { ...options, messages: [
      ...options.messages,
      { role: "system", content: SOURCE_INSTRUCTIONS + " For generation, relevant evidence is supplied below; source tools need not be called. Ground factual claims in these passages and retain their source citation markers with the claims. An empty researchNotes array means no PUBLIC web sources; it does not make these privateSourcePassages absent or their citations optional. In generated manuscript markdown, place the exact citation string after each paragraph using a supplied source's names, dates, numbers or other facts. This also applies to fictional source bibles. Copy citation strings literally, including brackets; do not replace them with filenames or put them only in summaries. Reviewers must check claims against the cited evidence, flag missing source citations and unsupported assertions, and preserve valid markers during rewrites. Private citations are separate from the public web Sources list." },
      { role: "user", content: JSON.stringify({ privateSourceOverview: overview, privateSourcePassages: selected.map((passage) => ({ ...passage, citation: sourceCitation(passage) })) }) }
    ] } as T;
    this.returned.set(prepared, new Set(selected.map(sourceCitation)));
    return prepared;
  }
}
