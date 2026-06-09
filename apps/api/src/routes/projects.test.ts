import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@book-maker/core";
import { registerAuth } from "../auth.js";

const mockPrisma = vi.hoisted(() => ({
  template: { findMany: vi.fn() },
  voiceCharacter: { findUnique: vi.fn() },
  voiceCallEvent: { create: vi.fn() }
}));

vi.mock("@book-maker/db", () => ({
  ensureSeedTemplates: vi.fn(),
  Prisma: {},
  prisma: mockPrisma
}));

vi.mock("../queue.js", () => ({
  enqueueGenerationJob: vi.fn(),
  isBullJobActive: vi.fn(),
  requeueGenerationJob: vi.fn(),
  stopProjectGenerationJobs: vi.fn()
}));

const originalEnv = { ...process.env };

describe("project voice routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env = {
      ...originalEnv,
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_TURN_TOKEN: "",
      WEB_PASSWORD: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      VOICE_CHAT_PROVIDER: "openai_realtime"
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("returns RTC config with relay metadata and without TURN secrets", async () => {
    process.env.VOICE_RTC_TURN_URLS = "turn:turn.example.com:3478";
    process.env.VOICE_RTC_TURN_SHARED_SECRET = "shared-secret";
    process.env.VOICE_RTC_TURN_TTL_SECONDS = "120";
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/voice/rtc-config" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.relayConfigured).toBe(true);
    expect(body.ttlSeconds).toBe(120);
    expect(JSON.stringify(body)).not.toContain("shared-secret");
    expect(body.iceServers.at(-1)).toEqual(
      expect.objectContaining({
        urls: ["turn:turn.example.com:3478"],
        credentialType: "password"
      })
    );
    await app.close();
  });

  it("protects voice routes when web auth is enabled", async () => {
    process.env.WEB_PASSWORD = "secret";
    const app = await buildApp({ auth: true });

    const unauthorized = await app.inject({ method: "GET", url: "/api/voice/rtc-config" });
    expect(unauthorized.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "secret" }
    });
    const cookie = login.headers["set-cookie"];
    const authorized = await app.inject({
      method: "GET",
      url: "/api/voice/rtc-config",
      headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie }
    });

    expect(authorized.statusCode).toBe(200);
    await app.close();
  });

  it("reports selectable voice providers", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.VOICE_CHAT_PROVIDER = "gemini_live";
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/voice/providers" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toEqual([
      expect.objectContaining({
        id: "gemini_live",
        label: "Gemini Live",
        configured: true,
        default: true,
        transport: "gemini_live"
      }),
      expect.objectContaining({
        id: "openai_realtime",
        label: "OpenAI Realtime",
        configured: true,
        default: false,
        transport: "webrtc_sdp",
        model: "gpt-realtime-2",
        modelOptions: expect.arrayContaining([
          expect.objectContaining({ model: "gpt-realtime-2", default: true }),
          expect.objectContaining({ model: "gpt-realtime-mini", default: false })
        ])
      })
    ]);
    await app.close();
  });

  it("creates OpenAI voice sessions with the selected provider", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("answer-sdp", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mockPrisma.voiceCharacter.findUnique.mockResolvedValue(readyCharacter({ voiceProvider: "gemini_live" }));
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/voice-characters/character-1/calls",
      payload: {
        provider: "openai_realtime",
        transport: "webrtc_sdp",
        voiceModel: "gpt-realtime-mini",
        offerSdp: "offer-sdp"
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      type: "webrtc_sdp_answer",
      provider: "openai_realtime",
      answerSdp: "answer-sdp"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/calls",
      expect.objectContaining({ method: "POST" })
    );
    const request = fetchMock.mock.calls.at(0)?.[1] as { body?: FormData } | undefined;
    const session = JSON.parse(String(request?.body?.get("session"))) as { model?: string };
    expect(session.model).toBe("gpt-realtime-mini");
    await app.close();
    vi.unstubAllGlobals();
  });

  it("creates Gemini Live token sessions for old OpenAI characters", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ name: "gemini-ephemeral-token" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    mockPrisma.voiceCharacter.findUnique.mockResolvedValue(readyCharacter({ voiceProvider: "openai_realtime" }));
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/voice-characters/character-1/calls",
      payload: {
        provider: "gemini_live",
        transport: "gemini_live",
        sessionHandle: "resume-handle"
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      type: "gemini_live_token",
      provider: "gemini_live",
      token: "gemini-ephemeral-token"
    });
    expect(JSON.stringify(body)).not.toContain("gemini-key");
    expect(fetchMock).toHaveBeenCalled();
    await app.close();
  });

  it("rejects unconfigured selected voice providers", async () => {
    mockPrisma.voiceCharacter.findUnique.mockResolvedValue(readyCharacter({ voiceProvider: "openai_realtime" }));
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/voice-characters/character-1/calls",
      payload: {
        provider: "gemini_live",
        transport: "gemini_live"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Gemini Live is not configured");
    await app.close();
  });

  it("stores sanitized voice call events", async () => {
    mockPrisma.voiceCharacter.findUnique.mockResolvedValue({ id: "character-1", projectId: "project-1" });
    mockPrisma.voiceCallEvent.create.mockResolvedValue({ id: "event-1" });
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/voice-characters/character-1/call-events",
      payload: {
        clientCallId: "call-1",
        phase: "disconnected",
        attempt: 2,
        elapsedMs: 9123,
        connectionState: "disconnected",
        iceConnectionState: "disconnected",
        iceGatheringState: "complete",
        candidatePairType: "relay",
        candidateProtocol: "udp",
        currentRoundTripTimeMs: 82,
        packetsLost: 1,
        jitterMs: 7,
        error: "ICE failed for 192.168.1.50",
        metadata: {
          online: true,
          relayConfigured: true,
          sdp: "must-not-store",
          ipAddress: "10.0.0.4",
          note: "temporary dip"
        }
      }
    });

    expect(response.statusCode).toBe(202);
    expect(mockPrisma.voiceCallEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project-1",
        characterId: "character-1",
        clientCallId: "call-1",
        phase: "disconnected",
        candidatePairType: "relay",
        error: "ICE failed for [redacted-ip]",
        metadata: {
          online: true,
          relayConfigured: true,
          note: "temporary dip"
        }
      })
    });
    await app.close();
  });

  it("returns not found for call events on unknown characters", async () => {
    mockPrisma.voiceCharacter.findUnique.mockResolvedValue(null);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/voice-characters/missing/call-events",
      payload: {
        clientCallId: "call-1",
        phase: "failed"
      }
    });

    expect(response.statusCode).toBe(404);
    expect(mockPrisma.voiceCallEvent.create).not.toHaveBeenCalled();
    await app.close();
  });
});

function readyCharacter(overrides: Record<string, unknown> = {}) {
  return {
    id: "character-1",
    projectId: "project-1",
    name: "Lina",
    role: "Guide",
    description: "A steady guide.",
    status: "READY",
    voiceProvider: "openai_realtime",
    voiceModel: "gpt-realtime-2",
    voiceId: "alloy",
    voiceProfile: {
      ageBand: "adult",
      genderPresentation: "feminine",
      energy: "medium",
      warmth: "medium",
      pace: "medium",
      formality: "balanced"
    },
    providerMetadata: {},
    persona: {
      instructions: "You are Lina."
    },
    project: {
      status: "COMPLETE"
    },
    ...overrides
  };
}

async function buildApp(options: { auth?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify();
  if (options.auth) {
    await registerAuth(app, loadConfig(process.env));
  }
  const { projectRoutes } = await import("./projects.js");
  await app.register(projectRoutes);
  return app;
}
