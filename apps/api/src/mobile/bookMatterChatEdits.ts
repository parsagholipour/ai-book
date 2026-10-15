import {
  BOOK_MATTER_CHAT_FIELDS,
  BOOK_MATTER_CHAT_PURPOSE,
  BOOK_MATTER_GROUNDING_PURPOSE,
  acceptBookMatterGroundingReview,
  bookMatterChatAnswerSchema,
  bookMatterFieldsNamedIn,
  bookMatterYear,
  bookMatterChatMessages,
  bookMatterGroundingAnswerSchema,
  bookMatterGroundingMessages,
  bookMatterProseReviewCandidates,
  bookMatterMessageHasSeparateRequest,
  generateJsonWithRetry,
  isAuthorManuscript,
  normalizeBookMatterChatAnswer,
  parseBookMatter,
  withRecoverableNetworkRetry,
  type BookMatterChatCurrent,
  type BookMatterChatContext,
  type BookMatterChatDecision,
  type BookMatterChatField,
  type ConversationLanguage,
  type BookMatterChatPatch,
  type BookMatterLeftOver,
  type TextModelAdapter,
  yearInBookDigits
} from "@book-maker/core";
import { type BookEditIntent } from "../bookEditIntent.js";
import { asksToRemoveTitlePage, isTitlePageRemoval } from "../bookEditMatter.js";
import { frontMatterForPrompt, numberingForProject } from "../bookPageNumbering.js";
import { withoutChatMarkdownLiteral } from "../chatMarkdownLiteral.js";
import { copyrightRestrictionsEnabled } from "../contentRestrictions.js";
import { withTimeout } from "../withTimeout.js";
import {
  applyBookMatterPatch,
  BookMatterRefusal,
  bookMatterPatchSchema,
  bookMatterPatchText,
  ownedBookMatterProject,
  type BookMatterCover,
  type BookMatterProject,
  type BookMatterReprint
} from "./bookMatterEdits.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { screenMatterFields } from "./matterContentScreen.js";
import { createAssistantChatMessage, type ProjectForChat } from "./projectChat.js";
import { establishedChatLanguage } from "./bookMatterChatLanguage.js";
import { localizedMatterChatReplies } from "./bookMatterChatReplies.js";

/**
 * Applies a `book_matter` intent: one free change to the book's matter pages —
 * the author name, the dedication, About the Author, the website, the
 * copyright holder, the publisher, the ISBN, the "All rights reserved" line.
 *
 * What changes is composed here, by one structured fast-model call that is
 * shown the reader's message, the last few turns, the book's language and the
 * book's matter **as it prints now** (`bookMatterChatEdit.ts` in core holds the
 * prompt and the checks). The call is made the way the edit router's is — the
 * chat's routing model, a per-attempt time box, one retry on a dropped
 * connection — inside the chat turn's message-usage lease. A timeout, an
 * outage or an answer that does not parse lands on the "couldn't change it
 * right now" reply; nothing is guessed in its place. Under `MOCK_AI` the fake
 * text model answers through core's `fakeBookMatterChatEdit`, which composes the
 * common shapes in this schema and asks its one question for the rest, so a
 * dry run goes through the same checks and the same write.
 *
 * Every novel biography, and novel dedication prose in uncased scripts or
 * German, receives a separate grounding review against the reader's facts,
 * inside the same total call budget.
 * Exact supplied prose and provable short dedications need no extra call.
 * The composed change is then checked in code (only the fields the reader
 * asked for — by name, by pointing back at the last matter reply's fields
 * (`matterFieldsOfLastReply`), or as the one change a message naming no other
 * field asked for — printed lengths, a real and typed ISBN, a
 * website the reader typed, grounded numbers/addresses and the text-bound
 * grounding verdict where required), screened like the Title & credits sheet's fields — these words are
 * printed and shared — and written through the same `applyBookMatterPatch` that
 * sheet uses: no `BookEditOperation`, no ledger entry, no card, and a free
 * reprint of a finished book. The reply quotes what will print — literally
 * (`chatMarkdownLiteral`), because the bubble renders light markdown — and says
 * it was free; the values it replaced ride the reply's metadata
 * (`bookMatterEdit: { before, after }`) so an undo has them. Whatever the
 * message asked beyond the matter is named back on every reply — quoted when
 * the composer copied the reader's words, said generically when it did not —
 * and never silently dropped; so is a title page it asked to take out beside
 * the change, which every book keeps.
 *
 * An author's book takes its byline and dedication from the Writing Studio, so
 * those two are left out of the patch and the reply says where they are set.
 */

