import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  bearer,
  buildMobileApp,
  creationDraftRecord,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("chat archiving", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it.each(["ACTIVE", "COMPLETED"])("archives and restores a %s chat without changing its contents or lifecycle", async (status) => {
    mockAccessTokens({ "token-a": "user-a" });
    const draft = creationDraftRecord({ status, revision: 7 });
    const original = structuredClone(draft);
    mockPrisma.mobileCreationDraft.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.id !== draft.id || where.userId !== draft.userId) return { count: 0 };
      Object.assign(draft, data);
      return { count: 1 };
    });
    mockPrisma.mobileCreationDraft.findMany.mockImplementation(async ({ where }) =>
      where.userId === draft.userId && where.archived === draft.archived ? [draft] : []
    );
    mockPrisma.mobileCreationDraft.findFirst.mockImplementation(async ({ where }) =>
      where.userId === draft.userId && where.id === draft.id ? draft : null
    );
    const app = await buildMobileApp({ creationEnrichment: false });
    const list = (archived = false) => app.inject({
      method: "GET", url: `/api/mobile/creation-sessions${archived ? "?archived=true" : ""}`, headers: bearer("token-a")
    });
    const setArchived = (archived: boolean) => app.inject({
      method: "PATCH", url: "/api/mobile/creation-sessions/draft-1/archive", headers: bearer("token-a"), payload: { archived }
    });

    expect((await list()).json().sessions).toMatchObject([{ archived: false }]);
    for (let retry = 0; retry < 2; retry++) {
      const response = await setArchived(true);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, archived: true });
    }
    expect((await list()).json().sessions).toEqual([]);
    expect((await list(true)).json().sessions).toMatchObject([{ archived: true }]);
    const opened = await app.inject({
      method: "GET", url: "/api/mobile/creation-sessions/draft-1", headers: bearer("token-a")
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().session).toMatchObject({ draftId: "draft-1", status, archived: true, revision: 7 });
    expect(draft).toEqual({ ...original, archived: true });
    expect(mockPrisma.mobileCreationDraft.updateMany).toHaveBeenLastCalledWith({
      where: { id: "draft-1", userId: "user-a" }, data: { archived: true }
    });

    expect((await setArchived(false)).statusCode).toBe(200);
    expect((await setArchived(false)).statusCode).toBe(200);
    expect((await list(true)).json().sessions).toEqual([]);
    expect((await list()).json().sessions).toHaveLength(1);
    expect(draft).toEqual(original);
    await app.close();
  });

  it.each([true, false])("scopes archive=%s writes to the authenticated owner", async (archived) => {
    mockAccessTokens({ "token-b": "user-b" });
    mockPrisma.mobileCreationDraft.updateMany.mockResolvedValueOnce({ count: 0 });
    const app = await buildMobileApp({ creationEnrichment: false });
    const response = await app.inject({
      method: "PATCH", url: "/api/mobile/creation-sessions/other-users-chat/archive", headers: bearer("token-b"), payload: { archived }
    });
    expect(response.statusCode).toBe(404);
    expect(mockPrisma.mobileCreationDraft.updateMany).toHaveBeenCalledWith({
      where: { id: "other-users-chat", userId: "user-b" }, data: { archived }
    });
    await app.close();
  });

  it("requires authentication for listing and archive changes", async () => {
    const app = await buildMobileApp({ creationEnrichment: false });
    const list = await app.inject({ method: "GET", url: "/api/mobile/creation-sessions?archived=true" });
    const patch = await app.inject({ method: "PATCH", url: "/api/mobile/creation-sessions/draft-1/archive", payload: { archived: true } });
    expect(list.statusCode).toBe(401);
    expect(patch.statusCode).toBe(401);
    expect(mockPrisma.mobileCreationDraft.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.mobileCreationDraft.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects invalid filters and archive requests without writing", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const app = await buildMobileApp({ creationEnrichment: false });
    for (const payload of [{}, { archived: "invalid" }, { archived: null }]) {
      const response = await app.inject({
        method: "PATCH", url: "/api/mobile/creation-sessions/draft-1/archive", headers: bearer("token-a"), payload
      });
      expect(response.statusCode).toBe(400);
    }
    const response = await app.inject({
      method: "GET", url: "/api/mobile/creation-sessions?archived=invalid", headers: bearer("token-a")
    });
    expect(response.statusCode).toBe(400);
    expect(mockPrisma.mobileCreationDraft.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.mobileCreationDraft.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["creation-sessions", "creation-drafts"])("excludes archived chats from %s automatic resume", async (path) => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValueOnce(null);
    const app = await buildMobileApp({ creationEnrichment: false });
    const response = await app.inject({ method: "GET", url: `/api/mobile/${path}/active`, headers: bearer("token-a") });
    expect(response.statusCode).toBe(200);
    expect(mockPrisma.mobileCreationDraft.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-a", status: "ACTIVE", archived: false }
    }));
    await app.close();
  });

  it("lists only the owner's archived chats without silently hiding archives beyond the sidebar limit", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findMany.mockResolvedValueOnce([]);
    const app = await buildMobileApp({ creationEnrichment: false });
    const response = await app.inject({ method: "GET", url: "/api/mobile/creation-sessions?archived=true", headers: bearer("token-a") });
    expect(response.statusCode).toBe(200);
    const query = mockPrisma.mobileCreationDraft.findMany.mock.calls[0]?.[0];
    expect(query.where).toEqual({ userId: "user-a", archived: true });
    expect(query.take).toBeUndefined();
    await app.close();
  });
});
