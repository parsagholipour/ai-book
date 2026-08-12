import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reserveCredits } from "@book-maker/db/billing";
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
});