/** Per-attempt budget, the router's (`CLASSIFIER_CALL_BUDGET_MS`). */
const COMPOSER_CALL_BUDGET_MS = 10_000;

/**
 * The English entries of `MATTER_CHAT_COPY`, named for the suites that pin the
 * English replies. Every reply below takes its words from that table.
 */
const ENGLISH = localizedMatterChatReplies("en");
export const BOOK_MATTER_COMPOSE_FAILED = ENGLISH.text("failed");
/** Said whenever a message asked for the title page to go, alone or beside another change. */
export const TITLE_PAGE_KEPT = ENGLISH.text("titleKept");
export const TITLE_PAGE_ANSWER = ENGLISH.titleAnswer;
/** The left-over of a compound message, when there are no words of the reader's to quote. */
export const SEPARATE_REQUEST_NOTE = ENGLISH.leftOver();

export async function applyBookMatterChatEdit(options: {
  userId: string;
  project: ProjectForChat;
  intent: BookEditIntent;
  userMessageId: string;
  /** What the router read: the request, a merged clarification follow-up included. */
  message: string;
  /** The request a question resumes. */
  pendingRequest: string;
  textModel?: TextModelAdapter | undefined;
  /** The one clarifying question was already asked about this request. */
  clarifyExhausted?: boolean | undefined;
  /** The turn's active transcript, oldest first. */
  activeMessages?: MobileProjectChatMessageRecord[] | undefined;
}): Promise<MobileProjectChatMessageRecord> {
  const { project, intent, message } = options;
  // The reply needs a language; the composer is told one only when the router or
  // a saved turn chose it, never the English default (`establishedChatLanguage`).
  const establishedLanguage = establishedChatLanguage(intent.responseLanguage, options.activeMessages);
  let replyLanguage = establishedLanguage ?? "en";
  let replies = localizedMatterChatReplies(replyLanguage);
  const reply = (content: string, metadata: Record<string, unknown> = {}) =>
    createAssistantChatMessage({
      projectId: project.id,
      parentId: options.userMessageId,
      content,
      metadata: { intent, charged: false, replyLanguage, ...metadata }
    });
  // A reply that asks for something is the request's one question: the next
  // message is merged with it. Once it is spent (`clarifyExhausted`) nothing
  // asks again — that turn's replies are statements (`sendOne`).
  // Its own kind, never "scope": the answer is words to print, and read as a
  // scope "For my mom, who stood by me throughout" became "Add a dedication
  // throughout the whole book" and was asked about again (`resolvePendingEditTurn`).
  const questionSpent = options.clarifyExhausted === true;
  const ask = (content: string, metadata: Record<string, unknown> = {}) =>
    reply(content, { ...metadata, pendingEdit: { request: options.pendingRequest, clarification: "matter" } });

  if (isTitlePageRemoval(message)) {
    const leftOver = remainderOf(bookMatterMessageHasSeparateRequest(message) ? { unhandledUnquoted: true } : {}, replies);
    return reply(`${replies.titleAnswer}${leftOver.sentence}`, leftOver.metadata);
  }
  const matterProject = await ownedBookMatterProject(options.userId, project.id);
  if (!matterProject) {
    return reply(replies.text("notFound"));
  }
  const current = currentMatter(matterProject);
  // As the page prints it: in the book's own digits (`yearInBookDigits`), so
  // the chat never quotes "© 2026" for a book that prints "© ۲۰۲۶".
  const year = yearInBookDigits(bookMatterYear(parseBookMatter(matterProject.bookMatter), project.createdAt), project.language);
  const lineNow = copyrightLine(current, year);
  // A reply's quoted values carry the bubble's literal marks, and a composer
  // reusing one would copy them (`withoutChatMarkdownLiteral`).
  const recent = (options.activeMessages ?? []).slice(-4).map((turn) =>
    turn.role === "USER"
      ? { role: "user" as const, content: turn.content }
      : { role: "assistant" as const, content: withoutChatMarkdownLiteral(turn.content) }
  );

  let decision: BookMatterChatDecision;
  try {
    const composed = await composeBookMatterEdit(options.textModel, {
      projectId: project.id,
      message,
      ...(establishedLanguage ? { conversationLanguage: establishedLanguage } : {}),
      recentConversation: recent,
      bookLanguage: project.language,
      current,
      ...(lineNow ? { copyrightLine: lineNow } : {}),
      alreadyAskedOnce: questionSpent,
      printedFrontMatter: frontMatterForPrompt(numberingForProject(project)),
      lastTurnFields: matterFieldsOfLastReply(options.activeMessages),
      // The turn that spends the one question: the request it was about names
      // the field its answer ("978…", "Lantern") does not.
      ...(questionSpent && options.pendingRequest.trim() !== message.trim()
        ? { originalRequest: options.pendingRequest }
        : {})
    });
    decision = composed;
    // The model identifies language in the same bounded call; code still owns
    // the saved-change, refusal and export/cover claims in the reply.
    replyLanguage = composed.responseLanguage ?? replyLanguage;
    replies = localizedMatterChatReplies(replyLanguage);
  } catch {
    return reply(replies.text("failed"));
  }

  // What the message asked beyond the matter is named back on every reply
  // below, and so is a title page it asked to take out beside the change: the
  // change says nothing about that page, and every book keeps one.
  const titlePageAnswered = decision.kind === "none" && decision.reason === "title_page";
  const titlePage = !titlePageAnswered && asksToRemoveTitlePage(message) ? ` ${replies.text("titleKept")}` : "";
  const leftOver = remainderOf(decision, replies);
  const remainder = `${titlePage}${leftOver.sentence}`;
  const remainderMetadata = leftOver.metadata;
  switch (decision.kind) {
    case "question":
      return questionSpent
        ? reply(`${replies.secondQuestion}${remainder}`, remainderMetadata)
        : ask(`${decision.question}${remainder}`, remainderMetadata);
    case "none":
      return reply(`${replies.none(decision.reason, current)}${remainder}`, remainderMetadata);
    case "refused":
      return questionSpent
        ? reply(`${replies.problem(decision.problem, true)}${remainder}`, remainderMetadata)
        : ask(`${replies.problem(decision.problem, false)}${remainder}`, remainderMetadata);
    case "change":
      break;
  }

  // An author's book sets these two in the Studio; the rest of the change still goes through.
  const studioOwned = isAuthorManuscript(matterProject.mediaSettings);
  const patch: BookMatterChatPatch = { ...decision.patch };
  const leftToStudio = studioOwned && (patch.authorName !== undefined || patch.dedication !== undefined);
  if (studioOwned) {
    delete patch.authorName;
    delete patch.dedication;
  }
  if (Object.keys(patch).length === 0) {
    return reply(`${replies.text("studio")}${remainder}`, remainderMetadata);
  }
  const refused = screenMatterFields(bookMatterPatchText(patch), await copyrightRestrictionsEnabled());
  if (refused) {
    return reply(`${replies.restricted(refused.fields, refused.refusal.message)}${remainder}`, remainderMetadata);
  }
  const parsed = bookMatterPatchSchema.safeParse(patch);
  if (!parsed.success) {
    return reply(replies.text("failed"));
  }

  let outcome: { reprint: BookMatterReprint; cover: BookMatterCover };
  try {
    outcome = await applyBookMatterPatch(matterProject, parsed.data);
  } catch (error) {
    if (error instanceof BookMatterRefusal) {
      return reply(`${replies.saveRefused(error)}${remainder}`, remainderMetadata);
    }
    throw error;
  }

  const after = parsed.data as BookMatterChatPatch;
  const before = Object.fromEntries(
    Object.keys(after).map((field) => [field, current[field as BookMatterChatField]])
  ) as BookMatterChatPatch;
  const studio = leftToStudio ? ` ${replies.text("studio")}` : "";
  return reply(`${replies.change(after, current, year, outcome)}${studio}${remainder}`, {
    bookMatterEdit: { before, after },
    ...remainderMetadata
  });
}

