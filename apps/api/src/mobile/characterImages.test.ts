import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InsufficientCreditsError, reserveCredits } from "@book-maker/db/billing";
import { enqueueGenerationJob } from "../queue.js";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

const PHOTO_FILE = "char-1-photo-aaaaaaaaaaaa.jpg";
const PORTRAIT_FILE = "char-1-portrait-bbbbbbbbbbbb.jpg";
const OLDER_PORTRAIT_FILE = "char-1-portrait-cccccccccccc.jpg";

/** A real 1x1 PNG, so a byte read has something to return. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function characterRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "char-1",
    userId: "user-a",
    name: "Luna",
    description: "A brave night-flying rabbit.",
    fields: [],
    // This file's serializing read is `ownedCharacterWithMentions`, so a real
    // row always carries this. A fixture without it models a read that does not
    // happen, and `libraryMentionRefs` no longer covers for one.
    outgoingMentions: [],
    photoPath: PHOTO_FILE,
    photoKind: "PHOTOGRAPH",
    suggestedDescription: null,
    portraitPath: PORTRAIT_FILE,
    portraitSource: "GENERATED",
    portraitStatus: "READY",
    portraitError: null,
    portraitJobId: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    ...overrides
  };
}

function imageRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "img-portrait",
    characterId: "char-1",
    userId: "user-a",
    source: "GENERATED",
    fileName: PORTRAIT_FILE,
    byteSize: 1024,
    width: 512,
    height: 512,
    photoKind: null,
    referenceEligible: true,
    createdAt: new Date("2026-08-02T10:00:00.000Z"),
    ...overrides
  };
}

const uploadImage = imageRecord({
  id: "img-photo",
  source: "UPLOAD",
  fileName: PHOTO_FILE,
  photoKind: "PHOTOGRAPH",
  referenceEligible: false,
  createdAt: new Date("2026-08-01T10:00:00.000Z")
});

/** Puts the bytes where `characterImageExists` and the byte route will find them. */
function writeCharacterFile(fileName: string): void {
  const userDir = join(state.imageStorageDir!, "characters", "user-a");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, fileName), ONE_PIXEL_PNG);
}

/**
 * The route reads the image by id and, on a delete that clears the reference,
 * looks for a successor. Both go through `findFirst`, so the fake answers by
 * shape rather than by call order.
 */
function withImages(images: Array<Record<string, unknown>>) {
  mockPrisma.libraryCharacterImage.findFirst.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) =>
      images.find((image) => image.id === where.id) ?? null
  );
  // The successor hunt filters on `referenceEligible` and excludes the row
  // being deleted, then stats each candidate — so the fake has to honour the
  // where-clause rather than answering with everything.
  mockPrisma.libraryCharacterImage.findMany.mockImplementation(
    async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const excluded = (where?.id as { not?: string } | undefined)?.not;
      return images.filter(
        (image) =>
          (where?.referenceEligible !== true || image.referenceEligible === true) &&
          (excluded === undefined || image.id !== excluded)
      );
    }
  );
}

const promote = (app: Awaited<ReturnType<typeof buildMobileApp>>, imageId: string) =>
  app.inject({
    method: "POST",
    url: `/api/mobile/characters/char-1/images/${imageId}/promote`,
    headers: bearer("token-a")
  });

const removeImage = (app: Awaited<ReturnType<typeof buildMobileApp>>, imageId: string) =>
  app.inject({
    method: "DELETE",
    url: `/api/mobile/characters/char-1/images/${imageId}`,
    headers: bearer("token-a")
  });

/** The compare-and-set a promote or a pointer-holding delete makes. */
const pointerWrite = () => {
  const call = mockPrisma.libraryCharacter.updateMany.mock.calls[0];
  return call ? (call[0].data as Record<string, unknown>) : null;
};

