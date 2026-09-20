import { z } from "zod";
import type { TextModelAdapter } from "./types.js";
import { throwWithProviderUsage } from "./json.js";
import { assertDecisionRequest, decisionMessages, validateDecisionChoice, type DecisionModelAdapter, type DecisionRequest } from "./decisions.js";

/** One physical text call. The decision route owns retries and fallback. */
export class LlmDecisionAdapter implements DecisionModelAdapter {
  constructor(private readonly text: TextModelAdapter) {}

  async choose(request: DecisionRequest) {
    assertDecisionRequest(request);
    const result = await this.text.generateJson({
      purpose: request.purpose,
      ...(request.signal ? { signal: request.signal } : {}),
      temperature: 0.1,
      maxTokens: 600,
      schema: z.object({ selectedOption: z.string(), explanation: z.string().optional() }),
      messages: [
        ...decisionMessages(request),
        { role: "system", content: 'Return JSON {"selectedOption":"<exact option ID>","explanation":"<one sentence>"}.' }
      ]
    });
    if (request.signal?.aborted) throwWithProviderUsage(request.signal.reason, result);
    return validateDecisionChoice(request, {
      selectedOption: result.data.selectedOption,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      ...(result.data.explanation ? { explanation: result.data.explanation } : {})
    });
  }
}