/**
 * The composer call: the routing model, time-boxed per attempt and retried
 * once on a dropped connection, the router's own envelope. A conditional
 * grounding review shares that deadline and fails closed through the
 * normalizer. Throws when there is no model or no composer answer.
 */
export async function composeBookMatterEdit(
  textModel: TextModelAdapter | undefined,
  input: Parameters<typeof bookMatterChatMessages>[0] & {
    projectId: string;
    /** On the turn that answers the one question, the request it was asked about. */
    originalRequest?: string | undefined;
    /** The fields the chat's last matter reply changed or asked about. */
    lastTurnFields?: readonly BookMatterChatField[] | undefined;
  }
): Promise<BookMatterChatDecision & { responseLanguage?: ConversationLanguage }> {
  if (!textModel) {
    throw new Error("No text model for the matter composer.");
  }
  const { projectId, originalRequest, lastTurnFields, ...prompt } = input;
  // Composition and any needed grounding review share the existing two-attempt envelope.
  const deadline = Date.now() + COMPOSER_CALL_BUDGET_MS * 2 + 500;
  const result = await withTimeout(withRecoverableNetworkRetry(
    () => {
      const remaining = Math.min(COMPOSER_CALL_BUDGET_MS, deadline - Date.now());
      if (remaining <= 0) throw new Error("Book matter composer budget exhausted.");
      return withTimeout(
        generateJsonWithRetry(textModel, {
          purpose: BOOK_MATTER_CHAT_PURPOSE,
          projectId,
          temperature: 0,
          maxTokens: 2_400,
          repairAttempts: 1,
          schema: bookMatterChatAnswerSchema,
          messages: bookMatterChatMessages(prompt)
        }),
        remaining,
        "Book matter composer"
      );
    },
    { attempts: 2, delayMs: 500 }
  ), deadline - Date.now(), "Book matter composition");
  const context: BookMatterChatContext = {
    message: input.message,
    readerTurns: (input.recentConversation ?? []).filter((turn) => turn.role === "user").map((turn) => turn.content),
    current: input.current,
    bookLanguage: input.bookLanguage,
    ...(originalRequest ? { originalRequest } : {}),
    ...(lastTurnFields?.length ? { lastTurnFields } : {})
  };
  const candidates = bookMatterProseReviewCandidates(result.data, context);
  if (candidates.length) {
    try {
      const remaining = Math.min(COMPOSER_CALL_BUDGET_MS, deadline - Date.now());
      if (remaining <= 0) throw new Error("No time left for book matter grounding review.");
      const reviewed = await withTimeout(generateJsonWithRetry(textModel, {
        purpose: BOOK_MATTER_GROUNDING_PURPOSE,
        projectId,
        temperature: 0,
        maxTokens: 800,
        repairAttempts: 0,
        textAttemptBudget: { limit: 1, used: 0, outputWidened: true },
        schema: bookMatterGroundingAnswerSchema,
        messages: bookMatterGroundingMessages(candidates, context)
      }), remaining, "Book matter grounding review");
      context.proseReview = acceptBookMatterGroundingReview(reviewed.data, candidates, context);
    } catch {
      // No receipt means the normalizer returns its existing localized
      // not-given question/refusal, preserving the rest of a compound request.
    }
  }
  const decision = normalizeBookMatterChatAnswer(result.data, context);
  return { ...decision, ...(result.data.responseLanguage ? { responseLanguage: result.data.responseLanguage } : {}) };
}

