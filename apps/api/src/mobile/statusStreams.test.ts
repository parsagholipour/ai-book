import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { objectStore } from "@book-maker/storage";
import type { FastifyInstance } from "fastify";
import { buildProjectStatus } from "../projectStatus.js";
import {
  admitStatusStream,
  openStatusStreamCount,
  STATUS_STREAMS_PER_USER,
  statusStreamTiming
} from "./statusStreams.js";
import {
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  statusRecord,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

const defaultTiming = { ...statusStreamTiming };

function generating(complete: number) {
  return statusRecord({
    project: { id: "project-1", status: "GENERATING", targetPages: 10 },
    progress: {
      pages: { complete, target: 10 },
      pipeline: [
        { key: "plan", label: "Plan", status: "done" },
        { key: "pages", label: "Pages", status: "active", detail: `${complete}/10 pages` },
        { key: "images", label: "Images", status: "pending", detail: "0 images" },
        { key: "export", label: "Export", status: "pending" }
      ]
    }
  });
}

/** Reads a live stream as text until `done` says so, or the stream ends. */
class StreamReader {
  text = "";
  ended = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly pump: Promise<void>;

  constructor(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    this.reader = reader;
    this.pump = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          this.text += this.decoder.decode(chunk.value, { stream: true });
        }
      } catch {
        // cancelled
      }
      this.ended = true;
    })();
  }

  async until(predicate: (reader: StreamReader) => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this)) {
      if (Date.now() > deadline) throw new Error(`Timed out; stream so far:\n${this.text}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  count(fragment: string): number {
    return this.text.split(fragment).length - 1;
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
    await this.pump;
  }
}

describe("admitStatusStream", () => {
  it("ends an account's oldest streams past the cap and leaves other accounts alone", () => {
    const ended: string[] = [];
    const releases = Array.from({ length: STATUS_STREAMS_PER_USER }, (_, index) =>
      admitStatusStream("user-cap", { end: (code) => ended.push(`${index}:${code}`) })
    );
    const other = admitStatusStream("user-other", { end: () => ended.push("other") });

    const newest = admitStatusStream("user-cap", { end: () => ended.push("newest") });

    expect(ended).toEqual(["0:STATUS_STREAM_REPLACED"]);
    expect(openStatusStreamCount("user-cap")).toBe(STATUS_STREAMS_PER_USER);
    expect(openStatusStreamCount("user-other")).toBe(1);
    for (const release of [...releases, other, newest]) release();
    expect(openStatusStreamCount("user-cap")).toBe(0);
    expect(openStatusStreamCount("user-other")).toBe(0);
  });
});

describe("GET /api/mobile/projects/:id/status/events", () => {
  let app: FastifyInstance;
  let base: string;
  const readers: StreamReader[] = [];

  async function open(token = "token-a"): Promise<StreamReader> {
    const response = await fetch(`${base}/api/mobile/projects/project-1/status/events`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.status).toBe(200);
    const reader = new StreamReader(response.body!);
    readers.push(reader);
    return reader;
  }

  beforeEach(async () => {
    resetMobileHarness();
    Object.assign(statusStreamTiming, { pollMs: 20, heartbeatMs: 60, sessionCheckMs: 40 });
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
    app = await buildMobileApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP port.");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const reader of readers.splice(0)) await reader.cancel();
    await app.close();
    Object.assign(statusStreamTiming, defaultTiming);
    teardownMobileHarness();
  });

  it("sends a status only when it changed, and a comment heartbeat in between", async () => {
    vi.mocked(buildProjectStatus).mockResolvedValue(generating(3) as never);
    const stream = await open();

    await stream.until((reader) => reader.count(": ping") >= 2);
    expect(stream.count("event: status")).toBe(1);
    // Many polls ran while it said nothing new.
    expect(vi.mocked(buildProjectStatus).mock.calls.length).toBeGreaterThan(3);

    vi.mocked(buildProjectStatus).mockResolvedValue(generating(4) as never);
    await stream.until((reader) => reader.count("event: status") === 2);
    expect(stream.text).toContain('"completed":4');
    expect(stream.ended).toBe(false);
  });

  it("never asks storage about exports while the book is generating", async () => {
    const head = vi.spyOn(objectStore(), "head");
    vi.mocked(buildProjectStatus).mockResolvedValue(generating(3) as never);
    const stream = await open();
    await stream.until((reader) => reader.count("event: status") === 1);
    expect(head).not.toHaveBeenCalled();
    expect(stream.text).toContain('"available":false');
  });

  it("ends the account's oldest stream when a fourth one opens", async () => {
    vi.mocked(buildProjectStatus).mockResolvedValue(generating(3) as never);
    const streams = [];
    for (let index = 0; index < STATUS_STREAMS_PER_USER; index += 1) {
      const stream = await open();
      await stream.until((reader) => reader.count("event: status") === 1);
      streams.push(stream);
    }

    const fourth = await open();
    await fourth.until((reader) => reader.count("event: status") === 1);

    await streams[0]!.until((reader) => reader.ended);
    expect(streams[0]!.text).toContain('"code":"STATUS_STREAM_REPLACED"');
    expect(streams.slice(1).every((stream) => !stream.ended)).toBe(true);
    expect(fourth.ended).toBe(false);
    expect(openStatusStreamCount("user-a")).toBe(STATUS_STREAMS_PER_USER);
  });

  it("ends when the session it was opened with is revoked", async () => {
    vi.mocked(buildProjectStatus).mockResolvedValue(generating(3) as never);
    const stream = await open();
    await stream.until((reader) => reader.count("event: status") === 1);

    // The stream's re-check sees the session row revoked (a password reset, a
    // logout elsewhere, or the token refresh that replaced it).
    const live = mockPrisma.mobileSession.findUnique.getMockImplementation()!;
    mockPrisma.mobileSession.findUnique.mockImplementation(async (args: never) => {
      const session = await live(args);
      return session ? { ...session, revokedAt: new Date() } : null;
    });

    await stream.until((reader) => reader.ended);
    expect(stream.text).toContain('"code":"STATUS_STREAM_SESSION_ENDED"');
    expect(stream.text).not.toContain("SESSION_REVOKED");
    expect(openStatusStreamCount("user-a")).toBe(0);
  });

  it("ends when the access token it was opened with expires", async () => {
    vi.mocked(buildProjectStatus).mockResolvedValue(generating(3) as never);
    const stream = await open();
    await stream.until((reader) => reader.count("event: status") === 1);

    const live = mockPrisma.mobileSession.findUnique.getMockImplementation()!;
    mockPrisma.mobileSession.findUnique.mockImplementation(async (args: never) => {
      const session = await live(args);
      return session ? { ...session, accessTokenExpiresAt: new Date(Date.now() - 1_000) } : null;
    });

    await stream.until((reader) => reader.ended);
    expect(stream.text).toContain('"code":"STATUS_STREAM_SESSION_ENDED"');
  });

  it("keeps streaming through a session read that fails", async () => {
    vi.mocked(buildProjectStatus).mockResolvedValue(generating(3) as never);
    const stream = await open();
    await stream.until((reader) => reader.count("event: status") === 1);
    mockPrisma.mobileSession.findUnique.mockRejectedValue(new Error("pool timeout"));

    await stream.until((reader) => reader.count(": ping") >= 2);
    expect(stream.ended).toBe(false);
  });
});
