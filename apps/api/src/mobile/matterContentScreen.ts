import type { FastifyReply } from "fastify";
import {
  assessContentRestrictions,
  copyrightRestrictionsEnabled,
  sendContentRestricted,
  type ContentRestrictionRefusal
} from "../contentRestrictions.js";

/**
 * The screen for an author profile and a book's matter pages. It runs because
 * these words are printed: on the title page, the dedication, the About the
 * Author page, and every public share of the book.
 *
 * **Printed text, not a request** (`ContentRestrictionOptions.printed`): the
 * app's rules that need a request shape — "how to" beside "terrorist attack",
 * "fake" beside "passport" — refused memorial dedications and history bios, so
 * only the child-exploitation names and the operator's copyright rule apply.
 *
 * **Each field alone.** The fields print on different pages, so two of them
 * together say nothing either says alone; screened as one string, a dedication
 * to the victims of a terrorist attack and a bio that "teaches students how to
 * grow tomatoes" were refused together and both named. A refusal names exactly
 * the fields whose own text is refused; its sentence is the first critical-harm
 * refusal among them, else the first.
 */
export function screenMatterFields(
  values: Record<string, string | null | undefined>,
  copyrightRestrictions: boolean
): { refusal: ContentRestrictionRefusal; fields: string[] } | null {
  const options = { copyrightRestrictionsEnabled: copyrightRestrictions, printed: true };
  const refused = Object.entries(values).flatMap(([field, value]) => {
    const text = value?.trim();
    if (!text) return [];
    const assessment = assessContentRestrictions(text, options);
    return assessment.allowed ? [] : [{ field, refusal: assessment }];
  });
  const first = refused.find((entry) => entry.refusal.reason !== "copyright") ?? refused[0];
  return first ? { refusal: first.refusal, fields: refused.map((entry) => entry.field) } : null;
}

/**
 * Screens, answers the 422 itself (`fields` beside the screen's own code and
 * reason) and says whether the route may go on. A body with no text costs no
 * flag read.
 */
export async function enforceMatterFieldRestrictions(
  reply: FastifyReply,
  values: Record<string, string | null | undefined>
): Promise<boolean> {
  if (!Object.values(values).some((value) => value?.trim())) return true;
  const refused = screenMatterFields(values, await copyrightRestrictionsEnabled());
  if (!refused) return true;
  sendContentRestricted(reply, refused.refusal, { fields: refused.fields });
  return false;
}
