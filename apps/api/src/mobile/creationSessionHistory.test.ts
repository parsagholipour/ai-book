import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { bearer, buildMobileApp, creationDraftRecord, mockAccessTokens, mockPrisma, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import { HISTORY_SCAN_CAP, loadHistoryPositions } from "./routes/creationSessionHistory.js";

const at = new Date("2026-09-11T12:00:00.000Z");
const position = (id: string) => ({ id, activityAt: at });
const draft = (id: string, title = id) => creationDraftRecord({ id, payload: {
  payloadVersion: 3, rawIdea: title, messages: [{ role: "user", content: title }], lastMessageAt: at.toISOString()
} });

describe("mobile chat history pages", () => {
  beforeEach(() => { resetMobileHarness(); mockAccessTokens({ "token-a": "user-a" }); });
  afterEach(teardownMobileHarness);

  it("returns a bounded page and a value cursor, in database activity order", async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([position("c"), position("b"), position("a")]);
    mockPrisma.mobileCreationDraft.findMany.mockResolvedValueOnce([draft("a"), draft("b"), draft("c")]);
    const app = await buildMobileApp({ creationEnrichment: false });
    const first = await app.inject({ method: "GET", url: "/api/mobile/creation-sessions?limit=2", headers: bearer("token-a") });
    expect(first.statusCode).toBe(200);
    expect(first.json().sessions.map((session: { draftId: string }) => session.draftId)).toEqual(["c", "b"]);
    const cursor = first.json().nextCursor;
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString())).toMatchObject({ id: "b", at: at.toISOString() });
    expect(mockPrisma.mobileCreationDraft.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-a", archived: false, id: { in: ["c", "b", "a"] } }
    }));
    mockPrisma.$queryRaw.mockResolvedValueOnce([position("a")]);
    mockPrisma.mobileCreationDraft.findMany.mockResolvedValueOnce([draft("a")]);
    const next = await app.inject({ method: "GET", url: `/api/mobile/creation-sessions?limit=2&cursor=${cursor}`, headers: bearer("token-a") });
    expect(next.statusCode).toBe(200);
    expect(next.json().sessions.map((session: { draftId: string }) => session.draftId)).toEqual(["a"]);
    expect(next.json().nextCursor).toBeNull();
    expect(mockPrisma.$queryRaw.mock.calls.at(-1)?.slice(1)).toEqual(["user-a", false, at, at, "b", 3]);
    await app.close();
  });

  it("searches beyond nonmatching pages and skips malformed drafts", async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([position("f"), position("e"), position("d")])
      .mockResolvedValueOnce([position("c"), position("b")]);
    mockPrisma.mobileCreationDraft.findMany
      .mockResolvedValueOnce([draft("f", "Sea"), draft("e", "City"), creationDraftRecord({ id: "d", payload: null })])
      .mockResolvedValueOnce([draft("c", "The moon garden"), draft("b", "Moon stories")]);
    const app = await buildMobileApp({ creationEnrichment: false });
    const response = await app.inject({ method: "GET", url: "/api/mobile/creation-sessions?limit=2&q=MOON", headers: bearer("token-a") });
    expect(response.statusCode).toBe(200);
    expect(response.json().sessions.map((session: { draftId: string }) => session.draftId)).toEqual(["c", "b"]);
    expect(response.json().nextCursor).toBeNull();
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("returns a last-scanned cursor when a sparse search hits the cap before filling the page", async () => {
    const ids = Array.from({ length: HISTORY_SCAN_CAP + 4 }, (_, index) => `s${String(index).padStart(3, "0")}`);
    let offset = 0;
    mockPrisma.$queryRaw.mockImplementation((...args: unknown[]) => {
      const take = args.at(-1) as number;
      const batch = ids.slice(offset, offset + take).map((id) => position(id));
      offset += batch.length;
      return Promise.resolve(batch);
    });
    mockPrisma.mobileCreationDraft.findMany.mockImplementation((args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => draft(id, id === "s000" ? "Moon garden" : "Sea"))
    );
    const app = await buildMobileApp({ creationEnrichment: false });
    const response = await app.inject({ method: "GET", url: "/api/mobile/creation-sessions?limit=2&q=moon", headers: bearer("token-a") });
    expect(response.statusCode).toBe(200);
    expect(response.json().sessions.map((session: { draftId: string }) => session.draftId)).toEqual(["s000"]);
    expect(JSON.parse(Buffer.from(response.json().nextCursor, "base64url").toString())).toMatchObject({
      id: ids[HISTORY_SCAN_CAP - 1], at: at.toISOString(), q: "moon"
    });
    expect(mockPrisma.$queryRaw.mock.calls.at(-1)?.at(-1)).toBe(3);
    await app.close();
  });

  it("rejects invalid cursors, page sizes, and cursors from another search", async () => {
    const app = await buildMobileApp({ creationEnrichment: false });
    const foreignQueryCursor = Buffer.from(JSON.stringify({ v: 1, id: "b", at: at.toISOString(), archived: false, q: "sea" })).toString("base64url");
    for (const query of ["limit=0", "limit=101", "limit=1.5", "cursor=garbage", `cursor=${foreignQueryCursor}&q=moon`]) {
      const response = await app.inject({ method: "GET", url: `/api/mobile/creation-sessions?${query}`, headers: bearer("token-a") });
      expect(response.statusCode).toBe(400);
    }
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires authentication before reading any history", async () => {
    const app = await buildMobileApp({ creationEnrichment: false });
    const response = await app.inject({ method: "GET", url: "/api/mobile/creation-sessions?limit=30" });
    expect(response.statusCode).toBe(401);
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("compares and returns activityAt as UTC timestamptz, not naive timestamp", async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    await loadHistoryPositions("user-a", false, position("b"), 3);
    const [strings] = mockPrisma.$queryRaw.mock.calls.at(-1) as [readonly string[], ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toContain("pg_input_is_valid(\"payload\"->>'lastMessageAt', 'timestamptz')");
    expect(sql).toContain("(\"payload\"->>'lastMessageAt')::timestamptz");
    expect(sql).toContain("\"updatedAt\" AT TIME ZONE 'UTC'");
    expect(sql).toMatch(/\?::timestamptz IS NULL/);
    expect(sql).toMatch(/\(\?::timestamptz, \?\)/);
    expect(sql).not.toMatch(/::timestamp(?:\(\d+\))?(?!tz)/);
    expect(sql).not.toMatch(/'timestamp'(?!tz)/);
  });
});
