/**
 * Replays the `collect-evidence` calls of one apply-book-edit run log against
 * the live mechanical model, with the *current* leaf prompt and schema.
 *
 * The adherence leaf phase is the one provider call in the edit path that had
 * never parsed on a real model until 2026-09-06, and each of its failures is
 * only visible after a paid edit has run. This is the offline half: take the
 * segment payloads a run already logged, rebuild the messages the way
 * `editAdherenceHierarchy.ts` builds them today, and report whether each reply
 * parses, how complete it says it is, and how long its facts run. Runs where
 * the worker's provider keys are:
 *
 *   docker exec ai-book-maker-worker-1 pnpm -F @book-maker/worker exec tsx \
 *     scripts/replay-adherence-leaf.ts books/<projectId>/runs/<run>-apply-book-edit.jsonl [maxCalls]
 */
import { readRunLog } from "@book-maker/storage";
import {
  createLiveGenerationTextModel,
  EDIT_ADHERENCE_EVIDENCE_CAPACITY,
  evidenceSystemMessage,
  generateJsonWithRetry,
  LEAF_EVIDENCE_CONTRACT,
  leafEvidenceResponseSchema,
  MAX_EVIDENCE_ITEM_LENGTH
} from "@book-maker/core";
import { config } from "../src/runtime/config.js";
import { loadLiveGenerationTextRouting } from "../src/providers/generationTextRouting.js";

const [logPath, maxCallsArg] = process.argv.slice(2);
if (!logPath) {
  console.error("usage: replay-adherence-leaf.ts <run log> [maxCalls]");
  process.exit(1);
}
const maxCalls = Number.parseInt(maxCallsArg ?? "4", 10);

type LoggedRequest = { callId: string; payload: Record<string, unknown>; failed: boolean };
const requests = new Map<string, LoggedRequest>();
for (const line of (await readRunLog(logPath)).split("\n")) {
  if (!line.trim()) continue;
  const entry = JSON.parse(line) as { event: string; callId?: string; request?: { purpose?: string; messages?: Array<{ content: string }> } };
  if (!entry.callId) continue;
  if (entry.event === "text.generateJson.request" && entry.request?.purpose === "review-edit-adherence") {
    const payload = JSON.parse(entry.request.messages?.[1]?.content ?? "{}") as Record<string, unknown>;
    if (payload.reviewPhase === "collect-evidence") {
      requests.set(entry.callId, { callId: entry.callId, payload, failed: false });
    }
  }
  if (entry.event === "text.generateJson.error" && requests.has(entry.callId)) {
    requests.get(entry.callId)!.failed = true;
  }
}
// Failed calls first: those are the payloads the old prompt could not answer.
const ordered = [...requests.values()].sort((a, b) => Number(b.failed) - Number(a.failed)).slice(0, maxCalls);
console.log(`${requests.size} leaf calls logged, replaying ${ordered.length}`);

const model = createLiveGenerationTextModel(config, {
  tier: "balanced",
  fastJudgments: true,
  loadRouting: loadLiveGenerationTextRouting({ filePath: "", append: async () => "" })
});

let parsed = 0;
for (const request of ordered) {
  const segments = (request.payload.segments as unknown[]) ?? [];
  const messages = [
    { role: "system" as const, content: evidenceSystemMessage(EDIT_ADHERENCE_EVIDENCE_CAPACITY, MAX_EVIDENCE_ITEM_LENGTH) },
    { role: "user" as const, content: JSON.stringify({ ...request.payload, outputContract: LEAF_EVIDENCE_CONTRACT }) }
  ];
  const started = Date.now();
  try {
    const result = await generateJsonWithRetry(model, {
      purpose: "review-edit-adherence",
      temperature: 0,
      maxTokens: 12_268,
      repairAttempts: 1,
      schema: leafEvidenceResponseSchema,
      messages
    });
    parsed += 1;
    const facts = [
      ...result.data.observedChanges,
      ...result.data.requirementEvidence,
      ...result.data.possibleOmissions,
      ...result.data.contradictions
    ];
    const longest = Math.max(0, ...facts.map((fact) => fact.length));
    const clipped = facts.filter((fact) => fact.endsWith("…")).length;
    const ids = new Set(result.data.acceptedInputIds);
    const coverage = segments.every((segment) => ids.has((segment as { id: string }).id));
    console.log(
      `${request.failed ? "was-failed" : "was-ok   "} segs=${segments.length} -> parsed in ${Date.now() - started}ms: complete=${result.data.evidenceComplete} facts=${facts.length} longest=${longest} clipped=${clipped} coverage=${coverage}`
    );
  } catch (error) {
    console.log(`${request.failed ? "was-failed" : "was-ok   "} segs=${segments.length} -> ERROR ${(error as Error).message.slice(0, 300).replace(/\n/g, " ")}`);
  }
}
console.log(`\n${parsed}/${ordered.length} replies parsed`);
process.exit(0);
