import { withSexualContentRuleModel, withSexualContentRuleText, type TextModelAdapter } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { createSexualContentFilterFlag } from "@book-maker/db/safetySettings";

/**
 * The API's half of the operator's sexual-content filter
 * (`SafetySettingsRevision.sexualContentFilterEnabled`, default ON).
 *
 * - **The rule** rides every model call the API makes inline: both model
 *   factories in `generationTextModelRouting.ts` return a model wrapped by
 *   {@link withContentSafetyRule}, so the creation chat, the book advisor, the
 *   build's page-count call, the book chat's router and composers, the Studio's
 *   quick assists and attachment summaries all carry it — and a new inline call
 *   carries it by being built the only way one can be. The voice persona is a
 *   system instruction rather than a text call and takes it through
 *   {@link withContentSafetyInstructions}.
 * - **The screens** are `contentSafetyScreen.ts`.
 *
 * The switch is read at most once a minute per process, single-flight, and a
 * failed read answers ON (`createSexualContentFilterFlag`); a console save drops
 * this process's copy at once ({@link forgetSexualContentFilterSetting}), and
 * every other process — the worker included — follows within the minute. A
 * suite's stand-in client with no safety table reads as off, the way the
 * copyright flag treats one, which is what keeps the rule out of every suite
 * that never asked about it.
 */
const flag = createSexualContentFilterFlag(
  () => ((prisma as { safetySettingsRevision?: unknown }).safetySettingsRevision ? prisma : null),
  {
    onReadError: (error) =>
      console.error("Safety settings read failed; the sexual-content filter stays on", {
        event: "content_safety.settings_read_failed",
        error: error instanceof Error ? error.message : String(error)
      })
  }
);

/** Whether the operator's sexual-content filter is on. Never rejects; a failed read is `true`. */
export function sexualContentFilterEnabled(): Promise<boolean> {
  return flag.enabled();
}

/** A console save: this process reads the switch again on its next call. */
export function forgetSexualContentFilterSetting(): void {
  flag.forget();
}

/** A text model whose every call — bound or not — carries the rule while the filter is on. */
export function withContentSafetyRule(model: TextModelAdapter): TextModelAdapter {
  return withSexualContentRuleModel(model, sexualContentFilterEnabled);
}

/** A voice persona's system instruction with the rule in front of it while the filter is on. */
export async function withContentSafetyInstructions(instructions: string): Promise<string> {
  return withSexualContentRuleText(instructions, await sexualContentFilterEnabled());
}
