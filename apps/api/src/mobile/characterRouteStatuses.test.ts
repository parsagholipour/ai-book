import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import Fastify from "fastify";
import { resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";

/**
 * What the character routes tell `/docs` they can answer with, against what
 * their handlers can actually reach.
 *
 * Its own suite because it is a different kind of statement from the ones in
 * `characters.test.ts` and `characterImages.test.ts`: it injects no request,
 * reads no fixture and asserts nothing about behaviour — it registers the whole
 * mobile surface on a bare Fastify instance and reads the response maps back off
 * it. It also spans both route files at once, which is the point: the record
 * routes and the picture routes share one rate-limit bucket, one owner-read 404
 * and one write-error ladder, so the sets differ by what each handler can throw
 * into that ladder and never by which rungs the ladder has. Auditing the two
 * files apart is how three of those routes came to be missing the 429 they all
 * share.
 */

/**
 * What every route in the app declares it can answer with, read off Fastify
 * rather than off the source.
 *
 * `onRoute` on the root instance fires for routes registered inside the plugin,
 * which is the only way to see a response map from outside — the app the suites
 * next door inject into never exposes one.
 */
async function declaredResponseStatuses(): Promise<Record<string, number[]>> {
  const app = Fastify();
  const declared: Record<string, number[]> = {};
  app.addHook("onRoute", (route) => {
    const response = (route.schema as { response?: Record<string, unknown> } | undefined)?.response;
    if (!response) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      declared[`${method} ${route.url}`] = Object.keys(response)
        .map(Number)
        .sort((left, right) => left - right);
    }
  });
  const { mobileProjectRoutes } = await import("../mobileProjects.js");
  await app.register(mobileProjectRoutes, {});
  await app.close();
  return declared;
}

describe("the statuses the character routes declare", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  /**
   * The statuses `/docs` promises, against the ones the handlers can reach.
   *
   * fast-json-stringify serializes through the schema a status names, so an
   * undeclared one is served by the default serializer and *reads* fine — which
   * is why this drifted unnoticed. The lie is in the documentation the app is
   * written against, and the only thing that can catch it is the map itself.
   * All three writes share one catch, so the sets differ by what each handler
   * can throw into it, never by which rungs the ladder has.
   */
  it("declares exactly the statuses each character write can answer with", async () => {
    const declared = await declaredResponseStatuses();

    // 403 is the library cap, which only a create can hit; 404 covers both a
    // mentioned character that is gone and one deleted under this insert.
    expect(declared["POST /api/mobile/characters"]).toEqual([201, 400, 401, 403, 404, 409, 422, 429, 503]);
    expect(declared["PATCH /api/mobile/characters/:id"]).toEqual([400, 401, 404, 409, 422, 429, 503]);
    // Narrower on purpose: delete screens no content and writes no
    // `LibraryMention` row, so neither the 422 rung nor either 400 rung has a
    // statement in this lane to come out of.
    expect(declared["DELETE /api/mobile/characters/:id"]).toEqual([401, 404, 409, 429, 503]);
    // 429 is the one all three were missing, and all three share the bucket.
    for (const route of [
      "POST /api/mobile/characters",
      "PATCH /api/mobile/characters/:id",
      "DELETE /api/mobile/characters/:id"
    ]) {
      expect(declared[route]).toContain(429);
    }
  });

  /**
   * The same audit over the picture routes, which live in
   * `routes/characterImages.ts` and are exercised in `characterImages.test.ts`.
   *
   * It is asserted here because it is the same statement, off the same helper:
   * those routes share this group's `character-write` bucket and its owner-read
   * 404, and the file was never covered when the writes above were audited.
   * Every rationed one was missing the 429, and the two that validate an input
   * of their own were missing the 400 as well.
   */
  it("declares exactly the statuses each character picture route can answer with", async () => {
    const declared = await declaredResponseStatuses();

    // The reads: the guard's 401 and the owner read's 404, and nothing else.
    // None of them rations, and none of them writes a pointer to lose a race on.
    for (const route of [
      "GET /api/mobile/characters/:id/images",
      "GET /api/mobile/characters/:id/images/:imageId",
      "GET /api/mobile/characters/:id/photo",
      "GET /api/mobile/characters/:id/portrait",
      "DELETE /api/mobile/characters/:id/photo"
    ]) {
      expect(declared[route]).toEqual([401, 404]);
    }
    // Both pointer writes: 409 for a row that moved under the decision, plus
    // the bucket. Promote adds the 422 a photograph is refused with; the delete
    // screens nothing and refuses nothing, so it has no 422 to declare.
    expect(declared["POST /api/mobile/characters/:id/images/:imageId/promote"]).toEqual([401, 404, 409, 422, 429]);
    expect(declared["DELETE /api/mobile/characters/:id/images/:imageId"]).toEqual([401, 404, 409, 429]);
    // The upload parses a query string and a raw body itself, so its two
    // `VALIDATION_ERROR` replies are a 400 rung the others do not have.
    expect(declared["PUT /api/mobile/characters/:id/photo"]).toEqual([400, 401, 404, 422, 429]);
    // The one priced route in the group: 402 for the shortfall and 422 for a
    // refused content screen, on top of everything a picture write can answer.
    expect(declared["POST /api/mobile/characters/:id/portrait"]).toEqual([202, 400, 401, 402, 404, 409, 422, 429]);
  });
});
