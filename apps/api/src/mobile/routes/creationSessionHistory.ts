import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { chatMessagePreviewSource } from "../../chatMessagePlainText.js";
import { mobileCreationDraftPayloadSchema } from "../../mobileCreation.js";
import {
  _chatTitleForPayload,
  activeProjectIdForDraft,
  conversationMessagesFromPayload,
  creationOutputsForDraft,
  mobileCreationDraftOutputsInclude
} from "../creationSessions.js";
import type {
  MobileChatHistoryDto,
  MobileChatHistoryPageDto,
  MobileChatSessionDto,
  MobileCreationOutputRecord
} from "../dto.js";
import { requireMobileAuth, sendMobileError } from "../httpErrors.js";
import { mobileAuthError, mobileChatListOpenApiQuery, mobileChatListQuerySchema } from "../schemas.js";

type HistoryDraft = {
  id: string; payload: unknown; status: string; archived: boolean;
  createdProjectId: string | null; createdAt: Date; updatedAt: Date;
  outputs?: MobileCreationOutputRecord[];
};
type Position = { id: string; activityAt: Date };
const cursorSchema = z.object({
  v: z.literal(1), id: z.string().min(1).max(64), at: z.iso.datetime(),
  archived: z.boolean(), q: z.string().max(200)
});

function serializeHistoryDraft(draft: HistoryDraft): MobileChatSessionDto | null {
  const parsed = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  const messages = payload.messages?.length ? conversationMessagesFromPayload(payload) : [];
  const last = messages.at(-1);
  const outputs = creationOutputsForDraft(draft, payload);
  return {
    draftId: draft.id,
    title: _chatTitleForPayload(payload),
    preview: last ? chatMessagePreviewSource(last.role, last.content).replace(/\s+/g, " ").trim().slice(0, 100) : "",
    messageCount: messages.length,
    status: draft.status,
    archived: draft.archived,
    createdProjectId: draft.createdProjectId,
    activeProjectId: activeProjectIdForDraft(draft, outputs),
    outputs,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
    lastMessageAt: payload.lastMessageAt ?? draft.updatedAt.toISOString()
  } satisfies MobileChatSessionDto;
}

function encodeCursor(position: Position, archived: boolean, q: string) {
  return Buffer.from(JSON.stringify({ v: 1, id: position.id, at: position.activityAt.toISOString(), archived, q })).toString("base64url");
}

function decodeCursor(value: string, archived: boolean, q: string): Position | null {
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.archived !== archived || cursor.q !== q) return null;
    return { id: cursor.id, activityAt: new Date(cursor.at) };
  } catch {
    return null;
  }
}

/** Sort and seek before loading transcripts or output relations. A value cursor
 * still works if its draft was deleted, archived, or updated between requests.
 * Dates in the payload are UTC; legacy drafts fall back to the row timestamp.
 */
export async function loadHistoryPositions(userId: string, archived: boolean, after: Position | null, limit: number) {
  return prisma.$queryRaw<Position[]>`
    SELECT "id", "activityAt" FROM (
      SELECT "id", CASE
        WHEN "payload"->>'lastMessageAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
          AND pg_input_is_valid("payload"->>'lastMessageAt', 'timestamptz')
          THEN ("payload"->>'lastMessageAt')::timestamptz
        ELSE "updatedAt" AT TIME ZONE 'UTC'
      END AS "activityAt"
      FROM "MobileCreationDraft"
      WHERE "userId" = ${userId} AND "archived" = ${archived}
    ) AS history
    WHERE (${after?.activityAt ?? null}::timestamptz IS NULL
      OR ("activityAt", "id") < (${after?.activityAt ?? null}::timestamptz, ${after?.id ?? ""}))
    ORDER BY "activityAt" DESC, "id" DESC
    LIMIT ${limit}
  `;
}

/** Positions one GET may walk while filling a search page. Empty `q` still
 * returns from the first `limit+1` batch and never reaches this. */
export const HISTORY_SCAN_CAP = 300;

export async function listHistoryPage(userId: string, archived: boolean, q: string, limit: number, after: Position | null) {
  const matches: Array<{ session: MobileChatSessionDto; position: Position }> = [];
  const batchSize = limit + 1;
  let scanned = 0;
  // Search uses the same visible titles and previews as the drawer. Scan in
  // bounded batches so malformed drafts and non-matches never hide later chats.
  while (true) {
    const positions = await loadHistoryPositions(userId, archived, after, batchSize);
    if (positions.length === 0) break;
    const drafts = await prisma.mobileCreationDraft.findMany({
      where: { userId, archived, id: { in: positions.map((position) => position.id) } },
      include: mobileCreationDraftOutputsInclude()
    });
    const byId = new Map(drafts.map((draft) => [draft.id, draft]));
    for (const position of positions) {
      const draft = byId.get(position.id);
      const session = draft ? serializeHistoryDraft(draft) : null;
      if (!session || (q && !session.title.toLowerCase().includes(q) && !session.preview.toLowerCase().includes(q))) continue;
      matches.push({ session, position });
      if (matches.length > limit) {
        return {
          sessions: matches.slice(0, limit).map((match) => match.session),
          nextCursor: encodeCursor(matches[limit - 1]!.position, archived, q)
        } satisfies MobileChatHistoryPageDto;
      }
    }
    scanned += positions.length;
    if (positions.length < batchSize) break;
    after = positions.at(-1)!;
    if (scanned >= HISTORY_SCAN_CAP) {
      return {
        sessions: matches.map((match) => match.session),
        nextCursor: encodeCursor(after, archived, q)
      } satisfies MobileChatHistoryPageDto;
    }
  }
  return { sessions: matches.map((match) => match.session), nextCursor: null } satisfies MobileChatHistoryPageDto;
}

export function registerCreationSessionHistoryRoute(fastify: FastifyInstance) {
  fastify.get("/api/mobile/creation-sessions", {
    attachValidation: true,
    schema: {
      tags: ["mobile"], querystring: mobileChatListOpenApiQuery,
      response: { 400: mobileAuthError, 401: mobileAuthError }
    }
  }, async (request, reply) => {
    const auth = await requireMobileAuth(request, reply);
    if (!auth) return;
    const parsed = mobileChatListQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a valid chat history page.");
    const query = parsed.data;
    const archived = query.archived === "true";
    const q = query.q?.toLowerCase() ?? "";
    if (query.limit !== undefined || query.cursor !== undefined || query.q !== undefined) {
      const after = query.cursor ? decodeCursor(query.cursor, archived, q) : null;
      if (query.cursor && !after) return sendMobileError(reply, 400, "VALIDATION_ERROR", "Refresh the chat history and try again.");
      return (await listHistoryPage(auth.user.id, archived, q, query.limit ?? 30, after)) satisfies MobileChatHistoryPageDto;
    }
    // Preserve the response used by older clients and the Account archive list.
    const drafts = await prisma.mobileCreationDraft.findMany({
      where: { userId: auth.user.id, archived }, orderBy: { updatedAt: "desc" },
      ...(!archived ? { take: 100 } : {}), include: mobileCreationDraftOutputsInclude()
    });
    const sessions = drafts.flatMap((draft) => {
      const session = serializeHistoryDraft(draft);
      return session ? [session] : [];
    });
    sessions.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    return { sessions } satisfies MobileChatHistoryDto;
  });
}
