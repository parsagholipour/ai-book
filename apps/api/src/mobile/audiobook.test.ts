import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  InsufficientCreditsError,
  commitReservedCredits,
  refundCreditLedgerEntry,
  reserveCredits
} from "@book-maker/db/billing";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enqueueGenerationJob } from "../queue.js";
import {
  bearer,
  buildMobileApp,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

function audiobookRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "audiobook-1",
    projectId: "project-1",
    voice: "Zephyr",
    status: "COMPLETE",
    contentRevision: 3,
    totalDurationMs: 600_000,
    fallbackReason: null,
    renderVersion: 1,
    generationJobId: "job-1",
    error: null,
    chapters: [
      {
        index: 1,
        title: "Low Tide",
        status: "READY",
        durationMs: 300_000,
        estimatedDurationMs: 290_000,
        byteSize: 2_400_000,
        segmentCount: 120
      },
      {
        index: 2,
        title: "The Lamp",
        status: "PENDING",
        durationMs: null,
        estimatedDurationMs: 310_000,
        byteSize: null,
        segmentCount: 130
      }
    ],
    ...overrides
  };
}

function writeChapterFiles(audiobookId = "audiobook-1", projectId = "project-1") {
  const dir = join(state.audioStorageDir!, projectId, audiobookId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chapter-1.mp3"), "fake-mp3-bytes");
  writeFileSync(join(dir, "chapter-1.timeline.json"), JSON.stringify({ version: 1, segments: [] }));
  return dir;
}

describe("mobile audiobook routes", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
  });
  afterEach(teardownMobileHarness);

  describe("narrator voices", () => {
    it("lists narrators with a sample each, and no provider details", async () => {
      const app = await buildMobileApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/audiobook/voices",
        headers: bearer("token-a")
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.voices.length).toBeGreaterThan(3);
      expect(body.voices[0]).toMatchObject({
        voice: expect.any(String),
        name: expect.any(String),
        blurb: expect.any(String),
        sampleUrl: expect.stringContaining("/sample")
      });
      expect(JSON.stringify(body)).not.toMatch(/gemini|tts-|provider|model/i);
      await app.close();
    });

    it("requires a signed-in reader", async () => {
      const app = await buildMobileApp();
      expect((await app.inject({ method: "GET", url: "/api/mobile/audiobook/voices" })).statusCode).toBe(401);
      await app.close();
    });

    it("serves a pre-generated MP3 sample without provider credentials", async () => {
      const app = await buildMobileApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/audiobook/voices/Zephyr/sample?v=1",
        headers: bearer("token-a")
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("audio/mpeg");
      expect(response.headers["cache-control"]).toContain("immutable");
      expect(response.rawPayload.byteLength).toBeGreaterThan(10_000);
      await app.close();
    });

    it("refuses to synthesize a sample for a voice that is not offered", async () => {
      const app = await buildMobileApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/audiobook/voices/NotAVoice/sample",
        headers: bearer("token-a")
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("VOICE_NOT_FOUND");
      await app.close();
    });
  });

  describe("the manifest", () => {
    it("reports per-chapter readiness and hands out URLs only for finished chapters", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", contentRevision: 3 });
      mockPrisma.audiobook.findUnique.mockResolvedValue(audiobookRecord());
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a")
      });

      expect(response.statusCode).toBe(200);
      const { audiobook } = response.json();
      expect(audiobook).toMatchObject({
        status: "complete",
        voice: "Zephyr",
        isStale: false,
        backupNarrationUsed: false
      });
      expect(audiobook.chapters[0]).toMatchObject({
        status: "ready",
        audioUrl: "/api/mobile/projects/project-1/audiobook/chapters/1/audio?v=1",
        timelineUrl: "/api/mobile/projects/project-1/audiobook/chapters/1/timeline?v=1"
      });
      // A chapter that is not narrated yet must not advertise a download.
      expect(audiobook.chapters[1]).toMatchObject({ status: "pending", audioUrl: null, timelineUrl: null });
      await app.close();
    });

    it("discloses backup narration and versions replacement media URLs", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", contentRevision: 3 });
      mockPrisma.audiobook.findUnique.mockResolvedValue(
        audiobookRecord({ fallbackReason: "gemini_rate_limit", renderVersion: 2 })
      );
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a")
      });

      const audiobook = response.json().audiobook;
      expect(audiobook).toMatchObject({ backupNarrationUsed: true });
      expect(audiobook.chapters[0]).toMatchObject({
        audioUrl: "/api/mobile/projects/project-1/audiobook/chapters/1/audio?v=2",
        timelineUrl: "/api/mobile/projects/project-1/audiobook/chapters/1/timeline?v=2"
      });
      expect(JSON.stringify(response.json())).not.toContain("gemini_rate_limit");
      await app.close();
    });

    it("adds measured and predicted chapters so the player can draw one timeline", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", contentRevision: 3 });
      mockPrisma.audiobook.findUnique.mockResolvedValue(audiobookRecord());
      const app = await buildMobileApp();

      const { audiobook } = (
        await app.inject({
          method: "GET",
          url: "/api/mobile/projects/project-1/audiobook",
          headers: bearer("token-a")
        })
      ).json();

      expect(audiobook.totalEstimatedDurationMs).toBe(300_000 + 310_000);
      await app.close();
    });

    it("flags a narration made before the book was edited", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", contentRevision: 9 });
      mockPrisma.audiobook.findUnique.mockResolvedValue(audiobookRecord({ contentRevision: 3 }));
      const app = await buildMobileApp();

      const { audiobook } = (
        await app.inject({
          method: "GET",
          url: "/api/mobile/projects/project-1/audiobook",
          headers: bearer("token-a")
        })
      ).json();

      expect(audiobook.isStale).toBe(true);
      await app.close();
    });

    it("reports progress while chapters are still being narrated", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", contentRevision: 3 });
      mockPrisma.audiobook.findUnique.mockResolvedValue(audiobookRecord({ status: "GENERATING" }));
      const app = await buildMobileApp();

      const { audiobook } = (
        await app.inject({
          method: "GET",
          url: "/api/mobile/projects/project-1/audiobook",
          headers: bearer("token-a")
        })
      ).json();

      expect(audiobook.status).toBe("generating");
      expect(audiobook.progress).toMatchObject({ chaptersReady: 1, chapterCount: 2, percent: 50 });
      await app.close();
    });

    it("says a book has not been narrated rather than inventing an empty one", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", contentRevision: 1 });
      mockPrisma.audiobook.findUnique.mockResolvedValue(null);
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a")
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("AUDIOBOOK_NOT_FOUND");
      await app.close();
    });

    it("hides another reader's audiobook behind the same 404 as a missing book", async () => {
      mockPrisma.project.findFirst.mockResolvedValue(null);
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-b")
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("PROJECT_NOT_FOUND");
      await app.close();
    });
  });

  describe("starting a narration", () => {
    beforeEach(() => {
      mockPrisma.project.findFirst.mockResolvedValue({
        id: "project-1",
        status: "COMPLETE",
        contentRevision: 3
      });
      mockPrisma.audiobook.findUnique.mockResolvedValue(null);
      mockPrisma.page.count.mockResolvedValue(60);
      mockPrisma.audiobook.create.mockResolvedValue({ id: "audiobook-new" });
      mockPrisma.audiobook.update.mockResolvedValue({});
      mockPrisma.audiobook.deleteMany.mockResolvedValue({ count: 0 });
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-audiobook" }));
      vi.mocked(reserveCredits).mockResolvedValue({ id: "reservation-1" } as never);
      vi.mocked(commitReservedCredits).mockResolvedValue({ id: "spend-1" } as never);
    });

    it("charges base plus per page and queues one narration job", async () => {
      const app = await buildMobileApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Zephyr" }
      });

      expect(response.statusCode).toBe(202);
      expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-a",
          projectId: "project-1",
          operation: "AUDIOBOOK_GENERATION",
          // 80 base + 60 pages × 12.
          amountCredits: 800,
          idempotencyKey: "mobile:audiobook:project-1:3:Zephyr:new",
          metadata: expect.objectContaining({ pageCount: 60, voice: "Zephyr" })
        })
      );
      expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-1",
          type: "GENERATE_AUDIOBOOK",
          dedupeKey: "generate-audiobook:project-1:audiobook-new:new",
          dispatch: false,
          payload: expect.objectContaining({ audiobookId: "audiobook-new", billingLedgerEntryId: "spend-1" })
        })
      );
      await app.close();
    });

    it("stamps the ledger entry on the job so a worker failure refunds the right charge", async () => {
      const app = await buildMobileApp();
      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Zephyr" }
      });

      const payload = vi.mocked(enqueueGenerationJob).mock.calls[0]![0].payload as Record<string, unknown>;
      expect(payload.billingLedgerEntryId).toBe("spend-1");
      await app.close();
    });

    it("refunds when the job cannot be queued", async () => {
      vi.mocked(enqueueGenerationJob).mockRejectedValueOnce(new Error("queue down"));
      const app = await buildMobileApp();

      await expect(
        app.inject({
          method: "POST",
          url: "/api/mobile/projects/project-1/audiobook",
          headers: bearer("token-a"),
          payload: { voice: "Zephyr" }
        })
      ).resolves.toMatchObject({ statusCode: 500 });

      expect(vi.mocked(refundCreditLedgerEntry)).toHaveBeenCalledWith("spend-1", expect.any(String));
      await app.close();
    });

    it("answers 402 rather than starting work nobody can pay for", async () => {
      vi.mocked(reserveCredits).mockRejectedValueOnce(new InsufficientCreditsError({ requiredCredits: 800, availableCredits: 10, reservedCredits: 0 }));
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Zephyr" }
      });

      expect(response.statusCode).toBe(402);
      expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
      await app.close();
    });

    it("reuses one charge when the app retries with the same request id", async () => {
      const app = await buildMobileApp();
      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Zephyr", requestId: "request-abc123" }
      });

      expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "mobile:audiobook:project-1:request-abc123" })
      );
      await app.close();
    });

    it("returns the narration already running instead of charging twice", async () => {
      mockPrisma.audiobook.findUnique.mockResolvedValue(audiobookRecord({ status: "GENERATING" }));
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Zephyr" }
      });

      expect(response.statusCode).toBe(202);
      expect(response.json().audiobook.status).toBe("generating");
      expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
      await app.close();
    });

    it("makes replacing a finished audiobook an explicit choice", async () => {
      mockPrisma.audiobook.findUnique.mockResolvedValue(audiobookRecord());
      const app = await buildMobileApp();

      const refused = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Kore" }
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe("AUDIOBOOK_EXISTS");
      expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();

      const accepted = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Kore", replace: true }
      });
      expect(accepted.statusCode).toBe(202);
      expect(vi.mocked(reserveCredits)).toHaveBeenCalled();
      await app.close();
    });

    it("resumes a narration that failed part way rather than re-reading the finished chapters", async () => {
      mockPrisma.audiobook.findUnique.mockResolvedValue(
        audiobookRecord({ status: "FAILED", error: "Gemini TTS request failed (429)" })
      );
      mockPrisma.audiobook.update.mockResolvedValue({ id: "audiobook-1" });
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        // Same book, same narrator: the chapters already on disk still apply.
        payload: { voice: "Zephyr" }
      });

      expect(response.statusCode).toBe(202);
      // The row survives, so the worker still sees which chapters are READY.
      expect(mockPrisma.audiobook.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.audiobook.create).not.toHaveBeenCalled();
      expect(mockPrisma.audiobook.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "audiobook-1" },
          data: expect.objectContaining({ status: "GENERATING", error: null })
        })
      );
      expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
        expect.objectContaining({
          // Naming the failed run keeps the key new; the old one already has a job row.
          dedupeKey: "generate-audiobook:project-1:audiobook-1:job-1",
          payload: expect.objectContaining({ audiobookId: "audiobook-1" })
        })
      );
      await app.close();
    });

    it("charges again for a resumed narration, because the failed one was refunded", async () => {
      mockPrisma.audiobook.findUnique.mockResolvedValue(audiobookRecord({ status: "FAILED" }));
      mockPrisma.audiobook.update.mockResolvedValue({ id: "audiobook-1" });
      const app = await buildMobileApp();

      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Zephyr" }
      });

      // A key stable across attempts would find the first attempt's refunded
      // entry, and committing an already-settled row is a no-op — so the retry
      // narrated the whole book for nothing. Naming the run being superseded is
      // what makes this a second charge.
      expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCredits: 800,
          idempotencyKey: "mobile:audiobook:project-1:3:Zephyr:job-1"
        })
      );
      await app.close();
    });

    it("charges again when a finished audiobook is replaced with the same narrator", async () => {
      mockPrisma.audiobook.findUnique.mockResolvedValue(audiobookRecord());
      const app = await buildMobileApp();

      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Zephyr", replace: true }
      });

      expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "mobile:audiobook:project-1:3:Zephyr:job-1" })
      );
      await app.close();
    });

    it("starts clean when the failed narration used a different narrator", async () => {
      mockPrisma.audiobook.findUnique.mockResolvedValue(audiobookRecord({ status: "FAILED" }));
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Kore" }
      });

      expect(response.statusCode).toBe(202);
      // Chapters read by another narrator cannot be kept, so the row goes.
      expect(mockPrisma.audiobook.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.audiobook.create).toHaveBeenCalled();
      await app.close();
    });

    it("starts clean when the book has been edited since the narration failed", async () => {
      mockPrisma.audiobook.findUnique.mockResolvedValue(
        audiobookRecord({ status: "FAILED", contentRevision: 2 })
      );
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Zephyr" }
      });

      expect(response.statusCode).toBe(202);
      expect(mockPrisma.audiobook.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.audiobook.create).toHaveBeenCalled();
      await app.close();
    });

    it("rejects a narrator that is not on the list", async () => {
      const app = await buildMobileApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Sinatra" }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VOICE_NOT_FOUND");
      expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
      await app.close();
    });

    it("will not narrate a book that is not finished", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({
        id: "project-1",
        status: "GENERATING",
        contentRevision: 1
      });
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a"),
        payload: { voice: "Zephyr" }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("BOOK_NOT_READY");
      await app.close();
    });

    it("will not narrate someone else's book", async () => {
      mockPrisma.project.findFirst.mockResolvedValue(null);
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-b"),
        payload: { voice: "Zephyr" }
      });

      expect(response.statusCode).toBe(404);
      expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("chapter files", () => {
    it("serves audio and its timeline for a finished chapter", async () => {
      writeChapterFiles();
      mockPrisma.audiobook.findFirst.mockResolvedValue({
        id: "audiobook-1",
        projectId: "project-1",
        chapters: [{ status: "READY" }]
      });
      const app = await buildMobileApp();

      const audio = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/audiobook/chapters/1/audio",
        headers: bearer("token-a")
      });
      expect(audio.statusCode).toBe(200);
      expect(audio.headers["content-type"]).toContain("audio/mpeg");
      expect(audio.headers["cache-control"]).toContain("private");

      const timeline = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/audiobook/chapters/1/timeline",
        headers: bearer("token-a")
      });
      expect(timeline.statusCode).toBe(200);
      expect(timeline.json().version).toBe(1);
      await app.close();
    });

    it("withholds a chapter that is not narrated yet", async () => {
      writeChapterFiles();
      mockPrisma.audiobook.findFirst.mockResolvedValue({
        id: "audiobook-1",
        projectId: "project-1",
        chapters: [{ status: "PENDING" }]
      });
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/audiobook/chapters/1/audio",
        headers: bearer("token-a")
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("AUDIOBOOK_CHAPTER_NOT_FOUND");
      await app.close();
    });

    it("does not hand a chapter to a reader who does not own the book", async () => {
      writeChapterFiles();
      // The ownership filter is in the query, so a stranger simply finds nothing.
      mockPrisma.audiobook.findFirst.mockResolvedValue(null);
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/audiobook/chapters/1/audio",
        headers: bearer("token-b")
      });

      expect(response.statusCode).toBe(404);
      await app.close();
    });

    it("requires authentication before touching the filesystem", async () => {
      const app = await buildMobileApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/audiobook/chapters/1/audio"
      });
      expect(response.statusCode).toBe(401);
      expect(mockPrisma.audiobook.findFirst).not.toHaveBeenCalled();
      await app.close();
    });

    it("reports a missing file as a chapter that is not ready", async () => {
      mockPrisma.audiobook.findFirst.mockResolvedValue({
        id: "audiobook-1",
        projectId: "project-1",
        chapters: [{ status: "READY" }]
      });
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/audiobook/chapters/1/audio",
        headers: bearer("token-a")
      });

      expect(response.statusCode).toBe(404);
      await app.close();
    });
  });

  it("keeps provider and model names out of every audiobook response", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", contentRevision: 3 });
    mockPrisma.audiobook.findUnique.mockResolvedValue(audiobookRecord());
    const app = await buildMobileApp();

    const body = (
      await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-1/audiobook",
        headers: bearer("token-a")
      })
    ).json();

    expect(JSON.stringify(body)).not.toMatch(/strategy|provider|temperature|gemini/i);
    await app.close();
  });

  it("still lists projects normally when a book has no narration", async () => {
    mockPrisma.project.findMany.mockResolvedValue([projectRecord({ id: "project-1" })]);
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects",
      headers: bearer("token-a")
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
