const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const failed = call => call.metadata?.liveStatus === "failed" || Boolean(call.metadata?.error);
const confirmed = (call, field) => number(call[field]) !== null && call.metadata?.[`${field}Estimated`] !== true &&
  (call.metadata?.[`${field}Estimated`] === false || (number(call.costHint) !== null && call.metadata?.provisional !== true));

/** A fallback shares a logical call ID. Join only a unique physical provider/model
 * attempt; repeated attempts with no request index remain explicitly unresolved. */
export function reconcileGenerationAccounting({ calls, physical, usage, terminal }) {
  const ledger = [...new Map(calls.map((call, index) => [call.id ?? `row-${index}`, call])).values()];
  const textCalls = ledger.filter(call => call.purpose !== "image.generate");
  const candidates = new Map([...physical].map(([key, event]) => [key, textCalls.filter(call =>
    call.metadata?.callId && call.metadata.callId === event.callId && call.generationJobId === event.job?.generationJobId &&
    call.provider === event.provider && call.model === event.model &&
    (call.metadata.requestIndex === undefined || call.metadata.requestIndex === event.requestIndex))]));
  const matched = new Map();
  for (const [key, rows] of candidates) {
    const call = rows.length === 1 ? rows[0] : undefined;
    if (call && [...candidates.values()].filter(other => other.includes(call)).length === 1) matched.set(key, call);
  }
  const outcomes = [...physical.keys()].map(key => {
    const call = matched.get(key);
    if (call && failed(call)) return "error";
    return terminal.get(key)?.event?.split(".").at(-1) ?? (call?.metadata?.liveStatus === "settled" ? "response" : undefined);
  });
  const callsWithoutConfirmedUsage = textCalls.filter(call => !confirmed(call, "promptTokens") || !confirmed(call, "outputTokens")).length;
  const callsWithoutCostHint = ledger.filter(call => number(call.costHint) === null || call.metadata?.provisional === true || failed(call)).length;
  const textLedgerFullyMatched = matched.size === physical.size && new Set(matched.values()).size === textCalls.length;
  return {
    textAttemptOutcomes: !physical.size ? null : { succeeded: outcomes.filter(value => value === "response").length,
      failed: outcomes.filter(value => value === "error").length, notIndividuallySettled: outcomes.filter(value => value === undefined).length },
    ledgerKnownFailedTextCalls: textCalls.filter(failed).length,
    textAttemptsWithoutUsage: physical.size ? [...physical.keys()].filter(key => !usage.has(key)).length : null,
    tokenAccounting: {
      providerReportedPromptTokens: textCalls.reduce((sum, call) => sum + (confirmed(call, "promptTokens") ? call.promptTokens : 0), 0),
      providerReportedOutputTokens: textCalls.reduce((sum, call) => sum + (confirmed(call, "outputTokens") ? call.outputTokens : 0), 0),
      estimatedPromptTokens: textCalls.reduce((sum, call) => sum + (call.metadata?.promptTokensEstimated === true ? number(call.promptTokens) ?? 0 : 0), 0),
      estimatedOutputTokens: textCalls.reduce((sum, call) => sum + (call.metadata?.outputTokensEstimated === true ? number(call.outputTokens) ?? 0 : 0), 0),
      callsWithoutConfirmedUsage,
      complete: textCalls.length > 0 && callsWithoutConfirmedUsage === 0 && !textCalls.some(call => call.metadata?.provisional === true) &&
        textLedgerFullyMatched
    },
    costAccounting: {
      knownCostHint: ledger.reduce((sum, call) => sum + (!failed(call) && call.metadata?.provisional !== true ? number(call.costHint) ?? 0 : 0), 0),
      callsWithoutCostHint,
      complete: ledger.length > 0 && callsWithoutCostHint === 0 && textLedgerFullyMatched
    }
  };
}
