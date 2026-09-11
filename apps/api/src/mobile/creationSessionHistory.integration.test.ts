import { randomUUID } from "node:crypto";
import { prisma } from "@book-maker/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listHistoryPage, loadHistoryPositions } from "./routes/creationSessionHistory.js";

// Uses only uniquely named fixture accounts in the configured local database.
// Without CHAT_HISTORY_INTEGRATION=1, naming this file reports "No test files found" — that is the collect exclusion.
// CHAT_HISTORY_INTEGRATION=1 pnpm --filter @book-maker/api test src/mobile/creationSessionHistory.integration.test.ts
const enabled = process.env.CHAT_HISTORY_INTEGRATION === "1";
const prefix = `history-${randomUUID()}`;
const userId = `${prefix}-user`;
const otherId = `${prefix}-other`;
const at = new Date("2026-06-01T12:00:00.000Z");
const idFor = (index: number) => `${prefix}-${String(index).padStart(3, "0")}`;
const payload = (index: number) => ({
  payloadVersion: 3,
  rawIdea: index === 0 ? "Moon garden" : `Book ${index}`,
  messages: [{ role: "user", content: index === 0 ? "Moon garden" : `Book ${index}` }],
  // Every three chats share a timestamp, exercising the id tie-breaker.
  lastMessageAt: new Date(at.getTime() + Math.floor(index / 3) * 1000).toISOString()
});

describe.skipIf(!enabled)("chat history keyset pagination (PostgreSQL)", () => {
  beforeAll(async () => {
    await prisma.user.createMany({ data: [userId, otherId].map((id) => ({ id, email: `${id}@example.invalid` })) });
    await prisma.mobileCreationDraft.createMany({ data: [
      ...Array.from({ length: 145 }, (_, index) => ({ id: idFor(index), userId, payload: payload(index) })),
      { id: `${prefix}-archived`, userId, archived: true, payload: payload(0) },
      { id: `${prefix}-private`, userId: otherId, payload: payload(0) },
      { id: `${prefix}-invalid`, userId, payload: { lastMessageAt: "not a date" } }
    ] });
  });

  afterAll(async () => {
    await prisma.mobileCreationDraft.deleteMany({ where: { userId: { in: [userId, otherId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.$disconnect();
  });

  it("reads all 145 chats once despite equal timestamps, insertion, and a deleted cursor row", async () => {
    let page = await listHistoryPage(userId, false, "", 30, null);
    const ids = page.sessions.map((session) => session.draftId);
    expect(ids).toHaveLength(30);
    expect(ids[0]).toBe(idFor(144));
    const boundaryId = ids.at(-1)!;
    await prisma.mobileCreationDraft.delete({ where: { id: boundaryId } });
    await prisma.mobileCreationDraft.create({ data: { id: `${prefix}-new`, userId, payload: payload(900) } });
    let requests = 1;
    while (page.nextCursor) {
      const cursor = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString());
      page = await listHistoryPage(userId, false, "", 30, { id: cursor.id, activityAt: new Date(cursor.at) });
      expect(page.sessions.length).toBeLessThanOrEqual(30);
      ids.push(...page.sessions.map((session) => session.draftId));
      expect(++requests).toBeLessThan(8);
    }
    expect(ids).toEqual(Array.from({ length: 145 }, (_, index) => idFor(144 - index)));
    expect(new Set(ids).size).toBe(145);
  });

  it("search reaches the oldest chat and excludes archived and other accounts' chats", async () => {
    const page = await listHistoryPage(userId, false, "moon", 30, null);
    expect(page.sessions.map((session) => session.draftId)).toEqual([idFor(0)]);
    expect(page.nextCursor).toBeNull();
  });

  it("legacy dates fall back safely and the SQL query itself is bounded", async () => {
    await prisma.mobileCreationDraft.create({ data: {
      id: `${prefix}-legacy`, userId,
      payload: { payloadVersion: 3, rawIdea: "Legacy book", messages: [{ role: "user", content: "Legacy book" }] },
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    } });
    const positions = await loadHistoryPositions(userId, false, null, 3);
    expect(positions).toHaveLength(3);
    const page = await listHistoryPage(userId, false, "legacy", 30, null);
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]?.lastMessageAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