/**
 * The fields the chat's last matter reply changed (`bookMatterEdit`) or asked
 * its question about (a `matter` `pendingEdit`'s request) — what a follow-up's
 * "it" points back to: "Dedicate it to my mom" → Done → "Mention my sister in
 * it too". The nearer of the last two assistant turns that has any, so a reply
 * in between that changed nothing ("I couldn’t change that right now") does
 * not lose it, and never further back.
 */
export function matterFieldsOfLastReply(messages: readonly MobileProjectChatMessageRecord[] = []): BookMatterChatField[] {
  const replies = messages.filter((message) => message.role === "ASSISTANT").slice(-2).reverse();
  for (const reply of replies) {
    const fields = matterFieldsOf(reply.metadata);
    if (fields.size > 0) return [...fields];
  }
  return [];
}

const MATTER_FIELDS: ReadonlySet<string> = new Set(BOOK_MATTER_CHAT_FIELDS);

function matterFieldsOf(metadata: unknown): Set<BookMatterChatField> {
  const record = objectOf(metadata);
  const fields = new Set<BookMatterChatField>();
  const edit = objectOf(record.bookMatterEdit);
  for (const key of [...Object.keys(objectOf(edit.before)), ...Object.keys(objectOf(edit.after))]) {
    if (MATTER_FIELDS.has(key)) fields.add(key as BookMatterChatField);
  }
  const pending = objectOf(record.pendingEdit);
  if (pending.clarification === "matter" && typeof pending.request === "string") {
    for (const field of bookMatterFieldsNamedIn(pending.request)) fields.add(field);
  }
  return fields;
}

