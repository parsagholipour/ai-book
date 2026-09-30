import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import type { FastifyInstance } from "fastify";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  MockPrismaKnownRequestError,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * Book notes (`.scratch/book-notes/spec.md`). The `bookNote` delegates are
 * backed by a small in-memory store below, so "the conflict moved nothing"
 * and "the pin left the clocks alone" are claims about rows, not about call
 * arguments.
 */

type Row = Record<string, any>;

let projects: Row[];
let notes: Row[];
let nextId: number;

const AUTH = bearer("token-a");
const OTHER = bearer("token-b");
const START = new Date("2026-09-30T12:00:00.000Z");
/** Fails the old screen outright (`manuscriptContentScreen.test.ts`); a note stores it anyway. */
const HARMFUL = "Step-by-step instructions to build a bomb.";

function advance(ms = 1000): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === "projectId_requestId") {
      return row.projectId === value.projectId && row.requestId === value.requestId;
    }
    return row[key] === value;
  });
}

function compare(left: unknown, right: unknown): number {
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === "boolean" || typeof right === "boolean") return Number(left) - Number(right);
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function ordered(rows: Row[], orderBy: Row[] | undefined): Row[] {
  return [...rows].sort((left, right) => {
    for (const key of orderBy ?? []) {
      const [field, direction] = Object.entries(key)[0]!;
      const result = compare(left[field], right[field]);
      if (result !== 0) return direction === "desc" ? -result : result;
    }
    return 0;
  });
}

function select(row: Row, fields: Row | undefined): Row {
  if (!fields) return { ...row };
  return Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]));
}

/** The table, as far as `bookNotes.ts` asks of it — unique index and FK included. */
function installNoteStore(): void {
  mockPrisma.project.findFirst.mockImplementation(async ({ where, select: fields }: Row) => {
    const project = projects.find((candidate) => matches(candidate, where));
    return project ? select(project, fields) : null;
  });
  mockPrisma.bookNote.findMany.mockImplementation(async ({ where, orderBy }: Row) =>
    ordered(notes.filter((note) => matches(note, where)), orderBy).map((note) => ({ ...note }))
  );
  const findOne = async ({ where }: Row) => {
    const note = notes.find((candidate) => matches(candidate, where));
    return note ? { ...note } : null;
  };
  mockPrisma.bookNote.findFirst.mockImplementation(findOne);
  mockPrisma.bookNote.findUnique.mockImplementation(findOne);
  mockPrisma.bookNote.count.mockImplementation(async ({ where }: Row) => notes.filter((note) => matches(note, where)).length);
  mockPrisma.bookNote.create.mockImplementation(async ({ data }: Row) => {
    if (!projects.some((project) => project.id === data.projectId)) {
      throw new MockPrismaKnownRequestError("Foreign key constraint violated", { code: "P2003" });
    }
    if (notes.some((note) => note.projectId === data.projectId && note.requestId === data.requestId)) {
      throw new MockPrismaKnownRequestError("Unique constraint failed", {
        code: "P2002",
        meta: { target: ["projectId", "requestId"] }
      });
    }
    const now = new Date();
    const note = { id: `note-${++nextId}`, title: "", body: "", pinned: false, revision: 1, editedAt: now, createdAt: now, updatedAt: now, ...data };
    notes.push(note);
    return { ...note };
  });
  mockPrisma.bookNote.updateMany.mockImplementation(async ({ where, data }: Row) => {
    const hit = notes.filter((note) => matches(note, where));
    for (const note of hit) {
      for (const [key, value] of Object.entries(data as Row)) {
        note[key] = value && typeof value === "object" && "increment" in value ? note[key] + value.increment : value;
      }
      note.updatedAt = new Date();
    }
    return { count: hit.length };
  });
  mockPrisma.bookNote.deleteMany.mockImplementation(async ({ where }: Row) => {
    const before = notes.length;
    notes = notes.filter((note) => !matches(note, where));
    return { count: before - notes.length };
  });
}

