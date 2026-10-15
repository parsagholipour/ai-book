import { withSexualContentRule, type GenerateTextOptions } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { createSexualContentFilterFlag } from "@book-maker/db/safetySettings";

/**
 * The worker's half of the operator's sexual-content filter: the fixed rule
 * (`SEXUAL_CONTENT_RULE`, core) in front of the system prompt of every text call
 * `LoggingTextModelAdapter` sends while the switch is on — every writer, editor,
 * planner, reviewer and rewrite a job makes, bound or not, because every one of
 * them leaves the process through that adapter. Applied before the run log
 * records the request, so the log shows what the provider was sent.
 *
 * The switch is read at most once a minute per process and a failed read
 * answers ON (`createSexualContentFilterFlag`). A suite's stand-in client with no
 * safety table reads as off, which is what keeps the rule out of every suite
 * that never asked about it.
 */
const flag = createSexualContentFilterFlag(
  () => ((prisma as { safetySettingsRevision?: unknown }).safetySettingsRevision ? prisma : null),
  {
    onReadError: (error) =>
      console.error("Safety settings read failed; the sexual-content rule stays on", {
        event: "content_safety.settings_read_failed",
        error: error instanceof Error ? error.message : String(error)
      })
  }
);

/** A call's options with the rule applied while the operator's filter is on. */
export async function withContentSafetyRule<T extends GenerateTextOptions>(options: T): Promise<T> {
  return withSexualContentRule(options, await flag.enabled());
}

/** Tests only: drop the cached switch between cases. */
export function forgetContentSafetySetting(): void {
  flag.forget();
}