const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * The sentence that names a compound message's left-over, and the metadata
 * that records it. The reader's own words are quoted; a part the composer
 * paraphrased, or code found unreported, is named without quoting anything.
 */
function remainderOf(
  leftOver: BookMatterLeftOver,
  replies: ReturnType<typeof localizedMatterChatReplies>
): { sentence: string; metadata: Record<string, unknown> } {
  if (leftOver.unhandled) {
    return { sentence: ` ${replies.leftOver(leftOver.unhandled)}`, metadata: { unhandledRequest: leftOver.unhandled } };
  }
  return leftOver.unhandledUnquoted
    ? { sentence: ` ${replies.leftOver()}`, metadata: { unhandledRequestUnquoted: true } }
    : { sentence: "", metadata: {} };
}

function currentMatter(project: BookMatterProject): BookMatterChatCurrent {
  const matter = parseBookMatter(project.bookMatter);
  return {
    authorName: project.authorName?.trim() || null,
    dedication: matter.dedication ?? null,
    aboutAuthor: matter.aboutAuthor ?? null,
    authorWebsite: matter.authorWebsite ?? null,
    copyrightHolder: matter.copyrightHolder ?? null,
    imprint: matter.imprint ?? null,
    isbn: matter.isbn ?? null,
    allRightsReserved: matter.allRightsReserved === true
  };
}

function copyrightLine(matter: Pick<BookMatterChatCurrent, "copyrightHolder" | "authorName">, year: string): string | undefined {
  const holder = matter.copyrightHolder ?? matter.authorName;
  return holder ? `© ${year} ${holder}` : undefined;
}

/**
 * What the chat says once a matter change is in, in English — kept by name for
 * the suites; `localizedMatterChatReplies(language).change` is the reply.
 */
export function bookMatterChangeReply(
  after: BookMatterChatPatch,
  current: BookMatterChatCurrent,
  year: string,
  outcome: { reprint: BookMatterReprint; cover: BookMatterCover }
): string {
  return ENGLISH.change(after, current, year, outcome);
}