function seedNote(overrides: Row = {}): Row {
  const now = new Date();
  const note = {
    id: `note-${++nextId}`,
    projectId: "book-generated",
    requestId: `seeded-request-${nextId}`,
    title: "",
    body: "Seeded",
    pinned: false,
    revision: 1,
    editedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
  notes.push(note);
  return note;
}

function notesUrl(projectId: string, noteId?: string): string {
  return `/api/mobile/projects/${projectId}/notes${noteId ? `/${noteId}` : ""}`;
}

function list(app: FastifyInstance, projectId: string, headers: Row = AUTH) {
  return app.inject({ method: "GET", url: notesUrl(projectId), headers });
}

function create(app: FastifyInstance, projectId: string, payload: Row, headers: Row = AUTH) {
  return app.inject({ method: "POST", url: notesUrl(projectId), headers, payload });
}

function patch(app: FastifyInstance, projectId: string, noteId: string, payload: Row, headers: Row = AUTH) {
  return app.inject({ method: "PATCH", url: notesUrl(projectId, noteId), headers, payload });
}

function remove(app: FastifyInstance, projectId: string, noteId: string, headers: Row = AUTH) {
  return app.inject({ method: "DELETE", url: notesUrl(projectId, noteId), headers });
}

/** Every key on the wire, at any depth — the leak guard is about keys, and a note's text may say anything. */
function wireKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(wireKeys);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [key, ...wireKeys(child)]);
  }
  return [];
}

function expectNoModelKey(body: unknown): void {
  expect(wireKeys(body).filter((key) => /model/i.test(key))).toEqual([]);
}

beforeEach(() => {
  resetMobileHarness();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  nextId = 0;
  notes = [];
  projects = [
    { id: "book-generated", userId: "user-a", status: "COMPLETE", mediaSettings: { mobile: { bookType: "short_story" } } },
    { id: "book-imported", userId: "user-a", status: "COMPLETE", mediaSettings: { mobile: { import: { format: "docx" } } } },
    { id: "book-studio", userId: "user-a", status: "DRAFT", mediaSettings: { mobile: { studio: { layout: "flow", kind: "story" } } } },
    { id: "book-planning", userId: "user-a", status: "PLANNING", mediaSettings: {} },
    { id: "book-other", userId: "user-b", status: "COMPLETE", mediaSettings: {} }
  ];
  installNoteStore();
  mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
});

afterEach(() => {
  vi.useRealTimers();
  teardownMobileHarness();
});

describe("listing a book's notes", () => {
  it("puts pinned notes first, then the most recent title/body change, with the limit and no-store", async () => {
    const app = await buildMobileApp();
    const oldest = (await create(app, "book-generated", { requestId: "note-request-0001", title: "Oldest", body: "a" })).json().note;
    advance();
    const middle = (await create(app, "book-generated", { requestId: "note-request-0002", title: "Middle", body: "b" })).json().note;
    advance();
    const newest = (await create(app, "book-generated", { requestId: "note-request-0003", title: "Newest", body: "c" })).json().note;
    advance();
    // A pin does not move `editedAt`, so it is the pin alone that lifts the oldest.
    expect((await patch(app, "book-generated", oldest.id, { pinned: true })).statusCode).toBe(200);
    advance();
    expect((await patch(app, "book-generated", middle.id, { body: "b, revised", baseRevision: 1 })).statusCode).toBe(200);

    const response = await list(app, "book-generated");

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body.limit).toBe(200);
    expect(body.notes.map((note: Row) => note.id)).toEqual([oldest.id, middle.id, newest.id]);
    expect(body.notes[0]).toEqual({
      id: oldest.id,
      title: "Oldest",
      body: "a",
      pinned: true,
      revision: 1,
      createdAt: START.toISOString(),
      editedAt: START.toISOString()
    });
    expectNoModelKey(body);
  });

  it("breaks an editedAt tie by the newer create", async () => {
    const app = await buildMobileApp();
    seedNote({ id: "note-older", title: "Older", editedAt: START, createdAt: new Date(START.getTime() - 5000) });
    seedNote({ id: "note-newer", title: "Newer", editedAt: START, createdAt: new Date(START.getTime() - 1000) });

    const ids = (await list(app, "book-generated")).json().notes.map((note: Row) => note.id);

    expect(ids).toEqual(["note-newer", "note-older"]);
  });

  it("works on every kind of book the caller owns, in any status", async () => {
    const app = await buildMobileApp();
    for (const projectId of ["book-generated", "book-imported", "book-studio", "book-planning"]) {
      const created = await create(app, projectId, { requestId: `request-${projectId}`, body: `Idea for ${projectId}` });
      expect(created.statusCode).toBe(201);
      expect((await list(app, projectId)).json().notes).toEqual([created.json().note]);
    }
  });
});

