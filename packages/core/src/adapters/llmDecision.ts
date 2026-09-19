import { assertDecisionEvaluationRequest, validateDecisionEvaluation, type DecisionEvaluationRequest, type DecisionAnswer } from "./decisionEvaluation.js";
import { z } from "zod";
import type { TextModelAdapter } from "./types.js";
import { throwWithProviderUsage } from "./json.js";
import { assertDecisionRequest, decisionMessages, validateDecisionChoice, type DecisionModelAdapter, type DecisionRequest } from "./decisions.js";

/** One physical text call. The decision route owns retries and fallback. */
export class LlmDecisionAdapter implements DecisionModelAdapter {
  constructor(private readonly text: TextModelAdapter) {}

  async evaluate(request: DecisionEvaluationRequest) {
    assertDecisionEvaluationRequest(request);
    const shape = Object.fromEntries(request.questions.map((question) => [question.id,
      question.type === "choice" ? z.object({ type: z.literal("choice"), selectedOption: z.enum(question.options.map((option) => option.id)) })
        : question.type === "boolean" ? z.object({ type: z.literal("boolean"), probability: z.number().min(0).max(1) })
        : z.object({ type: z.literal("score"), score: z.number().min(0).max(question.levels.length - 1) })
    ]));
    const result = await this.text.generateJson({
      purpose: request.purpose, ...(request.signal ? { signal: request.signal } : {}), temperature: 0.1, maxTokens: 1800,
      schema: z.object({ answers: z.object(shape).strict() }).strict(),
      messages: [{ role: "system", content: "Answer every typed question independently against the shared context. Return JSON answers keyed by exact question ID, with the specified type and selectedOption, probability, or score (expected zero-based level, which may be fractional)." },
        { role: "user", content: JSON.stringify({ context: request.context, questions: request.questions }) }]
    });
    if (request.signal?.aborted) throwWithProviderUsage(request.signal.reason, result);
    return validateDecisionEvaluation(request, { ...result, answers: result.data.answers as Record<string, DecisionAnswer> });
  }

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
