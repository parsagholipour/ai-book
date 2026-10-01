import type { FastifyReply } from "fastify";
import type { UserTextViolation } from "../../userTextModeration.js";
import { sendMobileError } from "../httpErrors.js";

/**
 * Every refusal the share routes answer, one sentence per wire code, kept with
 * the code rather than at the call site ("A wire code owns one sentence"). The
 * app snackbars `error.message` verbatim and branches on `code`.
 *
 * A refused note says which category it fell in and that the author can edit
 * it, because the fix is always theirs: the gate refuses the words, never the
 * book.
 */
export const SHARE_ERRORS = {
  SHARE_NOT_AVAILABLE: { status: 409, message: "This book can be shared once it has finished and its PDF is ready." },
  SHARE_BEING_UPDATED: { status: 409, message: "This book is being updated. Try sharing again in a minute." },
  SHARE_TAKEN_DOWN: { status: 409, message: "This book was taken down from sharing and can't be shared again." },
  SHARE_RIGHTS_REQUIRED: { status: 400, message: "Confirm that you have the right to share this book publicly." },
  SHARE_LIKENESS_REQUIRED: {
    status: 400,
    message: "This book features someone drawn from a real photo. Confirm that anyone with the link can see it."
  },
  PREVIEW_PAGES_REQUIRED: { status: 400, message: "Choose how many pages the preview shows." },
  PREVIEW_TOO_LONG: { status: 400, message: "A preview can show at most half of the book's pages." },
  EXPORT_UNLOCK_REQUIRED: {
    status: 402,
    message: "Sharing the whole book uses the book's PDF unlock. Unlock it, or share a free preview instead."
  },
  CAPTION_TOO_LONG: { status: 400, message: "Keep the note to 500 characters or fewer." },
  CAPTION_LINK_NOT_ALLOWED: { status: 422, message: "A shared book's note can't include links. Remove the link and try again." },
  SHARE_NOT_FOUND: { status: 404, message: "This book isn't shared." },
  REMIX_NOT_AVAILABLE: { status: 410, message: "This book is no longer shared." }
} as const;

export type ShareErrorCode = keyof typeof SHARE_ERRORS;

export function sendShareError(reply: FastifyReply, code: ShareErrorCode, extra: Record<string, unknown> = {}) {
  const { status, message } = SHARE_ERRORS[code];
  if (Object.keys(extra).length === 0) {
    return sendMobileError(reply, status, code, message);
  }
  return reply.code(status).send({ error: { ...extra, code, message } });
}

/** The wire code and sentence for each refused-note category. */
export const CAPTION_REFUSALS: Record<UserTextViolation, { code: string; message: string }> = {
  sexual: {
    code: "CAPTION_SEXUAL_CONTENT",
    message: "This note reads as sexual content, which can't be shown on a public page. Edit it and try again."
  },
  child_safety: {
    code: "CAPTION_CHILD_SAFETY",
    message: "This note reads as unsafe toward children, which can't be shown on a public page. Edit it and try again."
  },
  hate_or_harassment: {
    code: "CAPTION_HATE_OR_HARASSMENT",
    message: "This note reads as hateful or harassing, which can't be shown on a public page. Edit it and try again."
  },
  violence_or_self_harm: {
    code: "CAPTION_VIOLENCE_OR_SELF_HARM",
    message:
      "This note reads as a real threat or as encouraging self-harm, which can't be shown on a public page. Edit it and try again."
  },
  spam_or_scam: {
    code: "CAPTION_SPAM_OR_SCAM",
    message:
      "This note reads as an ad or a request to get in touch or pay outside Tomeza, which can't be shown on a public page. Edit it and try again."
  },
  personal_info: {
    code: "CAPTION_PERSONAL_INFO",
    message:
      "This note includes someone's personal details, like a phone number or an address, which can't be shown on a public page. Edit it and try again."
  }
};

export function sendCaptionRefused(reply: FastifyReply, violation: UserTextViolation) {
  const { code, message } = CAPTION_REFUSALS[violation];
  return reply.code(422).send({ error: { code, message, reason: violation } });
}