describe("creating a note", () => {
  it("answers 201 with the note, and a replayed requestId 200 with the note as it is now", async () => {
    const app = await buildMobileApp();
    const first = await create(app, "book-generated", { requestId: "note-request-0001", title: "Harbour", body: "The lamp is red." });
    expect(first.statusCode).toBe(201);
    const note = first.json().note;
    expect(note).toMatchObject({ title: "Harbour", body: "The lamp is red.", pinned: false, revision: 1 });
    expectNoModelKey(first.json());

    advance();
    await patch(app, "book-generated", note.id, { body: "The lamp is green.", baseRevision: 1 });
    const replay = await create(app, "book-generated", { requestId: "note-request-0001", title: "Harbour", body: "The lamp is red." });

    expect(replay.statusCode).toBe(200);
    expect(replay.json().note).toMatchObject({ id: note.id, body: "The lamp is green.", revision: 2 });
    expect(notes).toHaveLength(1);
  });

  it("keys the replay by book, so the same requestId on another book is a new note", async () => {
    const app = await buildMobileApp();
    await create(app, "book-generated", { requestId: "note-request-0001", body: "One" });
    const other = await create(app, "book-studio", { requestId: "note-request-0001", body: "Two" });

    expect(other.statusCode).toBe(201);
    expect(notes.map((note) => note.projectId)).toEqual(["book-generated", "book-studio"]);
  });

  it("answers the winner's note when a concurrent create with the same requestId lands first", async () => {
    const app = await buildMobileApp();
    // The winner commits between this request's replay lookup and its insert.
    mockPrisma.bookNote.findUnique.mockImplementationOnce(async () => {
      seedNote({ id: "note-winner", requestId: "note-request-0001", body: "From the other retry" });
      return null;
    });

    const response = await create(app, "book-generated", { requestId: "note-request-0001", body: "From this retry" });

    expect(response.statusCode).toBe(200);
    expect(response.json().note).toMatchObject({ id: "note-winner", body: "From the other retry" });
    expect(notes).toHaveLength(1);
  });

  it("refuses a note whose title and body are both blank after trimming", async () => {
    const app = await buildMobileApp();
    for (const payload of [
      { requestId: "note-request-0001" },
      { requestId: "note-request-0002", title: "   ", body: "\n\t " },
      { requestId: "note-request-0003", pinned: true }
    ]) {
      const response = await create(app, "book-generated", payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("EMPTY_NOTE");
    }
    expect(notes).toEqual([]);
  });

  it("stores the title and body exactly as written, unscreened", async () => {
    const app = await buildMobileApp();
    const response = await create(app, "book-generated", { requestId: "note-request-0001", title: "  Research ", body: `${HARMFUL}\n` });

    expect(response.statusCode).toBe(201);
    expect(response.json().note).toMatchObject({ title: "  Research ", body: `${HARMFUL}\n` });
    expect(notes[0]).toMatchObject({ title: "  Research ", body: `${HARMFUL}\n` });
  });

  it("refuses the 201st note with NOTE_LIMIT, but still answers a replay", async () => {
    const app = await buildMobileApp();
    for (let index = 0; index < 200; index += 1) {
      seedNote({ requestId: `seeded-request-${String(index).padStart(4, "0")}` });
    }

    const refused = await create(app, "book-generated", { requestId: "note-request-0201", body: "One too many" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: { code: "NOTE_LIMIT", message: "A book can hold 200 notes. Delete one to add another." }
    });
    expect(notes).toHaveLength(200);

    const replay = await create(app, "book-generated", { requestId: "seeded-request-0007", body: "Seeded" });
    expect(replay.statusCode).toBe(200);
    // Another book has its own 200.
    expect((await create(app, "book-studio", { requestId: "note-request-0201", body: "Elsewhere" })).statusCode).toBe(201);
  });

  it("holds the title to 200 characters, the body to 30,000 and the requestId to 8..100", async () => {
    const app = await buildMobileApp();
    const cases: Array<[Row, number]> = [
      [{ requestId: "note-request-0001", title: "t".repeat(200), body: "b".repeat(30_000) }, 201],
      [{ requestId: "note-request-0002", title: "t".repeat(201), body: "b" }, 400],
      [{ requestId: "note-request-0003", body: "b".repeat(30_001) }, 400],
      [{ requestId: "short-7", body: "b" }, 400],
      [{ requestId: "r".repeat(100), body: "b" }, 201],
      [{ requestId: "r".repeat(101), body: "b" }, 400],
      [{ body: "b" }, 400],
      [{ requestId: "note-request-0004", body: "b", pinned: "yes" }, 400]
    ];
    for (const [payload, status] of cases) {
      const response = await create(app, "book-generated", payload);
      expect([payload, response.statusCode]).toEqual([payload, status]);
      if (status === 400) expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(notes).toHaveLength(2);
  });

  it("answers a body it cannot parse in the mobile error shape", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: notesUrl("book-generated"),
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "{not json"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: "That request could not be read." } });
  });

  it("is rate limited as a draft write", async () => {
    const app = await buildMobileApp({ draftRateLimit: { maxAttempts: 1, windowMs: 60_000 } });
    expect((await create(app, "book-generated", { requestId: "note-request-0001", body: "One" })).statusCode).toBe(201);

    const limited = await create(app, "book-generated", { requestId: "note-request-0002", body: "Two" });

    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
  });
});

