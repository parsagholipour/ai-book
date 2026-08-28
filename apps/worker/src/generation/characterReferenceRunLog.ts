import { safePathPart } from "@book-maker/core";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../runtime/config.js";

/**
 * What a character reference pass writes into the debugging artifact.
 *
 * The filesystem half of `characterReferenceRenderLease.ts`, kept apart from it
 * for the reason `characterReferenceSheetFiles.ts` and
 * `characterReferenceFileNames.ts` are: the rule here is about a log file and
 * its vocabulary, not about leases or rows, and the lease reached its size
 * budget. It knows nothing of claims, tokens or settlements — a subject is
 * three strings — so the dependency runs one way and no pass type crosses it.
 *
 * Same `<run>-character-references.jsonl` file `characterReferences.ts` appends
 * its refused-sheet and skipped-seed lines to, and here for their reason: from
 * the finished book, a page drawn with no reference sheet looks identical
 * whatever the cause, and there are now four of them — the cast has none yet, a
 * provider refused one, the plan version went away, or this caller gave up on a
 * render somebody else was still paying for. Only the first two were written
 * down. An operator reading one file has to be able to tell them apart, and the
 * last two are the ones that cost a likeness nobody decided to lose.
 *
 * Best effort in both directions, exactly as those two writers are: a log line
 * may not fail a book, and `JSON.stringify` stands in for the worker's
 * `safeJsonStringify` because these entries are fixed records of strings and
 * numbers — reaching for that helper would pull `runtime/serialization.ts`, and
 * with it the `@book-maker/core` barrel, into a module otherwise kept to node.
 */
export type CharacterReferenceRunLogSubject = {
  projectId: string;
  planId: string;
  generationJobId?: string | undefined;
};

/** A pass that answered with somebody else's sheets, and why. */
export async function logCharacterReferenceStandDown(
  subject: CharacterReferenceRunLogSubject,
  detail: Record<string, string | number | boolean>
): Promise<void> {
  await appendCharacterReferenceRunLog(subject, "character.reference.stand_down", detail);
}

export async function appendCharacterReferenceRunLog(
  subject: CharacterReferenceRunLogSubject,
  event: string,
  detail: Record<string, string | number | boolean>
): Promise<void> {
  const logDir = join(config.BOOK_STORAGE_DIR, subject.projectId, "runs");
  const runId = safePathPart(subject.generationJobId ?? "unknown-run");
  try {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      projectId: subject.projectId,
      planId: subject.planId,
      generationJobId: subject.generationJobId,
      ...detail
    });
    await mkdir(logDir, { recursive: true });
    await appendFile(join(logDir, `${runId}-character-references.jsonl`), `${line}\n`, "utf8");
  } catch (error) {
    console.error(`Failed to record a character reference run-log line for ${subject.projectId}`, error);
  }
}
