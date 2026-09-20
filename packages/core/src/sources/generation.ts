import type { DecisionRequest } from "../adapters/decisions.js";
import { bindTextModelCall, type GenerateJsonOptions, type GenerateTextOptions, type GenerateWithToolsOptions, type TextModelAdapter } from "../adapters/types.js";
import { SOURCE_INSTRUCTIONS, sourceCitation, type SourcePassage, type SourceService } from "./types.js";

/** Shared by every generation stage, including composed chapters and review calls. */
export class SourceAwareTextModel implements TextModelAdapter {
  private readonly sources: SourceEvidenceContext;
  constructor(private readonly delegate: TextModelAdapter, private readonly service: () => Promise<SourceService>, private readonly evidence = new Map<string, SourcePassage[]>(), preparedSources?: SourceEvidenceContext) { this.sources = preparedSources ?? new SourceEvidenceContext(service, evidence); }
  async bindForCall(purpose: string | undefined) {
    const bound = await bindTextModelCall(this.delegate, purpose);
    return { ...bound, adapter: new SourceAwareTextModel(bound.adapter, this.service, this.evidence, this.sources) };
  }
  async prepareReviewContext(options: GenerateTextOptions) {
    const sources = await this.sources.forReview(options);
    const prepared = await sources.prepare(options);
    return { messages: prepared.messages, textModel: new SourceAwareTextModel(this.delegate, this.service, this.evidence, sources), hasSourcePassages: sources.hasPreparedPassages() };
  }
  setPurposeOverridesEnabled(enabled: boolean) {
    const delegate = this.delegate as TextModelAdapter & { setPurposeOverridesEnabled?: (enabled: boolean) => void };
    delegate.setPurposeOverridesEnabled?.(enabled);
  }
  async *streamText(options: GenerateTextOptions) {
    const prepared = await this.sources.prepare(options);
    let text = "";
    for await (const chunk of this.delegate.streamText(prepared)) text += chunk;
    yield this.sources.validate(text, prepared);
  }
  async generateText(options: GenerateTextOptions) {
    const prepared = await this.sources.prepare(options);
    const result = await this.delegate.generateText(prepared);
    return { ...result, text: this.sources.validate(result.text, prepared) };
  }
  async generateJson<T>(options: GenerateJsonOptions<T>) {
    const prepared = await this.sources.prepare(options);
    const result = await this.delegate.generateJson(prepared);
    const clean = (value: unknown): unknown => typeof value === "string" ? this.sources.validate(value, prepared)
      : Array.isArray(value) ? value.map(clean)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clean(entry)])) : value;
    const data = options.schema.parse(clean(result.data));
    return { ...result, data, text: JSON.stringify(data) };
  }
  async generateWithTools(options: GenerateWithToolsOptions) {
    const prepared = await this.sources.prepare(options);
    const result = await this.delegate.generateWithTools(prepared);
    return { ...result, text: this.sources.validate(result.text, prepared), toolCalls: result.toolCalls.map((call) => ({ ...call, arguments: JSON.parse(this.sources.validate(JSON.stringify(call.arguments ?? {}), prepared)) })) };
  }
}

/** Shared evidence preparation for text generation and finite decisions. */
type EvidencePack = { overview: unknown; selected: SourcePassage[]; citations: string[] };
export class SourceEvidenceContext {
  private readonly returned = new WeakMap<GenerateTextOptions, Set<string>>();
  constructor(private readonly service: () => Promise<SourceService>, private readonly evidence = new Map<string, SourcePassage[]>(), private readonly prepared?: EvidencePack) {}
  validate(text: string, options: GenerateTextOptions): string {
    return text.replace(/\[source:[^\]\n]+\]/g, (reference) => this.returned.get(options)?.has(reference) ? reference : "[unverified source]");
  }
  async prepare<T extends GenerateTextOptions>(options: T): Promise<T> {
    const user = options.messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n");
    options.signal?.throwIfAborted();
    const { overview, selected, citations } = this.prepared ?? await this.loadEvidence(user);
    options.signal?.throwIfAborted();
    const prepared = { ...options, messages: [...options.messages, ...this.evidenceMessages(overview, selected)] } as T;
    this.returned.set(prepared, new Set(citations));
    return prepared;
  }
  async forReview(options: GenerateTextOptions): Promise<SourceEvidenceContext> {
    options.signal?.throwIfAborted();
    const query = options.messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n");
    const pack = this.prepared ?? await this.loadEvidence(query);
    options.signal?.throwIfAborted();
    return new SourceEvidenceContext(this.service, this.evidence, pack);
  }
  async prepareDecision(request: DecisionRequest): Promise<DecisionRequest> {
    request.signal?.throwIfAborted();
    if (request.sourceContextPrepared) return request;
    const query = JSON.stringify({ context: request.context, options: request.options });
    const { overview, selected } = await this.loadEvidence(query);
    request.signal?.throwIfAborted();
    return { ...request, context: request.context + "\n" + this.evidenceMessages(overview, selected).map((message) => message.content).join("\n") };
  }
  hasPreparedPassages(): boolean { return Boolean(this.prepared?.selected.length); }
  private async loadEvidence(query: string) {
    const service = await this.service();
    const search = query.slice(-8000);
    let passages = this.evidence.get(search);
    if (!passages) {
      passages = await service.search(search);
      this.evidence.set(search, passages);
      if (this.evidence.size > 24) this.evidence.delete(this.evidence.keys().next().value!);
    }
    // A reviewer sees the exact sources cited by the candidate, even when a
    // different query would rank another passage first.
    const cited = await Promise.all([...new Map([...query.matchAll(/\[source:([^:\]\s]+):(\d+):(\d+)\]/g)].map((match) => [match[0], match])).values()].slice(0, 30).map((match) => service.read(match[1]!, Number(match[2]), Number(match[3]))));
    const selected = [...new Map([...passages, ...cited.filter((p): p is SourcePassage => p !== null)].map((p) => [sourceCitation(p), p])).values()];
    const fullOverview = await service.overview();
    const overview = fullOverview.map(({ sections, ...document }) => ({
      ...document,
      totalSections: sections.length,
      // The hierarchical document summary covers every section. Additional
      // section detail follows the passages relevant to this particular stage.
      relevantSections: sections.filter((section) => selected.some((passage) => passage.sourceId === document.sourceId && passage.ordinal === section.ordinal))
    }));
    return { overview, selected, citations: selected.map(sourceCitation) };
  }
  private evidenceMessages(overview: unknown, selected: SourcePassage[]) {
    return [
      { role: "system" as const, content: SOURCE_INSTRUCTIONS + " For generation, relevant evidence is supplied below; source tools need not be called. Ground factual claims in these passages and retain their source citation markers with the claims. An empty researchNotes array means no PUBLIC web sources; it does not make these privateSourcePassages absent or their citations optional. In generated manuscript markdown, place the exact citation string after each paragraph using a supplied source's names, dates, numbers or other facts. This also applies to fictional source bibles. Copy citation strings literally, including brackets; do not replace them with filenames or put them only in summaries. Reviewers must check claims against the cited evidence, flag missing source citations and unsupported assertions, and preserve valid markers during rewrites. Private citations are separate from the public web Sources list." },
      { role: "user" as const, content: JSON.stringify({ privateSourceOverview: overview, privateSourcePassages: selected.map((passage) => ({ ...passage, citation: sourceCitation(passage) })) }) }
    ];
  }
}