describe("mobile character image history routes", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(characterRecord());
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
  });
  afterEach(teardownMobileHarness);

  it("lists every retained picture and says which one the books draw from", async () => {
    withImages([imageRecord(), uploadImage]);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/characters/char-1/images",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    const images = response.json().images as Array<Record<string, unknown>>;
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({
      id: "img-portrait",
      source: "generated",
      isMain: true,
      isCurrentReference: true,
      canBeMain: false,
      url: "/api/mobile/characters/char-1/images/img-portrait"
    });
    // The stored photo is not main — a reference outranks it everywhere — and
    // it is not promotable either, because a book cannot draw from a photograph.
    expect(images[1]).toMatchObject({
      id: "img-photo",
      source: "upload",
      isMain: false,
      isCurrentPhoto: true,
      canBeMain: false,
      canBeShownAsPhoto: false
    });
    // The raw ingest verdict never reaches the wire.
    expect(images[0]).not.toHaveProperty("referenceEligible");
    await app.close();
  });

  it("serves one version's bytes as immutable and private", async () => {
    writeCharacterFile(PORTRAIT_FILE);
    withImages([imageRecord()]);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/characters/char-1/images/img-portrait",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    // One id is one set of bytes for good — but `private` is what keeps a
    // shared proxy from caching one reader's child's face.
    expect(response.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.rawPayload.length).toBe(ONE_PIXEL_PNG.length);
    await app.close();
  });

  it("never serves or moves another user's picture", async () => {
    // The lookup carries owner, character and image; a row belonging to
    // someone else simply does not come back.
    mockPrisma.libraryCharacterImage.findFirst.mockResolvedValue(null);
    mockPrisma.libraryCharacterImage.findMany.mockResolvedValue([]);
    const app = await buildMobileApp();

    for (const response of [
      await app.inject({
        method: "GET",
        url: "/api/mobile/characters/char-1/images/img-someone-else",
        headers: bearer("token-a")
      }),
      await promote(app, "img-someone-else"),
      await removeImage(app, "img-someone-else")
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("CHARACTER_IMAGE_NOT_FOUND");
    }
    expect(mockPrisma.libraryCharacter.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("promotes a drawing to the reference without touching the photo, and charges nothing", async () => {
    writeCharacterFile(OLDER_PORTRAIT_FILE);
    const older = imageRecord({ id: "img-older", fileName: OLDER_PORTRAIT_FILE });
    withImages([imageRecord(), older, uploadImage]);
    const app = await buildMobileApp();

    const response = await promote(app, "img-older");

    expect(response.statusCode).toBe(200);
    // All four reference columns move together: `portraitPath` alone would
    // leave `usedInBooks` false while every surface drew the new face.
    expect(pointerWrite()).toEqual({
      portraitPath: OLDER_PORTRAIT_FILE,
      portraitSource: "GENERATED",
      portraitStatus: "READY",
      portraitError: null
    });
    // A generated drawing never becomes the photo: that would make `hasPhoto`
    // true and feed a drawing into the next redraw's "stylize the attached
    // photo" prompt.
    expect(pointerWrite()).not.toHaveProperty("photoPath");
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("promotes the reader's own artwork to both the photo and the reference", async () => {
    writeCharacterFile("char-1-photo-dddddddddddd.png");
    const artwork = imageRecord({
      id: "img-art",
      source: "UPLOAD",
      fileName: "char-1-photo-dddddddddddd.png",
      photoKind: "ILLUSTRATION",
      referenceEligible: true
    });
    withImages([artwork, imageRecord(), uploadImage]);
    const app = await buildMobileApp();

    expect((await promote(app, "img-art")).statusCode).toBe(200);

    expect(pointerWrite()).toMatchObject({
      photoPath: "char-1-photo-dddddddddddd.png",
      photoKind: "ILLUSTRATION",
      portraitPath: "char-1-photo-dddddddddddd.png",
      portraitSource: "ADOPTED_UPLOAD",
      portraitStatus: "READY"
    });
    await app.close();
  });

  it("lets an older photograph become the photo only while nothing is drawn yet", async () => {
    writeCharacterFile("char-1-photo-eeeeeeeeeeee.jpg");
    const olderPhoto = imageRecord({
      id: "img-old-photo",
      source: "UPLOAD",
      fileName: "char-1-photo-eeeeeeeeeeee.jpg",
      photoKind: "PHOTOGRAPH",
      referenceEligible: false
    });
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ portraitPath: null, portraitSource: null, portraitStatus: "NONE" })
    );
    withImages([uploadImage, olderPhoto]);
    const app = await buildMobileApp();

    expect((await promote(app, "img-old-photo")).statusCode).toBe(200);

    expect(pointerWrite()).toEqual({
      photoPath: "char-1-photo-eeeeeeeeeeee.jpg",
      photoKind: "PHOTOGRAPH",
      suggestedDescription: null
    });
    // Nothing about what a book draws moved, because a book cannot draw from
    // a photograph.
    expect(pointerWrite()).not.toHaveProperty("portraitPath");
    await app.close();
  });

  it("refuses to promote a photograph over an existing reference", async () => {
    // The action would change nothing the reader can see — the reference
    // outranks the photo on every surface — and offering it would promise a
    // book behaviour the pipeline will not deliver.
    withImages([imageRecord(), uploadImage]);
    const app = await buildMobileApp();

    const response = await promote(app, "img-photo");

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("CHARACTER_IMAGE_NOT_PROMOTABLE");
    expect(mockPrisma.libraryCharacter.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses to promote a picture whose file is gone", async () => {
    // A READY row naming nothing would tell every surface, and every book
    // build, that this character reaches a book.
    withImages([imageRecord({ id: "img-missing", fileName: "char-1-portrait-ffffffffffff.jpg" })]);
    const app = await buildMobileApp();

    const response = await promote(app, "img-missing");

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("CHARACTER_IMAGE_NOT_FOUND");
    expect(mockPrisma.libraryCharacter.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("stands down while a portrait job genuinely owns the row", async () => {
    writeCharacterFile(OLDER_PORTRAIT_FILE);
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ portraitStatus: "GENERATING", portraitJobId: "job-portrait" })
    );
    mockPrisma.libraryCharacter.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.generationJob.findUnique.mockResolvedValue({ status: "ACTIVE" });
    withImages([imageRecord({ id: "img-older", fileName: OLDER_PORTRAIT_FILE })]);
    const app = await buildMobileApp();

    const response = await promote(app, "img-older");

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PORTRAIT_IN_PROGRESS");
    expect(mockPrisma.libraryCharacter.updateMany.mock.calls[0]![0].where).toMatchObject({
      portraitStatus: { notIn: ["QUEUED", "GENERATING"] }
    });
    await app.close();
  });

  it("does not wedge on a claim that outlived its job", async () => {
    // A worker killed hard never runs its failure path, and nothing else
    // resets an account-level row. Without this escape hatch every promote and
    // every pointer-holding delete would 409 forever, leaving "delete the whole
    // character" — and its whole history — as the only way out.
    writeCharacterFile(OLDER_PORTRAIT_FILE);
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ portraitStatus: "GENERATING", portraitJobId: "job-dead" })
    );
    mockPrisma.generationJob.findUnique.mockResolvedValue({ status: "FAILED" });
    // The guarded write finds nothing to move; the forced one behind it does.
    mockPrisma.libraryCharacter.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 1 });
    withImages([imageRecord({ id: "img-older", fileName: OLDER_PORTRAIT_FILE })]);
    const app = await buildMobileApp();

    const response = await promote(app, "img-older");

    expect(response.statusCode).toBe(200);
    // The retry drops the status guard rather than answering an error the
    // reader can do nothing about.
    const forced = mockPrisma.libraryCharacter.updateMany.mock.calls[1]![0].where as Record<string, unknown>;
    expect(forced).not.toHaveProperty("portraitStatus");
    expect(forced).toMatchObject({ id: "char-1", userId: "user-a" });
    await app.close();
  });

  it("deleting the main picture puts the previous illustration back", async () => {
    // The successor's bytes have to be there: the route stats each candidate,
    // because a READY row naming a missing file rides into every future book.
    writeCharacterFile(OLDER_PORTRAIT_FILE);
    const older = imageRecord({ id: "img-older", fileName: OLDER_PORTRAIT_FILE });
    withImages([imageRecord(), older, uploadImage]);
    const app = await buildMobileApp();

    const response = await removeImage(app, "img-portrait");

    expect(response.statusCode).toBe(200);
    // The whole point of a retained history: a redraw the reader dislikes is
    // one delete away from the drawing they had before.
    expect(pointerWrite()).toEqual({
      portraitPath: OLDER_PORTRAIT_FILE,
      portraitSource: "GENERATED",
      portraitStatus: "READY",
      portraitError: null
    });
    expect(mockPrisma.libraryCharacterImage.deleteMany).toHaveBeenCalledWith({
      where: { id: "img-portrait", userId: "user-a" }
    });
    await app.close();
  });

  it("clears the reference when the deleted picture was the only one a book could use", async () => {
    withImages([imageRecord(), uploadImage]);
    const app = await buildMobileApp();

    expect((await removeImage(app, "img-portrait")).statusCode).toBe(200);

    expect(pointerWrite()).toEqual({
      portraitPath: null,
      portraitSource: null,
      portraitStatus: "NONE",
      portraitError: null
    });
    await app.close();
  });

  it("skips a successor whose file is gone rather than promising a book it", async () => {
    // A row with no bytes is an accepted half-state on the ingest path, so the
    // successor hunt has to stat: installing it READY would tell every surface
    // — and every future book, via the plan snapshot — that this character has
    // a look, permanently and silently.
    const orphan = imageRecord({ id: "img-orphan", fileName: "char-1-portrait-gonegonegone.jpg" });
    withImages([imageRecord(), orphan, uploadImage]);
    const app = await buildMobileApp();

    expect((await removeImage(app, "img-portrait")).statusCode).toBe(200);

    expect(pointerWrite()).toEqual({
      portraitPath: null,
      portraitSource: null,
      portraitStatus: "NONE",
      portraitError: null
    });
    await app.close();
  });

  it("deletes an older picture that holds no pointer without touching the character", async () => {
    // Not guarded on the portrait status at all: a minute-long redraw must not
    // block housekeeping on a picture it has nothing to do with.
    const older = imageRecord({ id: "img-older", fileName: OLDER_PORTRAIT_FILE });
    withImages([imageRecord(), older, uploadImage]);
    const app = await buildMobileApp();

    expect((await removeImage(app, "img-older")).statusCode).toBe(200);

    expect(mockPrisma.libraryCharacter.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.libraryCharacterImage.deleteMany).toHaveBeenCalledWith({
      where: { id: "img-older", userId: "user-a" }
    });
    await app.close();
  });

  it("404s the whole group for a character that is not the caller's", async () => {
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(null);
    const app = await buildMobileApp();

    for (const response of [
      await app.inject({
        method: "GET",
        url: "/api/mobile/characters/char-9/images",
        headers: bearer("token-a")
      }),
      await promote(app, "img-portrait"),
      await removeImage(app, "img-portrait")
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("CHARACTER_NOT_FOUND");
    }
    await app.close();
  });

  it("rations both picture writes on the bucket the character writes share", async () => {
    // `character-write`, spent before either route reads a row. The 429 both
    // answer with is the rung neither map declared: it reached the reader
    // through the default serializer while `/docs` called it impossible.
    withImages([imageRecord(), uploadImage]);
    const app = await buildMobileApp({ draftRateLimit: { maxAttempts: 1, windowMs: 60_000 } });

    expect((await removeImage(app, "img-portrait")).statusCode).toBe(200);
    const limited = await promote(app, "img-portrait");

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: { code: "RATE_LIMITED", message: "Too many attempts. Try again soon." }
    });
    await app.close();
  });

  it("says how many credits a refused portrait needed", async () => {
    // The numbers are the reply: `sendInsufficientCredits` assembles five
    // fields, but fast-json-stringify removes whatever the route's 402 schema
    // does not name, and the app builds its shortfall card out of
    // `requiredCredits` (`PaywallCreditsNeeded.fromApiError`, reached from
    // `character_profile_screen.dart`). Documented with `mobileAuthError` this
    // arrived as a bare sentence. Asserted on the serialized body, because the
    // helper was always called correctly.
    vi.mocked(reserveCredits).mockRejectedValueOnce(
      new InsufficientCreditsError({ requiredCredits: 45, availableCredits: 12, reservedCredits: 3 })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-a"),
      payload: { requestId: "portrait-out-of-credits" }
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({
      error: {
        code: "INSUFFICIENT_CREDITS",
        message: "You need more credits for this action.",
        requiredCredits: 45,
        availableCredits: 12,
        reservedCredits: 3
      }
    });
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a portrait for a look the prompt would have rendered verbatim", async () => {
    // The rule the two character writes hold — the text a character write
    // screens is the text it stores — read from the paying end: the text this
    // route screens has to be the text it is about to have drawn.
    // `buildLibraryCharacterPortraitPrompt` prints `Appearance (match
    // exactly): …` straight into the image prompt, and `appearance` was the
    // one field missing from `characterContentText`'s input here, so the only
    // route in this group that reaches a provider on a charged job assessed
    // every part of its prompt except the sentence the provider is told to
    // follow exactly. Nothing upstream stands in for it: POST and PATCH
    // screened this string under whatever the operator flag said at the time,
    // and `fillAppearanceFromPhoto` writes a look off an uploaded photo onto a
    // character that has none.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ appearance: "Step-by-step instructions to build a bomb." })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-a"),
      payload: { requestId: "portrait-restricted-appearance" }
    });

    expect(response.statusCode).toBe(422);
    // `reason` reaches the reader because this route documents its 422 with
    // `contentRestrictedError` — the name and description in the fixture are
    // the same ones every other portrait test starts a job from, so the look
    // is the whole refusal.
    expect(response.json().error).toEqual({
      code: "CONTENT_RESTRICTED",
      message: "Tomeza cannot help create content that facilitates severe illegal harm.",
      reason: "critical_illegal_harm"
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    // Nor was the row claimed out of its settled portrait status.
    expect(mockPrisma.libraryCharacter.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  /** The Redraw tap the app makes, reusing one id the way the screen does. */
  const redrawWith = (app: Awaited<ReturnType<typeof buildMobileApp>>, requestId: string) =>
    app.inject({
      method: "POST",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-a"),
      payload: { requestId }
    });

  it("charges a reused id once for the same drawing and starts a new one for a different look", async () => {
    // The fingerprint is what a replayed `requestId` is asserted against, and
    // `appearance` — printed verbatim by `buildLibraryCharacterPortraitPrompt`
    // — is one of the inputs it has to name. What it must not do is *refuse*
    // on it: the app reuses its `requestId` until a start it saw succeed
    // (`character_profile_screen.dart` clears `_portraitRequestId` only in the
    // try), so a 409 for a moved input is a Redraw button that stays dead for
    // the life of the screen. The look is part of the command's identity
    // instead — same look replays, changed look is a new command.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ appearance: "Silver fur, one torn ear." })
    );
    const app = await buildMobileApp();

    expect((await redrawWith(app, "portrait-retry")).statusCode).toBe(202);
    // Same look, same id: still one drawing and one charge, which is what the
    // reused id is for.
    expect((await redrawWith(app, "portrait-retry")).statusCode).toBe(202);
    expect(enqueueGenerationJob).toHaveBeenCalledTimes(1);

    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ appearance: "Copper fur, both ears whole." })
    );
    const afterEdit = await redrawWith(app, "portrait-retry");

    // A different drawing under an id the app has no way to retire: answered
    // with the drawing, because replaying the old attempt promises the new look
    // is being rendered when nothing is, and refusing leaves the reader tapping
    // a button that can only 409.
    expect(afterEdit.statusCode).toBe(202);
    expect(enqueueGenerationJob).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("keeps Redraw alive after a photo writes the look the reader never touched", async () => {
    // The failure the fingerprint widening bought, end to end. Nothing here is
    // a reader edit: `fillAppearanceFromPhoto` writes an `appearance` off an
    // uploaded photo onto a character that had none, and moves `photoPath`
    // with it. So a tap whose 202 was lost, an upload, and a second tap is
    // three ordinary gestures that used to leave `POST /:id/portrait`
    // answering `GENERATION_COMMAND_CONFLICT` forever — for a request the
    // reader had no way to restate, since the retained id is only cleared by
    // the start it never saw succeed.
    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ appearance: null, photoPath: null, photoKind: null })
    );
    const app = await buildMobileApp();

    expect((await redrawWith(app, "portrait-timed-out")).statusCode).toBe(202);

    mockPrisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRecord({ appearance: "Auburn hair, round glasses.", photoKind: "PHOTOGRAPH" })
    );
    const afterUpload = await redrawWith(app, "portrait-timed-out");

    expect(afterUpload.statusCode).toBe(202);
    // And it is a real drawing of the photo, not a replay of the attempt that
    // was started before there was one.
    expect(enqueueGenerationJob).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("starts fresh for an id whose attempt predates the look joining the fingerprint", async () => {
    // The other half of the same wedge: a row stored by an earlier deploy
    // carries a fingerprint computed without `appearance`, so the first retry
    // of any of them recomputed a different one under the old key and 409ed a
    // reader who had changed nothing at all. The stored fingerprint is spelled
    // as a literal on purpose — what makes the row unreachable is the command
    // key, not whatever the old shape hashed to.
    state.generationAttempts.push({
      id: "attempt-legacy",
      userId: "user-a",
      commandKey: "mobile:character-portrait:char-1:portrait-legacy",
      requestFingerprint: "fingerprint-computed-before-appearance",
      status: "QUEUED",
      operation: "CHARACTER_PORTRAIT_GENERATION",
      quotedCredits: 40,
      projectId: null,
      editOperationId: null,
      ledgerEntryId: null,
      primaryJobId: "job-legacy",
      retryOfAttemptId: null,
      error: null,
      refundPending: false
    });
    const app = await buildMobileApp();

    const response = await redrawWith(app, "portrait-legacy");

    expect(response.statusCode).toBe(202);
    expect(enqueueGenerationJob).toHaveBeenCalledTimes(1);
    // The old row is left exactly as it was: it names a job of its own, and
    // this start neither replays it nor settles it.
    expect(state.generationAttempts[0]).toMatchObject({ id: "attempt-legacy", status: "QUEUED" });
    await app.close();
  });

  it("answers a malformed portrait request in the shape the app reads", async () => {
    // `attachValidation` is what makes the declared 400 the one this route
    // sends. Left to reject on its own, ajv answers Fastify's
    // `{ statusCode, error, message }` — no `error.code` for the app, and a
    // body fast-json-stringify cannot push through the 400 schema at all, so
    // declaring that status turned a malformed request into a 500.
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/characters/char-1/portrait",
      headers: bearer("token-a"),
      payload: { requestId: "short" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid portrait request." }
    });
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The half of that same 400 `attachValidation` cannot reach.
   *
   * `FST_ERR_CTP_INVALID_JSON` comes out of the content-type parser, so there is
   * no handler to attach a rejection to and no zod parse to answer — the reply
   * is Fastify's own, pushed through a `mobileAuthError` that has nowhere to put
   * `error: "Bad Request"`, and the reader got a 500 for a mis-encoded body. The
   * upload is here too because it declares no body at all and yet accepts
   * whatever content-type the client sends: `application/json` with garbage in
   * it reaches the JSON parser just the same. Both now carry the route
   * `errorHandler` the two character writes use.
   */
  it("refuses an unreadable body on both picture writes as a 400 the app can read", async () => {
    const app = await buildMobileApp();
    const malformed = (method: "POST" | "PUT", url: string) =>
      app.inject({
        method,
        url,
        headers: { ...bearer("token-a"), "content-type": "application/json" },
        payload: "{ requestId: unquoted"
      });

    for (const response of [
      await malformed("POST", "/api/mobile/characters/char-1/portrait"),
      await malformed("PUT", "/api/mobile/characters/char-1/photo?filename=luna.jpg")
    ]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: { code: "VALIDATION_ERROR", message: "That request could not be read." }
      });
    }
    // Neither one got as far as drawing anything or storing a file.
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
    await app.close();
  });
});
