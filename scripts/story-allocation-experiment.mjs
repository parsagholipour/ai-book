import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function writeExclusive(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

/** Change only the beat-length instruction, outside production configuration. */
export function mapExperimentRequest(request, variant, targetPages) {
  if (!["baseline", "variable-beats"].includes(variant)) throw new Error("Unknown map variant");
  if (!Number.isInteger(targetPages) || targetPages < 1) throw new Error("Invalid page count");
  const messages = request.messages.map(message => ({ ...message }));
  if (variant === "variable-beats") {
    const needle = "beat within 18 words";
    const matches = messages.filter(message => message.role === "system")
      .reduce((count, message) => count + message.content.split(needle).length - 1, 0);
    if (matches !== 1) throw new Error("Map prompt drift: expected exactly one beat limit");
    for (const message of messages) if (message.role === "system") {
      message.content = message.content.replace(needle,
        `each beat within 40 words when linked actions require it, all beats together within ${18 * targetPages} words`);
    }
  }
  return { ...request, messages };
}

/** The oracle changes the map only; keep all writer settings and context equal. */
export function assertOracleIsolation(original, corrected) {
  const stripMap = request => ({ ...request, messages: request.messages.map(message => {
    if (message.role !== "user") return message;
    const payload = JSON.parse(message.content);
    delete payload.pageMap;
    return { ...message, content: JSON.stringify(payload) };
  }) });
  if (fingerprint(stripMap(original)) !== fingerprint(stripMap(corrected))) {
    throw new Error("Oracle changed writer context outside pageMap");
  }
  const slots = request => JSON.parse(request.messages.find(message => message.role === "user").content)
    .pageMap.map(page => [page.pageIndex, page.chapterIndex, page.chapterTitle]);
  if (fingerprint(slots(original)) !== fingerprint(slots(corrected))) {
    throw new Error("Oracle changed page or chapter assignments");
  }
}

/** Usage events can be cumulative. Count the last snapshot per physical attempt. */
export function summarizeAttempts(attempts) {
  let promptTokens = 0, outputTokens = 0, reasoningTokens = 0, attemptsWithoutUsage = 0;
  for (const attempt of attempts) {
    const usage = attempt.usage?.at(-1);
    if (!usage || !Number.isFinite(usage.promptTokens) || !Number.isFinite(usage.outputTokens)) {
      attemptsWithoutUsage += 1;
      continue;
    }
    promptTokens += usage.promptTokens;
    outputTokens += usage.outputTokens;
    reasoningTokens += usage.reasoningTokens ?? 0;
  }
  return { physicalAttempts: attempts.length, promptTokens, outputTokens,
    totalTokens: promptTokens + outputTokens, reasoningTokens,
    attemptsWithoutUsage, failedAttempts: attempts.filter(attempt => attempt.status === "failed").length,
    complete: attempts.length > 0 && attemptsWithoutUsage === 0 &&
      attempts.every(attempt => ["succeeded", "failed"].includes(attempt.status)) };
}

/** A partial matrix cannot establish the plan's two matched editorial comparisons. */
export function oracleComparisonReadiness(samples) {
  const validPairs = [1, 2].every(pair => ["original", "corrected"].every(variant =>
    samples.filter(sample => sample.pair === pair && sample.variant === variant).length === 1));
  if (samples.length !== 4 || !validPairs || new Set(samples.map(sample => sample.label)).size !== 4) {
    return { ready: false, reason: "Expected two distinct matched original/corrected pairs" };
  }
  if (samples.some(sample => sample.result?.status !== "completed")) {
    return { ready: false, reason: "At least one manuscript is missing or failed; do not replace it silently" };
  }
  if (samples.some(sample => !sample.result?.usage?.complete)) {
    return { ready: false, reason: "Usage accounting is incomplete" };
  }
  return { ready: true, reason: "Complete matrix; editorial assessment is still required" };
}