describe("editing a note", () => {
  it("bumps the revision and editedAt on a text change, and writes nothing for identical values", async () => {
    const app = await buildMobileApp();
    const note = seedNote({ title: "Plot", body: "Act one." });
    advance(60_000);

    const saved = await patch(app, "book-generated", note.id, { title: "Plot", body: "Act one, revised.", baseRevision: 1 });

    expect(saved.statusCode).toBe(200);
    const edited = saved.json().note;
    expect(edited).toMatchObject({ id: note.id, title: "Plot", body: "Act one, revised.", revision: 2 });
    expect(edited.editedAt).toBe(new Date(START.getTime() + 60_000).toISOString());
    expect(edited.createdAt).toBe(START.toISOString());
    expectNoModelKey(saved.json());

    advance(60_000);
    mockPrisma.bookNote.updateMany.mockClear();
    const same = await patch(app, "book-generated", note.id, { title: "Plot", body: "Act one, revised.", baseRevision: 2 });

    expect(same.statusCode).toBe(200);
    expect(same.json().note).toEqual(edited);
    expect(mockPrisma.bookNote.updateMany).not.toHaveBeenCalled();
  });

  it("may empty a note; only a create is refused for being blank", async () => {
    const app = await buildMobileApp();
    const note = seedNote({ title: "Draft", body: "Words" });

    const response = await patch(app, "book-generated", note.id, { title: "", body: "", baseRevision: 1 });

    expect(response.statusCode).toBe(200);
    expect(response.json().note).toMatchObject({ title: "", body: "", revision: 2 });
  });

  it("answers a stale baseRevision with NOTE_CONFLICT and the server copy inside error, moving nothing", async () => {
    const app = await buildMobileApp();
    const note = seedNote({ body: "Their newer text", revision: 3 });

    const response = await patch(app, "book-generated", note.id, { body: "My older text", baseRevision: 2 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "NOTE_CONFLICT",
        message: "This note was changed on another device. Both versions are kept.",
        note: {
          id: note.id,
          title: "",
          body: "Their newer text",
          pinned: false,
          revision: 3,
          createdAt: START.toISOString(),
          editedAt: START.toISOString()
        }
      }
    });
    expectNoModelKey(response.json());
    expect(notes[0]).toMatchObject({ body: "Their newer text", revision: 3 });
  });

  it("checks the revision in the write itself, so a save that loses a race answers the winner", async () => {
    const app = await buildMobileApp();
    const note = seedNote({ body: "Original" });
    // Another device's save commits after this request read revision 1 and
    // before its own write.
    const storeUpdate = mockPrisma.bookNote.updateMany.getMockImplementation() as (args: Row) => Promise<unknown>;
    mockPrisma.bookNote.updateMany.mockImplementationOnce(async (args: Row) => {
      Object.assign(notes[0]!, { body: "The other device", revision: 2 });
      return storeUpdate(args);
    });

    const response = await patch(app, "book-generated", note.id, { body: "This device", baseRevision: 1 });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "NOTE_CONFLICT", note: { body: "The other device", revision: 2 } });
    expect(notes[0]).toMatchObject({ body: "The other device", revision: 2 });
  });

  it("refuses a title or body change without baseRevision, and a body with nothing to change", async () => {
    const app = await buildMobileApp();
    const note = seedNote();
    for (const payload of [{ body: "New" }, { title: "New" }, {}, { baseRevision: 1 }, { pinned: true, baseRevision: 0 }]) {
      const response = await patch(app, "book-generated", note.id, payload);
      expect([payload, response.statusCode, response.json().error.code]).toEqual([payload, 400, "VALIDATION_ERROR"]);
    }
    expect(notes[0]).toMatchObject({ body: "Seeded", revision: 1, pinned: false });
  });

  it("pins and unpins without moving the revision or editedAt", async () => {
    const app = await buildMobileApp();
    const note = seedNote({ revision: 4 });
    advance(60_000);

    const pinned = await patch(app, "book-generated", note.id, { pinned: true });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().note).toMatchObject({ pinned: true, revision: 4, editedAt: START.toISOString() });

    advance(60_000);
    const unpinned = await patch(app, "book-generated", note.id, { pinned: false });
    expect(unpinned.json().note).toMatchObject({ pinned: false, revision: 4, editedAt: START.toISOString() });
  });

  it("honours a baseRevision sent with a pin, and applies a pin and text together under one revision", async () => {
    const app = await buildMobileApp();
    const note = seedNote({ revision: 2 });

    const stale = await patch(app, "book-generated", note.id, { pinned: true, baseRevision: 1 });
    expect(stale.statusCode).toBe(409);
    expect(notes[0]!.pinned).toBe(false);

    const both = await patch(app, "book-generated", note.id, { pinned: true, body: "Pinned and edited", baseRevision: 2 });
    expect(both.statusCode).toBe(200);
    expect(both.json().note).toMatchObject({ pinned: true, body: "Pinned and edited", revision: 3 });
  });

  it("is not rate limited, because it is the editor's autosave", async () => {
    const app = await buildMobileApp({ draftRateLimit: { maxAttempts: 1, windowMs: 60_000 } });
    const note = seedNote();
    for (let revision = 1; revision <= 5; revision += 1) {
      const response = await patch(app, "book-generated", note.id, { body: `Draft ${revision}`, baseRevision: revision });
      expect(response.statusCode).toBe(200);
    }
  });
});

