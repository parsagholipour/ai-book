import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());

import {
  GenerationAttemptConflictError,
  GenerationAttemptJobClaimError,
  GenerationQuotaExceededError,
  InsufficientCreditsError
} from "@book-maker/db/billing";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { connect } from "node:net";
import { sendGenerationAttemptError, sendUnreadableBodyError } from "./httpErrors.js";
import { mobileAuthError } from "./schemas.js";

/**
 * What `sendUnreadableBodyError` claims, against what a route-level
 * `errorHandler` is actually handed.
 *
 * The four routes that install it are the two character writes and, in
 * `routes/characterImages.ts`, the portrait request and the photo upload; the
 * routes here are stand-ins shaped like them — a documented JSON body with
 * `attachValidation`, a raw `application/octet-stream` upload, a declared 400
 * carrying `mobileAuthError` — rather than the real ones, because what is being
 * pinned is the handler and not any handler's behaviour. It answers a body
 * Fastify could not read; Fastify hands it every error the route's hooks and
 * its own handler throw as well, and the two have to stay told apart.
 */

let app: FastifyInstance | null = null;

/**
 * The route shapes the four installers use, on one instance.
 *
 * `/write` is the documented-body write, `/upload` the raw one, and the two
 * `throws` routes are the half this suite exists for: a handler reaching the
 * same `errorHandler` with an error of its own.
 */
function buildApp(): FastifyInstance {
  const instance = Fastify();
  // The parser `mobileProjects.ts` registers for the uploads. It does not stop
  // a client from sending `application/json` instead, which is why the upload
  // route needs this handler at all.
  instance.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  instance.post(
    "/write",
    {
      attachValidation: true,
      errorHandler: sendUnreadableBodyError,
      schema: {
        body: { type: "object", properties: { name: { type: "string" } } },
        response: { 200: {}, 400: mobileAuthError, 401: mobileAuthError }
      }
    },
    async () => ({ ok: true })
  );

  instance.put(
    "/upload",
    {
      bodyLimit: 64,
      errorHandler: sendUnreadableBodyError,
      schema: { response: { 200: {}, 400: mobileAuthError } }
    },
    async () => ({ ok: true })
  );

  // A handler-thrown error on a route that declares no error status at all, so
  // nothing about serialization stands between the throw and the wire.
  instance.post(
    "/throws",
    { errorHandler: sendUnreadableBodyError, schema: { response: { 200: {} } } },
    async (request) => {
      throw taggedError(request.query as { status?: string; code?: string });
    }
  );

  // The same throw on a route shaped like the real four, whose 400 is declared
  // with `mobileAuthError`.
  instance.post(
    "/throws-declared",
    { errorHandler: sendUnreadableBodyError, schema: { response: { 200: {}, 400: mobileAuthError } } },
    async (request) => {
      throw taggedError(request.query as { status?: string; code?: string });
    }
  );

  return instance;
}

function taggedError(query: { status?: string; code?: string }): Error {
  const error = new Error("That character is not in your library.");
  Object.assign(error, {
    statusCode: Number(query.status ?? "400"),
    code: query.code ?? "CHARACTER_NOT_FOUND"
  });
  return error;
}

