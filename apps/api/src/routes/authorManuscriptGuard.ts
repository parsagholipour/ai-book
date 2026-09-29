import { isAuthorManuscript } from "@book-maker/core";
import type { FastifyReply } from "fastify";
import { AUTHOR_MANUSCRIPT_MESSAGE } from "../mobile/httpErrors.js";

/**
 * The operator console's copy of the mobile plan-route guard: a book the author
 * wrote or imported carries an approved plan only because publish (or the
 * import) synthesized one, and planning, revising, approving or re-drafting a
 * page of it would run generation over the author's text — here with no charge
 * at all. Answers in this surface's `{ error }` shape, with the mobile code
 * beside it. Returns true when it sent the refusal.
 */
export function refuseAuthorManuscript(reply: FastifyReply, mediaSettings: unknown): boolean {
  if (!isAuthorManuscript(mediaSettings)) {
    return false;
  }
  void reply.code(409).send({ error: AUTHOR_MANUSCRIPT_MESSAGE, code: "AUTHOR_MANUSCRIPT" });
  return true;
}
