import {
  bindTextModelCall,
  type BoundTextModelCall,
  type ChatMessage,
  type GenerateJsonOptions,
  type GenerateTextOptions,
  type GenerateWithToolsOptions,
  type TextModelAdapter
} from "./adapters/types.js";

/**
 * The sexual-content rule every text-generation prompt carries while the
 * operator's filter is on (`SafetySettingsRevision.sexualContentFilterEnabled`,
 * default on). It is injected where calls leave the process — the worker's
 * `LoggingTextModelAdapter`, the API's model factories and the voice persona —
 * never written into a prompt builder, so no prompt can be added without it.
 *
 * Fixed English text, **prepended** to the first system message: the same
 * prefix on every call keeps provider prompt caching working, and a system
 * prompt's own last sentence — the one that names a JSON reply's keys — stays
 * last. A call with no system message gets the rule as one.
 */
export const SEXUAL_CONTENT_RULE =
  "Content rule (always applies): never write sexually explicit content of any kind. " +
  "Never write anything sexual or physically romantic involving anyone under 18, including characters " +
  "whose age is implied by a school grade or by words such as \"teen\" or \"teenager\". " +
  "If a request asks for such content, write the non-sexual version instead and keep every relationship age-appropriate.";

/** The messages with the rule in front of the first system message; unchanged when off or already there. */
export function withSexualContentRuleMessages(messages: ChatMessage[], enabled: boolean): ChatMessage[] {
  if (!enabled) {
    return messages;
  }
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: SEXUAL_CONTENT_RULE }, ...messages];
  }
  const system = messages[systemIndex]!;
  if (system.content.includes(SEXUAL_CONTENT_RULE)) {
    return messages;
  }
  const next = [...messages];
  next[systemIndex] = { ...system, content: `${SEXUAL_CONTENT_RULE}\n\n${system.content}` };
  return next;
}

/** A call's options with the rule applied; the same object when nothing changes. */
export function withSexualContentRule<T extends GenerateTextOptions>(options: T, enabled: boolean): T {
  const messages = withSexualContentRuleMessages(options.messages, enabled);
  return messages === options.messages ? options : { ...options, messages };
}

/** A system instruction string (a voice persona) with the rule in front of it. */
export function withSexualContentRuleText(instructions: string, enabled: boolean): string {
  if (!enabled || instructions.includes(SEXUAL_CONTENT_RULE)) {
    return instructions;
  }
  return instructions.trim() ? `${SEXUAL_CONTENT_RULE}\n\n${instructions}` : SEXUAL_CONTENT_RULE;
}

/**
 * A text model whose every call carries the rule while `enabled()` says so.
 * It wraps at `bindForCall` too, because `generateJsonWithRetry` binds once
 * and calls the *bound* adapter for every attempt and repair — a wrapper only
 * around the outer methods would see none of them (the `SourceAwareTextModel`
 * and `withInlineProviderUsage` pattern).
 */
export function withSexualContentRuleModel(delegate: TextModelAdapter, enabled: () => Promise<boolean>): TextModelAdapter {
  return new SexualContentRuleTextModel(delegate, enabled);
}

class SexualContentRuleTextModel implements TextModelAdapter {
  constructor(
    private readonly delegate: TextModelAdapter,
    private readonly enabled: () => Promise<boolean>
  ) {}

  async bindForCall(purpose: string | undefined): Promise<BoundTextModelCall> {
    const bound = await bindTextModelCall(this.delegate, purpose);
    return { ...bound, adapter: new SexualContentRuleTextModel(bound.adapter, this.enabled) };
  }

  setPurposeOverridesEnabled(value: boolean): void {
    const inner = this.delegate as { setPurposeOverridesEnabled?: (enabled: boolean) => void };
    inner.setPurposeOverridesEnabled?.(value);
  }

  async generateText(options: GenerateTextOptions) {
    return this.delegate.generateText(await this.prepared(options));
  }

  async generateJson<T>(options: GenerateJsonOptions<T>) {
    return this.delegate.generateJson(await this.prepared(options));
  }

  async generateWithTools(options: GenerateWithToolsOptions) {
    return this.delegate.generateWithTools(await this.prepared(options));
  }

  async *streamText(options: GenerateTextOptions) {
    yield* this.delegate.streamText(await this.prepared(options));
  }

  private async prepared<T extends GenerateTextOptions>(options: T): Promise<T> {
    return withSexualContentRule(options, await this.enabled());
  }
}
