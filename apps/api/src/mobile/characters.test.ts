import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { reserveCredits } from "@book-maker/db/billing";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

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
    ...overrides
  };
}

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

describe("mobile character library routes", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
  });
  afterEach(teardownMobileHarness);

  it("lists the user's characters with the current portrait price", async () => {
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      characterRecord(),
      characterRecord({ id: "char-2", name: "Bram", portraitStatus: "READY", portraitPath: "char-2-portrait.webp" })
    ]);
    const app = await buildMobileApp();
    const response = await app.inject({ method: "GET", url: "/api/mobile/characters", headers: bearer("token-a") });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.portraitCredits).toBe(45);
    expect(body.characters).toHaveLength(2);
    expect(body.characters[0]).toMatchObject({
      id: "char-1",
      name: "Luna",
      portraitStatus: "none",
      portraitUrl: null,
      hasPhoto: false
    });
    expect(body.characters[1]).toMatchObject({
      portraitStatus: "ready",
      portraitUrl: "/api/mobile/characters/char-2/portrait"
    });
    await app.close();
  });

  it("creates a character and rejects a duplicate name with 409", async () => {
    mockPrisma.libraryCharacter.count.mockResolvedValue(0);
    mockPrisma.libraryCharacter.create.mockResolvedValue(characterRecord());
    const app = await buildMobileApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/mobile/characters",
      headers: bearer("token-a"),
      payload: {
        name: "Luna",
        description: "A brave night-flying rabbit.",
        appearance: "Grey rabbit with one folded ear and a red scarf.",
        fields: [{ key: "Age", value: "9" }]
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().character.name).toBe("Luna");
    expect(mockPrisma.libraryCharacter.create.mock.calls[0]![0].data).toMatchObject({
      appearance: "Grey rabbit with one folded ear and a red scarf."
    });

    const { MockPrismaKnownRequestError } = await import("./testing/mobileApiMocks.js");
    mockPrisma.libraryCharacter.create.mockRejectedValue(
      new MockPrismaKnownRequestError("duplicate", { code: "P2002" })
    );
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/mobile/characters",
      headers: bearer("token-a"),
      payload: { name: "Luna" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("CHARACTER_NAME_TAKEN");
    await app.close();
  });

  it("refuses creation past the library cap", async () => {
    mockPrisma.libraryCharacter.count.mockResolvedValue(100);
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/characters",
      headers: bearer("token-a"),
      payload: { name: "One Too Many" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CHARACTER_LIMIT_REACHED");
    expect(mockPrisma.libraryCharacter.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("blocks deleting a character while its portrait job is genuinely running", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ portraitStatus: "GENERATING", portraitJobId: "job-portrait" })
    );
    mockPrisma.libraryCharacter.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.generationJob.findUnique.mockResolvedValue({ status: "ACTIVE" });
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a")
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PORTRAIT_IN_PROGRESS");
    await app.close();
  });

  it("lets delete reclaim a character whose portrait claim outlived its job", async () => {
    // A worker killed hard never runs its failure path: the row says
    // GENERATING but the backing job is terminal. Delete is the escape hatch.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ portraitStatus: "GENERATING", portraitJobId: "job-portrait" })
    );
    mockPrisma.libraryCharacter.deleteMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    mockPrisma.generationJob.findUnique.mockResolvedValue({ status: "FAILED" });
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/mobile/characters/char-1",
      headers: bearer("token-a")
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().deleted).toBe(true);
    await app.close();
  });

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
      const patched = await app.inject({
        method: "PATCH",
        url: "/api/mobile/characters/char-1",
        headers: bearer("token-a"),
        payload
      });
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
      const patched = await app.inject({
        method: "PATCH",
        url: "/api/mobile/characters/char-1",
        headers: bearer("token-a"),
        payload
      });
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

  it("charges and queues a portrait, stamping the ledger entry on the job payload", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.libraryCharacter.update.mockResolvedValue(characterRecord({ portraitStatus: "QUEUED" }));
    vi.mocked(enqueueGenerationJob).mockResolvedValue({ id: "job-portrait" } as never);
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-a"),
      payload: { requestId: "portrait-request-1" }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().creditsCharged).toBe(45);
    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "CHARACTER_PORTRAIT_GENERATION", amountCredits: 45 })
    );
    expect(enqueueGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        type: "GENERATE_CHARACTER_PORTRAIT",
        dispatch: false,
        payload: expect.objectContaining({
          libraryCharacterId: "char-1",
          userId: "user-a",
          billingLedgerEntryId: expect.any(String)
        })
      })
    );
    expect(dispatchGenerationJob).toHaveBeenCalledWith("job-portrait");
    await app.close();
  });

  it("replays the same portrait requestId instead of charging twice", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.libraryCharacter.update.mockResolvedValue(characterRecord({ portraitStatus: "QUEUED" }));
    vi.mocked(enqueueGenerationJob).mockResolvedValue({ id: "job-portrait" } as never);
    const app = await buildMobileApp();
    const send = () =>
      app.inject({
        method: "POST",
        url: "/api/mobile/characters/char-1/portrait",
        headers: bearer("token-a"),
        payload: { requestId: "portrait-request-2" }
      });
    expect((await send()).statusCode).toBe(202);
    expect((await send()).statusCode).toBe(202);
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("answers 409 while a portrait is already in flight", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord({ portraitStatus: "QUEUED" }));
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-a"),
      payload: {}
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PORTRAIT_IN_PROGRESS");
    await app.close();
  });

  it("never serves another user's character files", async () => {
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
    mockPrisma.libraryCharacter.findFirst.mockImplementation(async ({ where }: { where: { userId: string } }) =>
      where.userId === "user-a" ? characterRecord({ portraitPath: "char-1-portrait.webp" }) : null
    );
    const dir = join(state.imageStorageDir!, "characters", "user-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "char-1-portrait.webp"), "fake-webp");
    const app = await buildMobileApp();
    const stranger = await app.inject({
      method: "GET",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-b")
    });
    expect(stranger.statusCode).toBe(404);
    const owner = await app.inject({
      method: "GET",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-a")
    });
    expect(owner.statusCode).toBe(200);
    await app.close();
  });
});