describe("deleting a note", () => {
  it("deletes it for good, then answers NOTE_NOT_FOUND to every note route", async () => {
    const app = await buildMobileApp();
    const note = seedNote();
    const kept = seedNote({ body: "Kept" });

    const deleted = await remove(app, "book-generated", note.id);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect(notes.map((row) => row.id)).toEqual([kept.id]);

    const again = await remove(app, "book-generated", note.id);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: { code: "NOTE_NOT_FOUND", message: "That note no longer exists." } });
    const edit = await patch(app, "book-generated", note.id, { body: "Back?", baseRevision: 1 });
    expect(edit.statusCode).toBe(404);
    expect(edit.json().error.code).toBe("NOTE_NOT_FOUND");
    expect((await list(app, "book-generated")).json().notes.map((row: Row) => row.id)).toEqual([kept.id]);
  });

  it("lets the app undo a delete by creating the note again under a fresh requestId", async () => {
    const app = await buildMobileApp();
    const note = seedNote({ title: "Keep", body: "Me", pinned: true });
    await remove(app, "book-generated", note.id);

    const restored = await create(app, "book-generated", { requestId: "undo-request-0001", title: "Keep", body: "Me", pinned: true });

    expect(restored.statusCode).toBe(201);
    expect(restored.json().note).toMatchObject({ title: "Keep", body: "Me", pinned: true, revision: 1 });
  });
});

