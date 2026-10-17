import { namesAuthorProfile, type BookMatterChatProfile } from "../authoring/bookMatterProfile.js";
import type { GenerateJsonOptions } from "./types.js";

/**
 * The dry-run answer for the chat's book-matter composer
 * (`BOOK_MATTER_CHAT_PURPOSE`). `MOCK_AI=true` is how this repo is worked on,
 * and the generic fake's `{}` is not an answer the composer accepts, so every
 * matter edit in the chat replied "couldn't change it right now" locally.
 *
 * It answers a change only for shapes whose matter part has an end it can see,
 * because a fake that guesses prints the garble the real composer was built to
 * stop ("dedicate it to my mom and redo the cover" printed "For my mom and redo
 * the cover"):
 *
 * - a dedication spelled out in double quotes after "make/set/change the
 *   dedication (to)", "add a dedication:", "the dedication should say" and
 *   their like;
 * - "dedicate it to <who>" where the recipient runs to the end of the message
 *   and is a short noun phrase — no "and/also/then", no verb, no sentence break,
 *   no comma, no "in <language>", nothing the real composer would have to merge
 *   into the current text ("too", "instead") — on an English book only, since
 *   the short form "For …" is English;
 * - "remove the dedication" with nothing qualifying it;
 * - "the ISBN is <digits>" (the normalizer checks the digits);
 * - a message pointing at the reader's saved profile ("use my profile"), when
 *   the prompt carries one: every field it holds, copied, the whole message as
 *   the request.
 *
 * Each may be preceded by a polite lead-in ("please", "can you") and nothing
 * else. After the quoted dedication, the removal or the ISBN, anything joined
 * by a sentence break or "and/also/then/plus/but" is returned in `unhandled`
 * exactly as typed, the joining word taken off; anything else after them, and
 * every other message, gets the one question. It answers in the composer's own
 * schema, so the normalizer's checks (the change quotes the reader's words,
 * only the named field changes, the ISBN's check digit) run exactly as they do
 * on a real reply. Nothing here runs outside `FakeTextModelAdapter`.
 */
export function fakeBookMatterChatEdit(options: GenerateJsonOptions<unknown>): unknown {
  const { message, englishBook, profile } = readerPayload(options);
  const text = message.trim();
  const fromProfile = text.length <= 4000 ? profileChanges(text, profile) : [];
  if (fromProfile.length > 0) {
    return { outcome: "change", changes: fromProfile, question: null, noneReason: null, unhandled: null };
  }
  // The schema bounds `requestedBy` and `unhandled` at 4000; a longer message
  // would fail the parse and read as an outage instead of a question.
  const found =
    text.length > 0 && text.length <= 4000
      ? (removedDedication(text) ?? quotedDedication(text) ?? (englishBook ? namedRecipient(text) : null) ?? typedIsbn(text))
      : null;
  if (!found) {
    return {
      outcome: "question",
      changes: [],
      question: "[MOCK_AI] What exactly should it say?",
      noneReason: null,
      unhandled: null
    };
  }
  return {
    outcome: "change",
    changes: [{ field: found.field, action: found.action, text: found.text, requestedBy: found.requestedBy }],
    question: null,
    noneReason: null,
    unhandled: found.unhandled
  };
}

type FakeChange = {
  field: "dedication" | "isbn";
  action: "set" | "remove";
  text: string | null;
  /** The words of the message that ask for the change, copied exactly. */
  requestedBy: string;
  unhandled: string | null;
};

/** What may come before the matter part: a polite lead-in, nothing else. */
const LEAD_IN = String.raw`(?:(?:hey|hi|ok(?:ay)?)[,!]?\s+)?(?:please\s+|pls\s+|kindly\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i(?:\s+(?:want|need|would\s+like)|['’]d\s+like)\s+(?:you\s+)?to\s+(?:please\s+)?|let(?:['’]s|\s+us)\s+)?`;

/** Nothing but punctuation and thanks: no request left over. */
const POLITE_ONLY = /^(?:[\s,.!?]|please|pls|thanks|thank\s+you|thx)*$/i;

/**
 * A sentence break or a joining word (after an optional comma), then the rest.
 * A comma alone is not a break: "…, in French" qualifies the change before it.
 */
const JOINED_REST =
  /^\s*(?:(?:[.!?;]+|\n)\s*,?\s*(?:(?:and|also|then|plus|but)\s+)*|,?\s*(?:(?:and|also|then|plus|but)\s+)+)([\s\S]*)$/i;

/**
 * What follows the matter part: nothing, or a separate request to name back.
 * `null` is "the matter part did not end here", which is the question.
 */
function leftOver(rest: string): { unhandled: string | null } | null {
  if (POLITE_ONLY.test(rest)) return { unhandled: null };
  const joined = JOINED_REST.exec(rest)?.[1]?.trim();
  if (joined === undefined) return null;
  return { unhandled: POLITE_ONLY.test(joined) ? null : joined };
}

const REMOVE_DEDICATION = new RegExp(
  String.raw`^(${LEAD_IN}(?:remove|delete|drop|take\s+out|get\s+rid\s+of)\s+(?:the\s+|my\s+|this\s+)?dedication(?:\s+page)?(?:\s+(?:entirely|completely|altogether))?(?:\s+from\s+(?:the|this|my)\s+book)?)(?![\p{L}\p{N}'’])([\s\S]*)$`,
  "iu"
);

