import { assessContentRestrictions, ContentRestrictedError } from "../contentRestrictions.js";

/**
 * The one screen the library-character writes run, and the text it runs on.
 *
 * It lives here rather than in `routes/characters.ts` because `POST` and
 * `PATCH` hold the same rule — **the text a character write screens is the text
 * it stores** — and neither of them stores the prose the request typed:
 * `replaceLibraryMentions` respells every `@name` to its target's own spelling,
 * so a body carrying `@bramstoker` is stored as `@Bram Stoker`, and a
 * `{mentionedCharacterIds}` PATCH canonicalizes a `description` saved from
 * another device that this request never carried at all. Screening the request
 * body is screening a string nothing keeps. Held twice, the rule was answered
 * twice and only one of the two answers was right.
 *
 * `characterContentText` has a third reader that stores nothing:
 * `POST /api/mobile/characters/:id/portrait` screens the row before it pays a
 * provider to draw it, which is the same rule from the other end — the text
 * that route screens is the text the prompt renders. Every field below reaches
 * `buildLibraryCharacterPortraitPrompt`, so a field left out of this string is
 * a field nothing assesses on the one character route that spends credits.
 *
 * The assertion takes the flag rather than reading it. `assessContentRestrictions`
 * is synchronous, but `copyrightRestrictionsEnabled()` behind it is a query on
 * another pool connection, and both call sites screen from **inside** their
 * transaction — PATCH while holding up to 99 sibling row locks. So the flag is
 * read before the transaction opens and handed down, and a refusal leaves as a
 * throw: `ContentRestrictedError` rolls the writes above it back — the new row,
 * the link set, the canonicalized descriptions — and the route's own catch
 * answers the 422 through `sendContentRestricted`, where every other answer on
 * those routes is written.
 */
export type CharacterContent = {
  name: string;
  description: string;
  /**
   * Screened with the rest — it is user text like any other. The photo path's
   * own reading never comes through here: `readCharacterPhoto` screens it
   * there, so that one bad half can be dropped without failing an upload the
   * reader did nothing wrong in.
   */
  appearance?: string | null | undefined;
  fields: Array<{ key: string; value: string }>;
};

/** Everything a character write puts in front of the screener, in one string. */
export function characterContentText(input: CharacterContent): string {
  return [
    input.name,
    input.description,
    input.appearance ?? "",
    ...input.fields.map((field) => `${field.key}: ${field.value}`)
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Screens the row a write is about to leave behind, and throws rather than
 * answering — see above for why the answer belongs to the caller's catch.
 */
export function assertCharacterContentAllowed(
  stored: CharacterContent,
  copyrightRestrictionsEnabled: boolean
): void {
  const screened = assessContentRestrictions(characterContentText(stored), {
    copyrightRestrictionsEnabled
  });
  if (!screened.allowed) {
    throw new ContentRestrictedError(screened);
  }
}