describe("who may reach a notebook", () => {
  it("answers another user's book with PROJECT_NOT_FOUND on every route, touching nothing", async () => {
    const app = await buildMobileApp();
    const theirs = seedNote({ projectId: "book-other", body: "Private" });

    const responses = [
      await list(app, "book-other"),
      await create(app, "book-other", { requestId: "note-request-0001", body: "Mine now" }),
      await patch(app, "book-other", theirs.id, { body: "Mine now", baseRevision: 1 }),
      await remove(app, "book-other", theirs.id)
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("PROJECT_NOT_FOUND");
    }
    expect(notes).toEqual([theirs]);
  });

  it("answers a note of another book with NOTE_NOT_FOUND, even the caller's own", async () => {
    const app = await buildMobileApp();
    const theirs = seedNote({ projectId: "book-other", body: "Private" });
    const elsewhere = seedNote({ projectId: "book-studio", body: "Studio note" });

    for (const note of [theirs, elsewhere]) {
      const edit = await patch(app, "book-generated", note.id, { pinned: true });
      expect(edit.statusCode).toBe(404);
      expect(edit.json().error.code).toBe("NOTE_NOT_FOUND");
      const deleted = await remove(app, "book-generated", note.id);
      expect(deleted.statusCode).toBe(404);
      expect(deleted.json().error.code).toBe("NOTE_NOT_FOUND");
    }
    expect(notes).toHaveLength(2);
    expect(notes.every((note) => note.pinned === false)).toBe(true);
  });

  it("the other user reaches their own notebook and only theirs", async () => {
    const app = await buildMobileApp();
    seedNote({ projectId: "book-other", body: "Private" });
    seedNote({ projectId: "book-generated", body: "Mine" });

    const response = await list(app, "book-other", OTHER);

    expect(response.json().notes.map((note: Row) => note.body)).toEqual(["Private"]);
  });

  it("answers 401 without a token", async () => {
    const app = await buildMobileApp();
    const note = seedNote();
    const responses = [
      await list(app, "book-generated", {}),
      await create(app, "book-generated", { requestId: "note-request-0001", body: "x" }, {}),
      await patch(app, "book-generated", note.id, { pinned: true }, {}),
      await remove(app, "book-generated", note.id, {})
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("AUTH_REQUIRED");
    }
    expect(notes).toEqual([note]);
  });
});