function removedDedication(message: string): FakeChange | null {
  const match = REMOVE_DEDICATION.exec(message);
  const rest = match ? leftOver(match[2] ?? "") : null;
  if (!match?.[1] || !rest) return null;
  return { field: "dedication", action: "remove", text: null, requestedBy: match[1], unhandled: rest.unhandled };
}

/** Double quotes only: a single quote is also an apostrophe ("For Sara's mom"). */
const QUOTED_DEDICATION = new RegExp(
  String.raw`^(${LEAD_IN}(?:` +
    String.raw`(?:make|set|change|update|replace|switch)\s+(?:the\s+|my\s+)?dedication(?:\s+page)?\s*(?:(?:to\s+)?(?:say|read)|to|with|as|into)?` +
    String.raw`|(?:add|use|put|write|include)\s+(?:a\s+|the\s+|this\s+)?dedication(?:\s+page)?(?:\s+(?:that\s+)?(?:says|saying|reads|reading))?` +
    String.raw`|(?:the\s+|my\s+)?dedication(?:\s+page)?\s*(?:should\s+(?:say|read|be)|is|=)?` +
    String.raw`)\s*:?\s*["“„«]([^"“”„«»]+)["”“»])([\s\S]*)$`,
  "iu"
);

function quotedDedication(message: string): FakeChange | null {
  const match = QUOTED_DEDICATION.exec(message);
  const quoted = match?.[2]?.trim();
  const rest = match ? leftOver(match[3] ?? "") : null;
  if (!match?.[1] || !quoted || !/[\p{L}\p{N}]/u.test(quoted) || !rest) return null;
  return { field: "dedication", action: "set", text: quoted, requestedBy: match[1], unhandled: rest.unhandled };
}

/** The recipient has to run to the end of the message; trailing thanks are not part of it. */
const DEDICATE_TO = new RegExp(
  String.raw`^${LEAD_IN}dedicate\s+(?:it|this(?:\s+(?:book|one))?|the\s+book|my\s+book)\s+to\s+([\s\S]+?)(?:[\s,]+(?:please|pls|thanks|thank\s+you|thx))*[\s.!?]*$`,
  "iu"
);

/**
 * Words that mean the recipient is not a bare noun phrase: a joined clause, a
 * qualifier the real composer would have to act on ("too" is an edit of the
 * current dedication, "in" may be a language), or a verb.
 */
const NOT_A_RECIPIENT = new Set(
  (
    "and also then plus but or nor so because too instead either as well in on at with without from for by about to into like " +
    "using that which who whom whose where when while if please pls thanks " +
    "is are was were be been being am do does did should would could can will shall may might must have has had " +
    "make made change redo remake regenerate rewrite write add remove delete drop fix update replace put set use mention " +
    "include say says read reads call name keep move give show draw paint translate generate create edit swap turn let want need"
  ).split(" ")
);

function namedRecipient(message: string): FakeChange | null {
  const match = DEDICATE_TO.exec(message);
  const recipient = match?.[1]?.trim();
  if (!recipient || recipient.length > 60 || !/^[\p{L}\p{M}\p{N}'’ -]+$/u.test(recipient)) return null;
  const words = recipient.split(/\s+/);
  if (words.length > 6 || words.some((word) => NOT_A_RECIPIENT.has(word.toLowerCase()))) return null;
  return { field: "dedication", action: "set", text: `For ${recipient}`, requestedBy: message, unhandled: null };
}

const TYPED_ISBN = new RegExp(
  String.raw`^(${LEAD_IN}(?:(?:set|change|update|make|add|use|put)\s+)?(?:the\s+|my\s+|an\s+|its\s+|the\s+book['’]s\s+)?isbn(?:[-\s]?1[03])?(?:\s+number)?\s*(?:is|to|as|should\s+be|=|:|#)?\s*(\p{Nd}[\p{Nd} -]{7,20}[\p{Nd}Xx]))([\s\S]*)$`,
  "iu"
);

function typedIsbn(message: string): FakeChange | null {
  const match = TYPED_ISBN.exec(message);
  const rest = match ? leftOver(match[3] ?? "") : null;
  if (!match?.[1] || !match[2] || !rest) return null;
  return { field: "isbn", action: "set", text: match[2], requestedBy: match[1], unhandled: rest.unhandled };
}

function profileChanges(message: string, profile: BookMatterChatProfile | undefined) {
  if (!profile || !namesAuthorProfile(message)) return [];
  return Object.entries(profile).map(([field, value]) => ({
    field,
    action: "set",
    text: typeof value === "string" ? value : null,
    requestedBy: message
  }));
}

function readerPayload(options: GenerateJsonOptions<unknown>): {
  message: string;
  englishBook: boolean;
  profile: BookMatterChatProfile | undefined;
} {
  const user = [...options.messages].reverse().find((entry) => entry.role === "user");
  try {
    const payload = JSON.parse(String(user?.content ?? "{}")) as { readerMessage?: unknown; bookLanguage?: unknown; authorProfile?: unknown };
    const profile = payload.authorProfile;
    return {
      message: typeof payload.readerMessage === "string" ? payload.readerMessage : "",
      // `languageLabel` sends English as "en" and every other language by name.
      englishBook: payload.bookLanguage === undefined || payload.bookLanguage === "en",
      // The prompt builder's own object; the normalizer checks every value against it again.
      profile: profile !== null && typeof profile === "object" ? (profile as BookMatterChatProfile) : undefined
    };
  } catch {
    return { message: "", englishBook: false, profile: undefined };
  }
}
