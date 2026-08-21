import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { reserveCredits } from "@book-maker/db/billing";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  MockPrismaKnownRequestError,
  mockPrisma,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { namesDeletedCharacter, namesOrphanedCharacterImage } from "./characterPhotoWrites.js";
import {
  constraintErrorText,
  namesMentionCharacterForeignKey,
  namesMentionCheckConstraint
} from "./characterWriteConflicts.js";

/**
 * The picture *on* a character: the photo upload, what the vision reading is
 * allowed to fill in behind it, and the reference claim that decides whether a
 * book draws from it. Split out of `characters.test.ts`, which keeps the CRUD,
 * the durable mentions and the portrait charge — the seam is the route group,
 * and every helper below serves this one. The image *history* routes (list,
 * promote, delete a version) are `characterImages.test.ts`, and the reader
 * itself is `characterPhotoVision.test.ts`.
 */

function characterRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "char-1",
    userId: "user-a",
    name: "Luna",
    description: "A brave night-flying rabbit.",
    fields: [{ key: "Age", value: "9" }],
    photoPath: null,
    photoKind: null,
    suggestedDescription: null,
    appearance: null,
    portraitPath: null,
    portraitSource: null,
    portraitStatus: "NONE",
    portraitError: null,
    portraitJobId: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    outgoingMentions: [],
    ...overrides
  };
}