function currentApp(): FastifyInstance {
  app ??= buildApp();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

const UNREADABLE_BODY = { error: { code: "VALIDATION_ERROR", message: "That request could not be read." } };

describe("a body Fastify could not read", () => {
  /**
   * `FST_ERR_CTP_INVALID_JSON_BODY`, the refusal the whole helper was written
   * for: it comes out of the content-type parser, so `attachValidation` never
   * sees it and no handler is reached to answer it.
   */
  it("answers malformed JSON in the shape the app reads a code out of", async () => {
    const response = await currentApp().inject({
      method: "POST",
      url: "/write",
      headers: { "content-type": "application/json" },
      payload: "{oops"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(UNREADABLE_BODY);
  });

  /**
   * The parser's other 400 on these routes. Declared beside the first because
   * the fix tests a code *family* rather than either code by name — a narrower
   * predicate that named only the JSON one would leave this answering through a
   * declared `mobileAuthError` it cannot serialize.
   */
  it("answers an empty JSON body the same way", async () => {
    const response = await currentApp().inject({
      method: "POST",
      url: "/write",
      headers: { "content-type": "application/json" },
      payload: ""
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(UNREADABLE_BODY);
  });

  /**
   * The upload's own version of it: its parser takes bytes, but the client
   * chooses the content-type, so `application/json` with something unreadable
   * lands on the JSON parser on a route that documents no body at all.
   */
  it("answers an unreadable body on the raw upload route too", async () => {
    const response = await currentApp().inject({
      method: "PUT",
      url: "/upload",
      headers: { "content-type": "application/json" },
      payload: "{oops"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(UNREADABLE_BODY);
  });

  /**
   * The parser's refusals that are not 400 keep their own status.
   *
   * `FST_ERR_CTP_BODY_TOO_LARGE` is 413 and `FST_ERR_CTP_INVALID_MEDIA_TYPE` is
   * 415; no route installing this handler declares either, so Fastify's own
   * body serializes whole and the reader is told which wall they hit. Claiming
   * the code family without the status gate would answer both as a bare 400
   * "could not be read", which is a worse sentence about a photo that is merely
   * too big.
   */
  it("leaves the parser's 413 and 415 alone", async () => {
    const tooLarge = await currentApp().inject({
      method: "PUT",
      url: "/upload",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(256)
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toMatchObject({ code: "FST_ERR_CTP_BODY_TOO_LARGE" });

    const unsupported = await currentApp().inject({
      method: "POST",
      url: "/write",
      headers: { "content-type": "application/xml" },
      payload: "<name/>"
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toMatchObject({ code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" });
  });

  /**
   * The one unreadable body the parser does not name.
   *
   * A client that hangs up mid-body makes the payload stream fail, and
   * `rawBody` stamps `statusCode = 400` onto whatever the stream threw rather
   * than inventing an `FST_ERR_CTP_` of its own — measured here as
   * `Error { code: "ECONNRESET", message: "aborted" }`. So the code family
   * alone would miss a real malformed body, and the handler recognises this one
   * by identity instead: Node destroys a stream *with* the error that killed
   * it, so `request.raw.errored` is the very object the handler was handed.
   *
   * It has to be a real socket. `inject` pipes its payload into a mock request
   * rather than destroying it, so the stream error arrives with
   * `request.raw.errored` still null and this path cannot be reached from
   * there at all. The answer is read off `onSend` because the socket it would
   * be written to is the one that just died.
   */
  it("answers a body whose stream died the same way", async () => {
    const instance = currentApp();
    const sent: Array<{ statusCode: number; payload: string }> = [];
    instance.addHook("onSend", (_request, reply, payload, done) => {
      sent.push({ statusCode: reply.statusCode, payload: typeof payload === "string" ? payload : String(payload) });
      done(null, payload);
    });
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const address = instance.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const socket = connect(port, "127.0.0.1", () => {
      // A Content-Length nothing follows, then the socket goes away.
      socket.write("POST /write HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 400\r\n\r\n{");
      socket.destroy();
    });
    socket.on("error", () => {
      // The far end is meant to die; the assertion is about what the server did.
    });
    await waitFor(() => sent.length > 0);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.statusCode).toBe(400);
    expect(JSON.parse(sent[0]?.payload ?? "{}")).toEqual(UNREADABLE_BODY);
  });
});

describe("an error that is not the body", () => {
  /**
   * The finding this suite was written for. A route-level `errorHandler` is not
   * a parser hook: Fastify hands it everything the route's hooks and its own
   * handler throw, and `statusCode === 400` — which this used to test on its
   * own — is the shape every Fastify-family error carries. All four installers
   * rethrow whatever `sendCharacterWriteError` does not recognise, and
   * `POST /:id/portrait` runs `enqueueGenerationJob`, `dispatchGenerationJob`
   * and `startGenerationAttempt` long after the parse.
   */
  it("hands a handler's own 400 back with its code and message", async () => {
    const response = await currentApp().inject({
      method: "POST",
      url: "/throws?status=400&code=CHARACTER_NOT_FOUND",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "CHARACTER_NOT_FOUND",
      message: "That character is not in your library."
    });
    expect(response.body).not.toContain("That request could not be read.");
  });

  /**
   * A 400 was never the only status a handler can reach this with, and the rest
   * were already passing through — this pins that they still do, and that the
   * fix did not turn the fall-through into something narrower than Fastify's
   * own handling.
   */
  it("hands a handler's 409 back untouched", async () => {
    const response = await currentApp().inject({
      method: "POST",
      url: "/throws?status=409&code=CHARACTER_EDIT_CONFLICT",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "CHARACTER_EDIT_CONFLICT" });
  });

  /**
   * The same throw on a route whose 400 *is* declared with `mobileAuthError`,
   * which is the shape all four installers have.
   *
   * Fastify's error body is `{ statusCode, error: "Bad Request", message }` and
   * that schema wants `error` to be an object with a required `code`, so the
   * fall-through cannot answer at 400 there — it becomes the
   * `FST_ERR_FAILED_ERROR_SERIALIZATION` the helper's docblock opens with,
   * naming the original error. That is pinned rather than tidied away because
   * it is the reason someone would reach for the bare status test again: a 500
   * that carries the message and gets logged is a bug in the handler that threw
   * it, where a 400 saying "that request could not be read" is a lie told to
   * the reader about their own body, with the real code gone and nothing handed
   * back to Fastify to log.
   */
  it("does not disguise a handler's 400 as a malformed body on a route that declares one", async () => {
    const response = await currentApp().inject({
      method: "POST",
      url: "/throws-declared?status=400&code=CHARACTER_NOT_FOUND",
      headers: { "content-type": "application/json" },
      payload: "{}"
    });

    expect(response.body).not.toContain("That request could not be read.");
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "FST_ERR_FAILED_ERROR_SERIALIZATION",
      message: expect.stringContaining("That character is not in your library.") as unknown as string
    });
  });
});

describe("sendGenerationAttemptError", () => {
  const resetsAt = new Date("2026-08-25T00:00:00.000Z");

  it("answers an exhausted image quota", () => {
    const { reply, response } = recordingReply();

    expect(
      sendGenerationAttemptError(
        reply,
        new GenerationQuotaExceededError({
          allowed: false,
          used: 3,
          limit: 3,
          periodKey: "free:2026-08",
          resetsAt
        })
      )
    ).toBe(true);
    expect(response).toEqual({
      statusCode: 403,
      body: {
        error: {
          code: "IMAGE_LIMIT_REACHED",
          message: "Free plans include 3 illustrated books a month. Upgrade for unlimited, or turn visuals off.",
          imageQuota: { used: 3, limit: 3, resetsAt: resetsAt.toISOString() }
        }
      }
    });
  });

  it("answers insufficient credits with the actionable balance", () => {
    const { reply, response } = recordingReply();

    expect(
      sendGenerationAttemptError(
        reply,
        new InsufficientCreditsError({ requiredCredits: 45, availableCredits: 12, reservedCredits: 3 })
      )
    ).toBe(true);
    expect(response).toEqual({
      statusCode: 402,
      body: {
        error: {
          code: "INSUFFICIENT_CREDITS",
          message: "You need more credits for this action.",
          requiredCredits: 45,
          availableCredits: 12,
          reservedCredits: 3
        }
      }
    });
  });

  it("answers an attempt conflict with its shipped wire code", () => {
    const { reply, response } = recordingReply();

    expect(
      sendGenerationAttemptError(reply, new GenerationAttemptConflictError("That command has different settings."))
    ).toBe(true);
    expect(response).toEqual({
      statusCode: 409,
      body: {
        error: {
          code: "GENERATION_COMMAND_CONFLICT",
          message: "That command has different settings."
        }
      }
    });
  });

  /**
   * The fourth rung, and the one that is not a refusal.
   *
   * A claim error means the paid start was wired onto work it does not own, so
   * the status stays 500 — there is no setting the reader could change. What it
   * may not do is hand over the error's own words: `assertPrimaryJobBelongsToAttempt`
   * writes them for whoever is reading the log, and rethrowing put that string
   * straight into Fastify's default 500 body.
   */
  it("answers a job-claim fault as a logged 500 that ships none of its own words", () => {
    const { reply, response, logged } = recordingReply();
    const claim = new GenerationAttemptJobClaimError(
      "Generation attempt attempt-2 may not claim generation job job-1: it is already attempt attempt-1's work. " +
        "A create() callback must enqueue its own job with this attemptId, never return one it found under a spent dedupeKey."
    );

    expect(sendGenerationAttemptError(reply, claim)).toBe(true);
    expect(response).toEqual({
      statusCode: 500,
      body: {
        error: {
          code: "GENERATION_JOB_NOT_CLAIMED",
          message: "That couldn’t be started, so nothing was charged. Try again in a moment."
        }
      }
    });
    expect(JSON.stringify(response.body)).not.toMatch(/dedupeKey|create\(\)|attemptId|attempt-\d|job-\d/);
    // Answering means the caller stops rethrowing, so this rung owns the log.
    expect(logged).toEqual([claim]);
  });

  it("leaves unknown errors for the caller to rethrow", () => {
    const { reply, response } = recordingReply();

    expect(sendGenerationAttemptError(reply, new Error("database unavailable"))).toBe(false);
    expect(response).toEqual({ statusCode: null, body: null });
  });
});

function recordingReply(): {
  reply: FastifyReply;
  response: { statusCode: number | null; body: unknown };
  logged: unknown[];
} {
  const response: { statusCode: number | null; body: unknown } = { statusCode: null, body: null };
  const logged: unknown[] = [];
  const reply = {
    log: {
      error(details: { err?: unknown }) {
        logged.push(details.err);
      }
    },
    code(statusCode: number) {
      response.statusCode = statusCode;
      return this;
    },
    send(body: unknown) {
      response.body = body;
      return this;
    }
  } as unknown as FastifyReply;
  return { reply, response, logged };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the server to answer");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
