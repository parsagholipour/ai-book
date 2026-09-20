import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate, type Experimental_EvaluationQuestion as EvaluationQuestion } from "ai";
import { assertDecisionRequest, InvalidDecisionError, validateDecisionChoice, type DecisionModelAdapter, type DecisionRequest, type DecisionResult } from "./decisions.js";
import { assertDecisionEvaluationRequest, InvalidDecisionEvaluationError, validateDecisionEvaluation, type DecisionEvaluationRequest, type DecisionEvaluationResult, type DecisionAnswer } from "./decisionEvaluation.js";
import { JEV_SELECTION } from "./generationTextModelRouting.js";
import { isCancellationError, ProviderHttpError } from "./retry.js";
import { throwWithProviderUsage } from "./json.js";

/**
 * How long one Jev attempt may take before it is given up as a provider failure. Jev answers in
 * 0.5–1.5 s (the slowest success across three live evaluations was 6.6 s), and its retries and
 * fallback are the recovery for an attempt that does not; without a deadline of its own, one
 * attempt in the second 100-page book sat on a gateway "Request timed out" for 240 s, and the
 * chapter's acceptance gate — a call whose whole point is to be fast — waited four minutes for it.
 */
export const JEV_ATTEMPT_TIMEOUT_MS = 20_000;

/** All dependencies on the experimental evaluation API stay in this module. */
export class JevDecisionAdapter implements DecisionModelAdapter {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetch?: typeof globalThis.fetch,
    private readonly attemptTimeoutMs: number = JEV_ATTEMPT_TIMEOUT_MS
  ) {}

  async choose(request: DecisionRequest): Promise<DecisionResult> {
    assertDecisionRequest(request);
    try {
      const result = await this.evaluate({ ...request, questions: [{ id: "choice", type: "choice", instructions: request.instructions, options: request.options }] });
      const answer = result.answers.choice;
      return validateDecisionChoice(request, { provider: result.provider, model: result.model, usage: result.usage, selectedOption: answer?.type === "choice" ? answer.selectedOption : "", probabilities: answer?.type === "choice" ? answer.probabilities : undefined });
    } catch (error) {
      if (error instanceof InvalidDecisionEvaluationError) {
        const answer = error.result.answers.choice;
        throw new InvalidDecisionError(error.message, { ...error.result, selectedOption: answer?.type === "choice" ? answer.selectedOption : "", probabilities: answer?.type === "choice" ? answer.probabilities : undefined });
      }
      throw error;
    }
  }

  async evaluate(request: DecisionEvaluationRequest): Promise<DecisionEvaluationResult> {
    assertDecisionEvaluationRequest(request);
    if (!this.apiKey?.trim()) throw new Error("VERCEL_AI_GATEWAY_API_KEY is required for Jev.");
    let received: DecisionEvaluationResult | undefined;
    let httpFailure: { status: number; retryAfterMs?: number } | undefined;
    const gateway = createGateway({ apiKey: this.apiKey, fetch: async (url, init) => {
      const response = await (this.fetch ?? globalThis.fetch)(url, init);
      // Gateway schema validation can reject even before doEvaluate returns.
      // Salvage exact usage from a successful HTTP response in that case too.
      if (response.ok) {
        const body: unknown = await response.clone().json().catch(() => undefined);
        received = receivedEvaluation(body);
      } else if (!httpFailure) {
        const retryAfterMs = retryAfterMsFromResponse(response);
        httpFailure = { status: response.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
      }
      return response;
    } });
    const model = gateway.evaluationModel(JEV_SELECTION.model);
    // The attempt's own deadline rides beside the caller's signal. When it fires, the attempt
    // failed like a 504 — recoverable, retried, then handed to the fallback — and is never
    // mistaken for the caller cancelling, which is checked first below.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.attemptTimeoutMs);
    try {
      const result = await evaluate({
        model,
        state: request.context,
        questions: Object.fromEntries(request.questions.map((question): [string, EvaluationQuestion] => [question.id,
          question.type === "choice" ? { type: "choice", instructions: question.instructions, criteria: Object.fromEntries(question.options.map((option) => [option.id, option.description])) }
            : question.type === "score" ? { type: "score", instructions: question.instructions, criteria: question.levels }
            : { type: "boolean", instructions: question.instructions }
        ])),
        maxRetries: 0,
        abortSignal: request.signal ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal
      });
      return validateDecisionEvaluation(request, {
        ...JEV_SELECTION,
        answers: normalizeAnswers(result.answers),
        usage: { promptTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens ?? 0 }
      });
    } catch (error) {
      // Cancellation keeps its identity and never becomes a fallback verdict.
      const failure = request.signal?.aborted ? request.signal.reason : error;
      if (request.signal?.aborted || (isCancellationError(failure) && !deadline.signal.aborted)) {
        if (received) throwWithProviderUsage(failure, received);
        throw failure;
      }
      if (deadline.signal.aborted) {
        throw new ProviderHttpError(`Jev did not answer within ${this.attemptTimeoutMs} ms.`, { status: 504 });
      }
      if (received && !(error instanceof InvalidDecisionEvaluationError)) {
        throw new InvalidDecisionEvaluationError("Jev returned an invalid evaluation response.", received);
      }
      // ProviderHttpError, not a bare SDK Error: status and Retry-After have to
      // travel as fields, matching sibling adapters.
      if (!(error instanceof InvalidDecisionEvaluationError) && !(error instanceof ProviderHttpError) && httpFailure) {
        throw new ProviderHttpError(error instanceof Error ? error.message : String(error), {
          status: httpFailure.status,
          ...(httpFailure.retryAfterMs === undefined ? {} : { retryAfterMs: httpFailure.retryAfterMs })
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeAnswers(answers: unknown): Record<string, DecisionAnswer> {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return {};
  return Object.fromEntries(Object.entries(answers).map(([id, value]) => {
    const answer = value as Record<string, unknown> | null;
    return [id, answer?.type === "choice" ? { ...answer, selectedOption: answer.choice } : answer];
  })) as Record<string, DecisionAnswer>; // All values are checked by validateDecisionEvaluation.
}

function receivedEvaluation(body: unknown): DecisionEvaluationResult | undefined {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const response = record(body);
  const usage = record(response?.usage);
  const tokenCount = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  if (!response) return undefined;
  const promptTokens = tokenCount(usage?.inputTokens);
  return {
    ...JEV_SELECTION,
    answers: normalizeAnswers(response.answers),
    usage: { ...(promptTokens === undefined ? {} : { promptTokens }), outputTokens: tokenCount(usage?.outputTokens) ?? 0 }
  };
}

function retryAfterMsFromResponse(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : undefined;
}
