import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate } from "ai";
import { assertDecisionRequest, InvalidDecisionError, validateDecisionChoice, type DecisionModelAdapter, type DecisionRequest, type DecisionResult } from "./decisions.js";
import { JEV_SELECTION } from "./generationTextModelRouting.js";
import { isCancellationError, ProviderHttpError } from "./retry.js";
import { throwWithProviderUsage } from "./json.js";

/** All dependencies on the experimental evaluation API stay in this module. */
export class JevDecisionAdapter implements DecisionModelAdapter {
  constructor(private readonly apiKey: string | undefined, private readonly fetch?: typeof globalThis.fetch) {}

  async choose(request: DecisionRequest): Promise<DecisionResult> {
    assertDecisionRequest(request);
    if (!this.apiKey?.trim()) throw new Error("VERCEL_AI_GATEWAY_API_KEY is required for Jev.");
    let received: DecisionResult | undefined;
    let httpFailure: { status: number; retryAfterMs?: number } | undefined;
    const gateway = createGateway({ apiKey: this.apiKey, fetch: async (url, init) => {
      const response = await (this.fetch ?? globalThis.fetch)(url, init);
      // Gateway schema validation can reject even before doEvaluate returns.
      // Salvage exact usage from a successful HTTP response in that case too.
      if (response.ok) {
        const body: unknown = await response.clone().json().catch(() => undefined);
        received = receivedDecision(body);
      } else if (!httpFailure) {
        const retryAfterMs = retryAfterMsFromResponse(response);
        httpFailure = { status: response.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
      }
      return response;
    } });
    const model = gateway.evaluationModel(JEV_SELECTION.model);
    try {
      const result = await evaluate({
        model,
        state: request.context,
        questions: { choice: {
          type: "choice",
          instructions: request.instructions,
          criteria: Object.fromEntries(request.options.map((option) => [option.id, option.description]))
        } },
        maxRetries: 0,
        ...(request.signal ? { abortSignal: request.signal } : {})
      });
      return validateDecisionChoice(request, {
        ...JEV_SELECTION,
        selectedOption: result.answers.choice.choice,
        probabilities: result.answers.choice.probabilities,
        usage: { promptTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens ?? 0 }
      });
    } catch (error) {
      // Cancellation keeps its identity and never becomes a fallback verdict.
      const failure = request.signal?.aborted ? request.signal.reason : error;
      if (request.signal?.aborted || isCancellationError(failure)) {
        if (received) throwWithProviderUsage(failure, received);
        throw failure;
      }
      if (received && !(error instanceof InvalidDecisionError)) {
        throw new InvalidDecisionError("Jev returned an invalid evaluation response.", received);
      }
      // ProviderHttpError, not a bare SDK Error: status and Retry-After have to
      // travel as fields, matching sibling adapters.
      if (!(error instanceof InvalidDecisionError) && !(error instanceof ProviderHttpError) && httpFailure) {
        throw new ProviderHttpError(error instanceof Error ? error.message : String(error), {
          status: httpFailure.status,
          ...(httpFailure.retryAfterMs === undefined ? {} : { retryAfterMs: httpFailure.retryAfterMs })
        });
      }
      throw error;
    }
  }
}

function receivedDecision(body: unknown): DecisionResult | undefined {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const response = record(body);
  const usage = record(response?.usage);
  const tokenCount = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  const choice = record(record(response?.answers)?.choice);
  if (!response) return undefined;
  const probabilities = record(choice?.probabilities);
  const promptTokens = tokenCount(usage?.inputTokens);
  return {
    ...JEV_SELECTION,
    selectedOption: typeof choice?.choice === "string" ? choice.choice : "",
    ...(probabilities && Object.values(probabilities).every((value) => typeof value === "number")
      ? { probabilities: probabilities as Record<string, number> } : {}),
    usage: {
      ...(promptTokens === undefined ? {} : { promptTokens }),
      outputTokens: tokenCount(usage?.outputTokens) ?? 0
    }
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