const patchCharacter = (app: Awaited<ReturnType<typeof buildMobileApp>>, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/api/mobile/characters/${id}`, headers: bearer("token-a"), payload });

/** A real 1x1 PNG, so sharp can decode and re-encode it. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const visionReading = (overrides: Record<string, unknown> = {}) => ({
  imageKind: "illustration",
  confidence: 0.95,
  subjectCount: 1,
  suggestedDescription: "A round-faced girl in a yellow raincoat.",
  suggestedAppearance: "Around eight, short black hair, warm brown skin, yellow raincoat.",
  suggestedFields: [],
  ...overrides
});

const uploadPhoto = (app: Awaited<ReturnType<typeof buildMobileApp>>) =>
  app.inject({
    method: "PUT",
    url: "/api/mobile/characters/char-1/photo?filename=me.png&mimeType=image%2Fpng",
    headers: { ...bearer("token-a"), "content-type": "application/octet-stream" },
    payload: ONE_PIXEL_PNG
  });

/** The photo columns the upload always writes. */
const uploadWrite = () => mockPrisma.libraryCharacter.update.mock.calls[0]![0].data as Record<string, unknown>;

/**
 * The upload's compare-and-set writes, found by shape rather than by call
 * order: the appearance fill and the reference claim are two independent
 * conditional writes and either may be absent, so an index would silently
 * hand one test the other one's write.
 */
const conditionalWrite = (column: "portraitPath" | "appearance") => {
  const call = mockPrisma.libraryCharacter.updateMany.mock.calls.find(
    (entry: any[]) => column in (entry[0].data as Record<string, unknown>)
  );
  return call ? (call[0] as { data: Record<string, unknown>; where: Record<string, unknown> }) : null;
};

/**
 * The claim that moves the reference, or null when the upload left it alone.
 * It is a separate write from the photo columns precisely because it has to
 * re-assert the status it decided from — up to the vision budget passes in
 * between, and a portrait the reader started meanwhile owns the row.
 */
const referenceClaim = () => conditionalWrite("portraitPath")?.data ?? null;

const referenceClaimGuard = () => conditionalWrite("portraitPath")!.where;

/** The fill that records what the photo shows, or null when it was refused. */
const appearanceFill = () => conditionalWrite("appearance");

/**
 * What is actually on the volume for this account.
 *
 * Nothing sweeps `IMAGE_STORAGE_DIR/characters/`, so a file the routes can no
 * longer name is permanent growth — which makes "what is left on disk" an
 * assertion rather than a detail, and one that no count of Prisma calls can
 * stand in for.
 */
const storedFiles = (): string[] => {
  const userDir = join(state.imageStorageDir!, "characters", "user-a");
  return existsSync(userDir) ? readdirSync(userDir) : [];
};

/**
 * The character going away mid-write, in the two shapes the two writes report
 * it in: the version row's insert violating the image table's only foreign key,
 * and the pointer write finding no row.
 */
const deletedDuringUpload = (statement: "version row" | "pointer write") =>
  statement === "version row"
    ? new MockPrismaKnownRequestError(
        "Foreign key constraint violated on the constraint: `LibraryCharacterImage_characterId_fkey`",
        {
          code: "P2003",
          meta: {
            modelName: "LibraryCharacterImage",
            driverAdapterError: {
              cause: {
                originalCode: "23503",
                constraint: { index: "LibraryCharacterImage_characterId_fkey" }
              }
            }
          }
        }
      )
    : new MockPrismaKnownRequestError(
        "An operation failed because it depends on one or more records that were required but not found.",
        { code: "P2025", meta: { modelName: "LibraryCharacter", cause: "Record to update not found." } }
      );

function expectingUpload(current = characterRecord(), options: { claimWon?: boolean } = {}) {
  const row: Record<string, unknown> = { ...current };
  mockPrisma.libraryCharacter.findFirst.mockImplementation(async () => characterRecord({ ...row }));
  mockPrisma.libraryCharacter.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    Object.assign(row, data);
    return characterRecord({ ...row });
  });
  mockPrisma.libraryCharacter.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    // Both conditional writes go through here, so each is judged by its own
    // condition: the appearance fill loses to a look the row already has, and
    // `claimWon` speaks only for the reference claim.
    if ("appearance" in data ? Boolean(row.appearance) : options.claimWon === false) {
      return { count: 0 };
    }
    Object.assign(row, data);
    return { count: 1 };
  });
}

describe("mobile character photo routes", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    // The upload's own claim, won by default — the uncontended case these tests
    // are about. The races live in `characterWriteConflicts.test.ts`.
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(teardownMobileHarness);

  it("uploads a photo, re-encodes it, and serves it back", async () => {
    expectingUpload();
    // No vision provider configured — the default state for this harness, and
    // a real deployment without a key. The photo is still stored.
    const app = await buildMobileApp();
    const uploaded = await uploadPhoto(app);
    expect(uploaded.statusCode).toBe(200);
    const photoPath = uploadWrite().photoPath as string;
    expect(photoPath).toMatch(/^char-1-photo-/);
    expect(uploadWrite()).toMatchObject({ photoKind: null, suggestedDescription: null });
    expect(referenceClaim()).toBeNull();

    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord({ photoPath }));
    const served = await app.inject({
      method: "GET",
      url: "/api/mobile/characters/char-1/photo",
      headers: bearer("token-a")
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers["cache-control"]).toContain("private");
    await app.close();
  });

  it("adopts an uploaded illustration as the reference, free and without a job", async () => {
    expectingUpload();
    const characterPhotoVision = vi.fn().mockResolvedValue(visionReading());
    const app = await buildMobileApp({ characterPhotoVision });

    const uploaded = await uploadPhoto(app);

    expect(uploaded.statusCode).toBe(200);
    expect(uploadWrite()).toMatchObject({ photoKind: "ILLUSTRATION" });
    expect(referenceClaim()).toMatchObject({
      portraitSource: "ADOPTED_UPLOAD",
      portraitStatus: "READY",
      portraitError: null
    });
    // The claim re-asserts the status it decided from, so a portrait started
    // during the vision call keeps the row.
    expect(referenceClaimGuard()).toMatchObject({
      portraitStatus: { notIn: ["QUEUED", "GENERATING"] }
    });
    // Both columns now name the one uploaded file. The second copy existed so
    // that removing the photo could take the adopted reference with it; under
    // a retained history nothing unlinks on that path, and writing the bytes
    // twice would draw a duplicate tile in the strip.
    expect(referenceClaim()!.portraitPath).toBe(uploadWrite().photoPath);
    const userDir = join(state.imageStorageDir!, "characters", "user-a");
    expect(readFileSync(join(userDir, uploadWrite().photoPath as string)).length).toBeGreaterThan(0);
    // What makes it free: no charge, no attempt, no job, nothing dispatched.
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    expect(dispatchGenerationJob).not.toHaveBeenCalled();
    // And the app is told the character now reaches a book.
    expect(uploaded.json().character).toMatchObject({ usedInBooks: true, portraitSource: "adopted_upload" });
    await app.close();
  });

  it("stores a real photograph without drawing anything, and never touches the description", async () => {
    expectingUpload();
    const characterPhotoVision = vi.fn().mockResolvedValue(visionReading({ imageKind: "photograph" }));
    const app = await buildMobileApp({ characterPhotoVision });

    const uploaded = await uploadPhoto(app);

    expect(uploaded.statusCode).toBe(200);
    expect(uploadWrite()).toMatchObject({
      photoKind: "PHOTOGRAPH",
      suggestedDescription: "A round-faced girl in a yellow raincoat."
    });
    expect(referenceClaim()).toBeNull();
    // The suggestion is offered, never applied — that is the whole contract.
    expect(uploadWrite()).not.toHaveProperty("description");
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    expect(uploaded.json().character).toMatchObject({
      usedInBooks: false,
      photoKind: "photograph",
      description: "A brave night-flying rabbit.",
      suggestedDescription: "A round-faced girl in a yellow raincoat."
    });
    await app.close();
  });

  it("records what the photo shows as the character's appearance, unasked", async () => {
    // The one thing the upload applies rather than offers. An empty appearance
    // is not a neutral default: it is what lets the planner invent a look and
    // write it into every illustration prompt, where it beats the reference
    // image. Leaving the fix behind a tap leaves the default path broken.
    expectingUpload();
    const app = await buildMobileApp({
      characterPhotoVision: vi.fn().mockResolvedValue(visionReading({ imageKind: "photograph" }))
    });

    const uploaded = await uploadPhoto(app);

    expect(uploaded.statusCode).toBe(200);
    expect(appearanceFill()!.data).toEqual({
      appearance: "Around eight, short black hair, warm brown skin, yellow raincoat."
    });
    // A compare-and-set, not a field on the photo write: the vision budget
    // passes between reading the row and this, and the user may have typed one.
    expect(appearanceFill()!.where).toMatchObject({
      OR: [{ appearance: null }, { appearance: "" }]
    });
    const character = uploaded.json().character;
    expect(character.appearance).toBe("Around eight, short black hair, warm brown skin, yellow raincoat.");
    // Applied, so there is nothing left to offer — and the description, which
    // is the user's own prose, is still only ever a suggestion.
    expect(character.suggestedAppearance).toBeNull();
    expect(character.description).toBe("A brave night-flying rabbit.");
    await app.close();
  });

  it("never overwrites a look the user already has, and offers the new one instead", async () => {
    expectingUpload(characterRecord({ appearance: "Adult woman in a black hijab and a grey embroidered top." }));
    const app = await buildMobileApp({
      characterPhotoVision: vi.fn().mockResolvedValue(visionReading({ imageKind: "photograph" }))
    });

    const uploaded = await uploadPhoto(app);

    expect(uploaded.statusCode).toBe(200);
    // The write is still attempted — the row could have been cleared while the
    // photo was being read — and the database is what refuses it.
    expect(appearanceFill()).not.toBeNull();
    const character = uploaded.json().character;
    expect(character.appearance).toBe("Adult woman in a black hijab and a grey embroidered top.");
    expect(character.suggestedAppearance).toBe(
      "Around eight, short black hair, warm brown skin, yellow raincoat."
    );
    await app.close();
  });

  it("stores no appearance when the reading carries none", async () => {
    expectingUpload();
    const app = await buildMobileApp({
      characterPhotoVision: vi.fn().mockResolvedValue(visionReading({ suggestedAppearance: "" }))
    });

    const uploaded = await uploadPhoto(app);

    expect(uploaded.statusCode).toBe(200);
    // Absent rather than empty: "" would read downstream as a recorded look
    // that says nothing, which is worse than no look at all.
    expect(appearanceFill()).toBeNull();
    expect(uploaded.json().character).toMatchObject({ appearance: null, suggestedAppearance: null });
    await app.close();
  });

  it("lets the user write an appearance and clear it again", async () => {
    for (const [payload, written] of [
      [{ appearance: "Black hijab, grey embroidered top." }, "Black hijab, grey embroidered top."],
      // Sent-and-empty is a deliberate clear, and it has a meaning of its own:
      // it puts the character back to "no look recorded, defer to the picture".
      [{ appearance: "" }, null]
    ] as const) {
      vi.mocked(mockPrisma.libraryCharacter.update).mockClear();
      mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord({ appearance: "Something older." }));
      mockPrisma.libraryCharacter.update.mockResolvedValue(characterRecord());
      const app = await buildMobileApp();
      const patched = await patchCharacter(app, "char-1", payload);
      expect(patched.statusCode).toBe(200);
      expect(mockPrisma.libraryCharacter.update.mock.calls[0]![0].data).toMatchObject({ appearance: written });
      await app.close();
    }
  });

  it("refuses to adopt when the reading is unsure or the artwork holds a cast", async () => {
    for (const reading of [
      visionReading({ imageKind: "unknown" }),
      visionReading({ confidence: 0.4 }),
      visionReading({ subjectCount: 3 })
    ]) {
      vi.mocked(mockPrisma.libraryCharacter.update).mockClear();
      vi.mocked(mockPrisma.libraryCharacter.updateMany).mockClear();
      expectingUpload();
      const app = await buildMobileApp({ characterPhotoVision: vi.fn().mockResolvedValue(reading) });
      expect((await uploadPhoto(app)).statusCode).toBe(200);
      expect(referenceClaim()).toBeNull();
      await app.close();
    }
  });

  it("keeps a portrait the user paid for, and adopts over one they did not", async () => {
    // The paid portrait is excluded by the claim's own `where`, so it holds
    // even if the row moved while the photo was being read.
    expectingUpload(
      characterRecord({ portraitStatus: "READY", portraitPath: "char-1-portrait.webp", portraitSource: "GENERATED" })
    );
    const characterPhotoVision = vi.fn().mockResolvedValue(visionReading());
    const paidApp = await buildMobileApp({ characterPhotoVision });
    expect((await uploadPhoto(paidApp)).statusCode).toBe(200);
    expect(referenceClaimGuard()).toMatchObject({
      NOT: { AND: [{ portraitSource: "GENERATED" }, { portraitStatus: "READY" }] }
    });
    await paidApp.close();

    // A generated portrait that failed is not a portrait, so the reader's own
    // artwork is allowed to take its place.
    vi.mocked(mockPrisma.libraryCharacter.update).mockClear();
    vi.mocked(mockPrisma.libraryCharacter.updateMany).mockClear();
    expectingUpload(characterRecord({ portraitStatus: "FAILED", portraitSource: "GENERATED" }));
    const failedApp = await buildMobileApp({ characterPhotoVision });
    expect((await uploadPhoto(failedApp)).statusCode).toBe(200);
    expect(referenceClaim()).toMatchObject({ portraitStatus: "READY", portraitSource: "ADOPTED_UPLOAD" });
    await failedApp.close();
  });

  it("does not race the portrait job that owns the row", async () => {
    // An upload is not a portrait request, so this is a silent skip rather
    // than the 409 the portrait route answers — and the claim is refused by
    // the database, not by the snapshot the handler read 12 seconds ago.
    expectingUpload(characterRecord({ portraitStatus: "GENERATING" }), { claimWon: false });
    const app = await buildMobileApp({ characterPhotoVision: vi.fn().mockResolvedValue(visionReading()) });

    const uploaded = await uploadPhoto(app);

    expect(uploaded.statusCode).toBe(200);
    expect(uploadWrite()).toMatchObject({ photoKind: "ILLUSTRATION" });
    expect(referenceClaimGuard()).toMatchObject({
      portraitStatus: { notIn: ["QUEUED", "GENERATING"] }
    });
    expect(uploaded.json().character).toMatchObject({ portraitStatus: "generating", usedInBooks: false });
    await app.close();
  });

  it("adding a photo leaves an adopted reference exactly where it is", async () => {
    // This used to retire the reference, because the adopted one *was* the
    // photo being replaced. With every version retained that reasoning is
    // gone: the artwork is still in the strip and still what the books draw,
    // so adding a picture may not take a character's look away in silence.
    expectingUpload(
      characterRecord({
        photoPath: "char-1-photo.jpg",
        photoKind: "ILLUSTRATION",
        portraitStatus: "READY",
        portraitPath: "char-1-portrait.jpg",
        portraitSource: "ADOPTED_UPLOAD"
      })
    );
    const app = await buildMobileApp({
      characterPhotoVision: vi.fn().mockResolvedValue(visionReading({ imageKind: "photograph" }))
    });

    const uploaded = await uploadPhoto(app);

    expect(uploaded.statusCode).toBe(200);
    expect(referenceClaim()).toBeNull();
    expect(uploaded.json().character).toMatchObject({
      usedInBooks: true,
      portraitSource: "adopted_upload",
      photoKind: "photograph"
    });
    await app.close();
  });

  it("stores the photo anyway when the reading fails or never answers", async () => {
    for (const vision of [
      vi.fn().mockRejectedValue(new Error("provider down")),
      vi.fn().mockImplementation(() => new Promise(() => {}))
    ]) {
      vi.mocked(mockPrisma.libraryCharacter.update).mockClear();
      vi.mocked(mockPrisma.libraryCharacter.updateMany).mockClear();
      expectingUpload();
      const app = await buildMobileApp({ characterPhotoVision: vision, characterPhotoVisionBudgetMs: 20 });
      const uploaded = await uploadPhoto(app);
      expect(uploaded.statusCode).toBe(200);
      expect(uploadWrite().photoPath).toMatch(/^char-1-photo-/);
      expect(uploadWrite()).toMatchObject({ photoKind: null, suggestedDescription: null });
      await app.close();
    }
  });

  it("404s an upload whose character went away before the version row landed", async () => {
    // The reader uploads a photo and then deletes the character on their other
    // device while the vision call is still running. The insert is the first
    // write, so the foreign key refuses it before anything reaches disk — and
    // that used to leave the route rethrowing a `P2003` into a 500 it declares
    // no status for.
    expectingUpload();
    mockPrisma.libraryCharacterImage.create.mockRejectedValue(deletedDuringUpload("version row"));
    const app = await buildMobileApp({ characterPhotoVision: vi.fn().mockResolvedValue(visionReading()) });

    const uploaded = await uploadPhoto(app);

    expect(uploaded.statusCode).toBe(404);
    expect(uploaded.json().error).toEqual({
      code: "CHARACTER_NOT_FOUND",
      message: "That character is not in your library."
    });
    // Nothing to point at and nothing to unlink: the settlement returns before
    // the pointer write rather than describing a row that is gone.
    expect(mockPrisma.libraryCharacter.update).not.toHaveBeenCalled();
    expect(storedFiles()).toEqual([]);
    await app.close();
  });

  it("404s an upload whose character went away before the pointer write, and takes the bytes with it", async () => {
    // The expensive half of the same race: the version row and its file are
    // written, the delete commits, and the pointer write finds no row. The row
    // cascaded away with the character and `DELETE /characters/:id` collected
    // its file list before this version existed — so what is left is bytes no
    // route, no prune and no sweep can reach again.
    expectingUpload();
    let filesAtPointerWrite: string[] = [];
    mockPrisma.libraryCharacter.update.mockImplementation(async () => {
      filesAtPointerWrite = storedFiles();
      throw deletedDuringUpload("pointer write");
    });
    const app = await buildMobileApp({ characterPhotoVision: vi.fn().mockResolvedValue(visionReading()) });

    const uploaded = await uploadPhoto(app);

    expect(uploaded.statusCode).toBe(404);
    expect(uploaded.json().error.code).toBe("CHARACTER_NOT_FOUND");
    // Written first, and gone once the write that would have named them lost.
    expect(filesAtPointerWrite).toHaveLength(1);
    expect(storedFiles()).toEqual([]);
    await app.close();
  });

  it("keeps a picture the reader can still reach when the pointer write fails for any other reason", async () => {
    // The other side of that unlink, and the reason the settlement reads the
    // error instead of re-reading the row: after a failure that is nobody's
    // race the version row is still there naming the file, so the picture is in
    // the strip and one tap from being deleted. Cleaning up here would turn the
    // recoverable half of the rule — a row with no file — into the permanent one.
    expectingUpload();
    mockPrisma.libraryCharacter.update.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const app = await buildMobileApp();

    const uploaded = await uploadPhoto(app);

    expect(uploaded.statusCode).toBe(500);
    expect(storedFiles()).toHaveLength(1);
    await app.close();
  });

  it("takes the stored bytes with it when the character goes after both writes land", async () => {
    // Nothing raised — both writes met the row — so the delete is visible only
    // to the read that answers. The 404 was already right; the file it left
    // behind was not.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValueOnce(characterRecord()).mockResolvedValue(null);
    mockPrisma.libraryCharacter.update.mockResolvedValue(characterRecord());
    const app = await buildMobileApp();

    const uploaded = await uploadPhoto(app);

    expect(uploaded.statusCode).toBe(404);
    expect(uploaded.json().error.code).toBe("CHARACTER_NOT_FOUND");
    expect(mockPrisma.libraryCharacterImage.create).toHaveBeenCalled();
    expect(storedFiles()).toEqual([]);
    await app.close();
  });

  it("404s a photo removal whose character went away between the read and the write", async () => {
    // The same gesture against the legacy pointer clear. No vision call in
    // front of it, so the window is short rather than seconds long — and a 500
    // for a character the reader had just deleted is the wrong answer at any
    // width.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord({ photoPath: "char-1-photo-abc123.jpg" }));
    mockPrisma.libraryCharacter.update.mockRejectedValue(deletedDuringUpload("pointer write"));
    const app = await buildMobileApp();

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-1/photo",
      headers: bearer("token-a")
    });

    expect(removed.statusCode).toBe(404);
    expect(removed.json().error).toEqual({
      code: "CHARACTER_NOT_FOUND",
      message: "That character is not in your library."
    });
    await app.close();
  });

  it("removing the photo clears the pointer and keeps every retained picture", async () => {
    // This route used to unlink the file and drop an adopted reference with
    // it, on the grounds that the reader had swapped the picture out. With a
    // retained history that is no longer true of either: the picture stays in
    // the strip and the reference stays one promote away. The app calls the
    // per-image delete instead; this stays for clients already in the wild.
    const photoPath = "char-1-photo-abc123.jpg";
    const userDir = join(state.imageStorageDir!, "characters", "user-a");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, photoPath), ONE_PIXEL_PNG);
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({
        photoPath,
        photoKind: "ILLUSTRATION",
        portraitPath: photoPath,
        portraitSource: "ADOPTED_UPLOAD",
        portraitStatus: "READY"
      })
    );
    mockPrisma.libraryCharacter.update.mockResolvedValue(characterRecord());
    const app = await buildMobileApp();
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-1/photo",
      headers: bearer("token-a")
    });
    expect(removed.statusCode).toBe(200);
    const written = mockPrisma.libraryCharacter.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(written).toMatchObject({ photoPath: null, photoKind: null, suggestedDescription: null });
    expect(written).not.toHaveProperty("portraitPath");
    // And nothing left the disk — an adopted reference shares this very file.
    expect(readFileSync(join(userDir, photoPath)).length).toBeGreaterThan(0);
    await app.close();
  });

  it("retires the suggestion when it is accepted, rewritten, or turned down", async () => {
    for (const payload of [{ description: "My own words" }, { dismissSuggestion: true }]) {
      vi.mocked(mockPrisma.libraryCharacter.update).mockClear();
      mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
        characterRecord({ suggestedDescription: "A round-faced girl in a yellow raincoat." })
      );
      mockPrisma.libraryCharacter.update.mockResolvedValue(characterRecord());
      const app = await buildMobileApp();
      const patched = await patchCharacter(app, "char-1", payload);
      expect(patched.statusCode).toBe(200);
      expect(mockPrisma.libraryCharacter.update.mock.calls[0]![0].data).toMatchObject({ suggestedDescription: null });
      await app.close();
    }
  });

  it("rejects a photo that is not an image format we accept", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/mobile/characters/char-1/photo?filename=notes.pdf&mimeType=application%2Fpdf",
      headers: { ...bearer("token-a"), "content-type": "application/octet-stream" },
      payload: Buffer.from("%PDF-1.4")
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("PHOTO_UNSUPPORTED");
    await app.close();
  });
});

/**
 * The one traversal all three constraint predicates read, and the three answers
 * built on top of it.
 *
 * `namesOrphanedCharacterImage` above is the photo lane's rung; `namesMentionCheckConstraint`
 * and `namesMentionCharacterForeignKey` are the record lane's. All three used to
 * spell out the same walk over `code`, `meta` and `meta.driverAdapterError.cause`
 * before applying their own regex, so the one fact that actually moves between
 * adapter versions — where a SQLSTATE and a constraint name are put — was written
 * down three times across two files. It is `constraintErrorText` now, and it is
 * pinned here rather than in `characterWriteConflicts.test.ts` because this is the
 * suite on the far side of the seam: a traversal that stopped covering the photo
 * lane is a 500 for a character the reader deleted on their other device, and
 * nothing in the record lane's suite would notice.
 */
describe("the constraint traversal the character write lanes share", () => {
  const predicates = [
    namesMentionCheckConstraint,
    namesMentionCharacterForeignKey,
    namesOrphanedCharacterImage
  ];

  /**
   * One violation in each place Prisma 7.8 and `@prisma/adapter-pg` between them
   * can report it.
   *
   * The second is the shape that pins the traversal: the message says nothing
   * about the constraint and the whole answer is under
   * `meta.driverAdapterError.cause`, so a predicate reading `message` alone —
   * which is what the CHECK rung did before this was extracted — answers false
   * for a violation it owns. `prismaCode` is passed only where Prisma models the
   * violation at all, which it does for a foreign key and never for a CHECK.
   */
  const reportedEveryWay = (sqlstate: string, constraint: string, table: string, prismaCode?: string): unknown[] => [
    ...(prismaCode === undefined
      ? []
      : [
          new MockPrismaKnownRequestError(`Foreign key constraint violated on the constraint: \`${constraint}\``, {
            code: prismaCode,
            meta: {
              modelName: table,
              driverAdapterError: { cause: { originalCode: sqlstate, constraint: { index: constraint } } }
            }
          })
        ]),
    Object.assign(new Error("Error occurred during query execution"), {
      meta: { driverAdapterError: { cause: { originalCode: sqlstate, constraint: { index: constraint } } } }
    }),
    Object.assign(new Error("An operation failed"), { meta: { code: sqlstate, constraint, modelName: table } }),
    new Error(`raw query failed. code: "${sqlstate}". constraint: "${constraint}"`)
  ];

  it("answers for its own constraint in every shape, and never for one of the others", () => {
    const lanes = [
      reportedEveryWay("23514", "LibraryMention_target_arc", "LibraryMention"),
      reportedEveryWay("23503", "LibraryMention_targetCharacterId_fkey", "LibraryMention", "P2003"),
      reportedEveryWay("23503", "LibraryCharacterImage_characterId_fkey", "LibraryCharacterImage", "P2003")
    ];
    lanes.forEach((shapes, owner) => {
      for (const failure of shapes) {
        // Three rungs answering three different statuses — 400, 404 from the
        // record lane, 404 from the photo lane — so a shape two of them claim is
        // worse than one none of them do.
        expect(predicates.map((names) => names(failure))).toEqual([owner === 0, owner === 1, owner === 2]);
      }
    });
  });

  it("leaves a constraint none of them own to the 500 it has always been", () => {
    // `LibraryCharacter_userId_fkey` is the account cascading out from under a
    // write: a `23503` like the two above, naming neither table, and "a mentioned
    // character is no longer in your library" is a sentence about somebody else's
    // row. A non-object error has nothing to walk at all, and reads as the empty
    // string rather than as a missing traversal.
    const strangers = [
      ...reportedEveryWay("23503", "LibraryCharacter_userId_fkey", "LibraryCharacter", "P2003"),
      new Error("connection terminated unexpectedly"),
      undefined,
      "boom"
    ];
    for (const failure of strangers) {
      expect(predicates.map((names) => names(failure))).toEqual([false, false, false]);
    }
    expect([constraintErrorText(undefined), constraintErrorText("boom")]).toEqual(["", ""]);
  });

  it("keeps the one answer that is a code and not a traversal, off the traversal's own ladder", () => {
    // The pointer write finding no row is `P2025` and nothing else — no
    // constraint, no SQLSTATE — so it is asked of the error directly, by a
    // predicate of its own rather than as a fourth rung on the shared walk.
    // `namesDeletedCharacter` is the pointer writes' alone: they name exactly
    // one `LibraryCharacter` by id, which is what gives "the record required
    // was not found" a single referent. The insert does not — it writes a
    // `LibraryCharacterImage` — so the rung on this ladder answers false for a
    // code that says nothing about the character it would have 404'd for.
    const notFound = new MockPrismaKnownRequestError(
      "An operation failed because it depends on one or more records that were required but not found.",
      { code: "P2025", meta: { modelName: "LibraryCharacter", cause: "Record to update not found." } }
    );
    expect(predicates.map((names) => names(notFound))).toEqual([false, false, false]);
    expect(namesDeletedCharacter(notFound)).toBe(true);
    expect(constraintErrorText(notFound)).not.toMatch(/\b23503\b|_fkey/);
  });

  it("keeps the two photo-lane predicates on their own statements", () => {
    // The split itself. A `P2025` raised inside `recordCharacterImage` is that
    // statement's missing record and not the character's absence, and reading
    // it as the latter answered `PUT /:id/photo` 404 for a character that is
    // there — after the version row and its bytes had landed. Nothing raises
    // it from that call today; nothing enforced it either, which is what the
    // two predicates now do.
    const orphaned = new MockPrismaKnownRequestError(
      "Foreign key constraint violated on the constraint: `LibraryCharacterImage_characterId_fkey`",
      {
        code: "P2003",
        meta: {
          modelName: "LibraryCharacterImage",
          driverAdapterError: {
            cause: { originalCode: "23503", constraint: { index: "LibraryCharacterImage_characterId_fkey" } }
          }
        }
      }
    );
    const notFound = new MockPrismaKnownRequestError("Record to update not found.", { code: "P2025" });
    expect([namesOrphanedCharacterImage(orphaned), namesDeletedCharacter(orphaned)]).toEqual([true, false]);
    expect([namesOrphanedCharacterImage(notFound), namesDeletedCharacter(notFound)]).toEqual([false, true]);
    // And neither answers for anything else, because the caller unlinks the
    // bytes it just wrote on a `true`.
    for (const stranger of [new Error("connection terminated unexpectedly"), undefined, "boom"]) {
      expect([namesOrphanedCharacterImage(stranger), namesDeletedCharacter(stranger)]).toEqual([false, false]);
    }
  });
});
