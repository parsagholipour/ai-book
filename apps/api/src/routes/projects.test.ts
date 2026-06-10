import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@book-maker/core";
import { registerAuth } from "../auth.js";

const mockPrisma = vi.hoisted(() => ({
  template: { findMany: vi.fn() },
  project: { findUnique: vi.fn() },
  voiceCharacter: { findUnique: vi.fn(), findMany: vi.fn() },
  voiceCallEvent: { create: vi.fn() },
  voiceConversation: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() }
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
let tempVoiceStorageDir: string | null = null;

describe("project voice routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    tempVoiceStorageDir = mkdtempSync(join(tmpdir(), "book-maker-voice-"));
    process.env = {
      ...originalEnv,
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_TURN_TOKEN: "",
      WEB_PASSWORD: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      VOICE_CHAT_PROVIDER: "openai_realtime",
      VOICE_STORAGE_DIR: tempVoiceStorageDir
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    if (tempVoiceStorageDir) {
      rmSync(tempVoiceStorageDir, { recursive: true, force: true });
      tempVoiceStorageDir = null;
    }
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

  it("creates OpenAI voice room sessions for a listener and ready participants", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    const fetchMock = vi.fn(async () => new Response("answer-sdp", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mockPrisma.project.findUnique.mockResolvedValue({ id: "project-1", status: "COMPLETE" });
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([
      readyCharacter({ id: "character-1", name: "Lina" }),
      readyCharacter({
        id: "character-2",
        name: "Captain Orlo",
        persona: { instructions: "You are Captain Orlo. Avoid later spoilers unless asked." }
      })
    ]);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/voice-rooms/sessions",
      payload: {
        provider: "openai_realtime",
        transport: "webrtc_sdp",
        voiceModel: "gpt-realtime-mini",
        listenerOfferSdp: "listener-offer",
        participants: [
          { characterId: "character-1", offerSdp: "lina-offer" },
          { characterId: "character-2", offerSdp: "orlo-offer" }
        ]
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      provider: "openai_realtime",
      voiceModel: "gpt-realtime-mini",
      listener: { type: "webrtc_sdp_answer", answerSdp: "answer-sdp" },
      participants: [
        { characterId: "character-1", session: { type: "webrtc_sdp_answer" } },
        { characterId: "character-2", session: { type: "webrtc_sdp_answer" } }
      ]
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sessions = (fetchMock.mock.calls as unknown as Array<[unknown, { body?: FormData }]>).map((call) => {
      const request = call[1];
      return JSON.parse(String(request?.body?.get("session"))) as {
        instructions?: string;
        audio?: { output?: unknown; input?: { turn_detection?: { create_response?: boolean } } };
      };
    });
    expect(sessions[0]?.instructions).toContain("hidden listener");
    expect(sessions[0]?.audio?.output).toBeUndefined();
    expect(sessions[0]?.audio?.input?.turn_detection?.create_response).toBe(false);
    expect(sessions[1]?.instructions).toContain("Group voice room rules");
    expect(sessions[1]?.instructions).toContain("Speak only as Lina");
    expect(sessions[1]?.audio?.input).toBeUndefined();
    expect(sessions[2]?.instructions).toContain("Speak only as Captain Orlo");
    expect(sessions[2]?.instructions).toContain("Avoid later spoilers unless asked");
    expect(sessions[2]?.audio?.input).toBeUndefined();
    expect(mockPrisma.voiceCallEvent.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects voice rooms unless the project is complete and all participants are ready", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    mockPrisma.project.findUnique.mockResolvedValue({ id: "project-1", status: "GENERATING" });
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([
      readyCharacter({ id: "character-1", name: "Lina" }),
      readyCharacter({ id: "character-2", name: "Captain Orlo" })
    ]);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/voice-rooms/sessions",
      payload: {
        provider: "openai_realtime",
        transport: "webrtc_sdp",
        listenerOfferSdp: "listener-offer",
        participants: [
          { characterId: "character-1", offerSdp: "lina-offer" },
          { characterId: "character-2", offerSdp: "orlo-offer" }
        ]
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("after the book is complete");
    await app.close();
  });

  it("rejects voice rooms with unavailable selected models", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/voice-rooms/sessions",
      payload: {
        provider: "openai_realtime",
        transport: "webrtc_sdp",
        voiceModel: "not-a-room-model",
        listenerOfferSdp: "listener-offer",
        participants: [
          { characterId: "character-1", offerSdp: "lina-offer" },
          { characterId: "character-2", offerSdp: "orlo-offer" }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("model is not available");
    expect(mockPrisma.project.findUnique).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates saved Gemini TTS voice conversations for two ready characters", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GEMINI_TEXT_MODEL = "gemini-2.5-flash";
    process.env.GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
    const pcm = Buffer.alloc(48_000).toString("base64");
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as {
        generationConfig?: {
          responseModalities?: string[];
          speechConfig?: {
            multiSpeakerVoiceConfig?: {
              speakerVoiceConfigs?: Array<{ speaker: string; voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } }>;
            };
          };
        };
      };
      if (requestBody.generationConfig?.responseModalities?.includes("AUDIO")) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm } }]
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: "Moon Gate Debate",
                      turns: [
                        { speakerName: "Lina", text: "[curious] Should we open the moon gate?" },
                        { speakerName: "Captain Orlo", text: "Only if we can hear what waits behind it." },
                        { speakerName: "Lina", text: "Then listen closely." },
                        { speakerName: "Captain Orlo", text: "[pause] I hear the tide answering back." }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    mockPrisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: "Moon Gate",
      prompt: "A story about a moon gate.",
      status: "COMPLETE",
      currentPlan: { planningPackage: { title: "Moon Gate", premise: "A moon gate opens." } }
    });
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([
      readyCharacter({ id: "character-1", name: "Lina" }),
      readyCharacter({
        id: "character-2",
        name: "Captain Orlo",
        role: "Captain",
        voiceProfile: {
          ageBand: "elder",
          genderPresentation: "masculine",
          energy: "medium",
          warmth: "medium",
          pace: "slow",
          formality: "balanced"
        }
      })
    ]);
    mockPrisma.voiceConversation.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      parentConversationId: null,
      rootConversationId: null,
      ...data,
      createdAt: new Date("2026-06-10T12:00:00.000Z")
    }));
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/voice-conversations",
      payload: {
        prompt: "Let them argue about opening the moon gate.",
        characterIds: ["character-1", "character-2"]
      }
    });
    const body = response.json();
    const ttsRequest = (fetchMock.mock.calls as unknown as Array<[unknown, { body?: string }]>)
      .map((call) => JSON.parse(String(call[1]?.body)) as any)
      .find((payload) => payload.generationConfig?.responseModalities?.includes("AUDIO"));

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      projectId: "project-1",
      prompt: "Let them argue about opening the moon gate.",
      provider: "gemini_tts",
      model: "gemini-3.1-flash-tts-preview",
      durationMs: 1000,
      transcript: {
        title: "Moon Gate Debate"
      }
    });
    expect(body.transcript.turns.slice(0, 2)).toEqual([
      expect.objectContaining({ speakerId: "character-1", speakerName: "Lina" }),
      expect.objectContaining({ speakerId: "character-2", speakerName: "Captain Orlo" })
    ]);
    expect(body.audioPath).toContain("/assets/voice/project-1/");
    expect(mockPrisma.voiceConversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project-1",
        provider: "gemini_tts",
        model: "gemini-3.1-flash-tts-preview",
        audioPath: expect.stringContaining("/assets/voice/project-1/")
      })
    });
    expect(ttsRequest?.generationConfig?.speechConfig?.multiSpeakerVoiceConfig?.speakerVoiceConfigs).toEqual([
      expect.objectContaining({ speaker: "Lina" }),
      expect.objectContaining({ speaker: "Captain Orlo", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Gacrux" } } })
    ]);
    await app.close();
  });

  it("saves temporary characters introduced by the conversation prompt", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GEMINI_TEXT_MODEL = "gemini-2.5-flash";
    process.env.GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
    const pcm = Buffer.alloc(480).toString("base64");
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as any;
      if (requestBody.generationConfig?.responseModalities?.includes("AUDIO")) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm } }]
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: "Mira Joins",
                      temporaryCharacters: [
                        {
                          name: "Mira",
                          role: "Gate mechanic",
                          description: "A warm, fast-talking mechanic who knows the old lock."
                        }
                      ],
                      turns: [
                        { speakerName: "Lina", text: "The moon gate is stuck again." },
                        { speakerName: "Captain Orlo", text: "That is an argument for leaving." },
                        { speakerName: "Mira", text: "[laughs softly] Or for using the right wrench." },
                        { speakerName: "Lina", text: "Mira, please tell him the gate likes you." }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    mockPrisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: "Moon Gate",
      prompt: "A story about a moon gate.",
      status: "COMPLETE",
      currentPlan: { planningPackage: { title: "Moon Gate", premise: "A moon gate opens." } }
    });
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([
      readyCharacter({ id: "character-1", name: "Lina" }),
      readyCharacter({ id: "character-2", name: "Captain Orlo" })
    ]);
    mockPrisma.voiceConversation.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      parentConversationId: null,
      rootConversationId: null,
      ...data,
      createdAt: new Date("2026-06-10T12:00:00.000Z")
    }));
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/voice-conversations",
      payload: {
        prompt: "Have Mira the gate mechanic interrupt Lina and Orlo.",
        characterIds: ["character-1", "character-2"]
      }
    });
    const body = response.json();
    const audioRequests = (fetchMock.mock.calls as unknown as Array<[unknown, { body?: string }]>)
      .map((call) => JSON.parse(String(call[1]?.body)) as any)
      .filter((payload) => payload.generationConfig?.responseModalities?.includes("AUDIO"));

    expect(response.statusCode).toBe(200);
    expect(body.characters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "temporary:mira", name: "Mira", temporary: true, voiceName: expect.any(String) })
      ])
    );
    expect(body.transcript.temporaryCharacters).toEqual([
      expect.objectContaining({ id: "temporary:mira", name: "Mira", role: "Gate mechanic" })
    ]);
    expect(body.transcript.turns[2]).toEqual(expect.objectContaining({ speakerId: "temporary:mira", speakerName: "Mira" }));
    expect(audioRequests).toHaveLength(4);
    expect(audioRequests[0]?.generationConfig?.speechConfig?.voiceConfig).toBeDefined();
    expect(audioRequests[0]?.generationConfig?.speechConfig?.multiSpeakerVoiceConfig).toBeUndefined();
    expect(mockPrisma.voiceConversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        characterSnapshots: expect.arrayContaining([
          expect.objectContaining({ id: "temporary:mira", name: "Mira", temporary: true })
        ]),
        metadata: expect.objectContaining({ synthesisMode: "turn_by_turn" })
      })
    });
    await app.close();
  });

  it("lists saved voice conversations", async () => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: "project-1" });
    mockPrisma.voiceConversation.findMany.mockResolvedValue([
      {
        id: "conversation-1",
        projectId: "project-1",
        parentConversationId: null,
        rootConversationId: "conversation-1",
        prompt: "Talk about the gate.",
        characterSnapshots: [{ id: "character-1", name: "Lina", voiceName: "Sulafat" }],
        transcript: { turns: [{ speakerId: "character-1", speakerName: "Lina", text: "The gate is humming." }] },
        provider: "gemini_tts",
        model: "gemini-3.1-flash-tts-preview",
        audioPath: "http://localhost:4001/assets/voice/project-1/conversation-1.wav",
        durationMs: 1000,
        metadata: {},
        createdAt: new Date("2026-06-10T12:00:00.000Z")
      }
    ]);
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/projects/project-1/voice-conversations" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: "conversation-1",
        createdAt: "2026-06-10T12:00:00.000Z"
      })
    ]);
    expect(mockPrisma.voiceConversation.findMany).toHaveBeenCalledWith({
      where: { projectId: "project-1" },
      orderBy: { createdAt: "desc" },
      take: 20
    });
    await app.close();
  });

  it("continues saved voice conversations with prior transcript context and fixed voices", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GEMINI_TEXT_MODEL = "gemini-2.5-flash";
    process.env.GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
    const pcm = Buffer.alloc(48_000).toString("base64");
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as any;
      if (requestBody.generationConfig?.responseModalities?.includes("AUDIO")) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm } }]
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: "Moon Gate Continuation",
                      turns: [
                        { speakerName: "Lina", text: "We left the gate humming. Now it is answering." },
                        { speakerName: "Captain Orlo", text: "Then keep your hand away from the latch." },
                        { speakerName: "Lina", text: "[quietly] Too late for that." },
                        { speakerName: "Captain Orlo", text: "Then we make the mistake useful." }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const parentConversation = {
      id: "conversation-1",
      projectId: "project-1",
      parentConversationId: null,
      rootConversationId: "conversation-1",
      prompt: "Let them argue about opening the moon gate.",
      characterSnapshots: [
        { id: "character-1", name: "Lina", role: "Guide", description: "A steady guide.", voiceName: "Puck" },
        { id: "character-2", name: "Captain Orlo", role: "Captain", description: "A wary captain.", voiceName: "Sulafat" }
      ],
      transcript: {
        title: "Moon Gate Debate",
        turns: [
          { speakerId: "character-1", speakerName: "Lina", text: "Should we open the moon gate?" },
          { speakerId: "character-2", speakerName: "Captain Orlo", text: "Only if we can hear what waits behind it." }
        ]
      },
      provider: "gemini_tts",
      model: "gemini-3.1-flash-tts-preview",
      audioPath: "http://localhost:4001/assets/voice/project-1/conversation-1.wav",
      durationMs: 1000,
      metadata: {},
      createdAt: new Date("2026-06-10T12:00:00.000Z")
    };
    mockPrisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: "Moon Gate",
      prompt: "A story about a moon gate.",
      status: "COMPLETE",
      currentPlan: { planningPackage: { title: "Moon Gate", premise: "A moon gate opens." } }
    });
    mockPrisma.voiceConversation.findUnique.mockResolvedValue(parentConversation);
    mockPrisma.voiceConversation.findMany.mockResolvedValue([parentConversation]);
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([
      readyCharacter({ id: "character-1", name: "Lina" }),
      readyCharacter({ id: "character-2", name: "Captain Orlo" })
    ]);
    mockPrisma.voiceConversation.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      createdAt: new Date("2026-06-10T12:01:00.000Z")
    }));
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/voice-conversations",
      payload: {
        prompt: "Continue with the gate answering them.",
        continuationOfConversationId: "conversation-1"
      }
    });
    const textRequest = (fetchMock.mock.calls as unknown as Array<[unknown, { body?: string }]>)
      .map((call) => JSON.parse(String(call[1]?.body)) as any)
      .find((payload) => !payload.generationConfig?.responseModalities?.includes("AUDIO"));
    const ttsRequest = (fetchMock.mock.calls as unknown as Array<[unknown, { body?: string }]>)
      .map((call) => JSON.parse(String(call[1]?.body)) as any)
      .find((payload) => payload.generationConfig?.responseModalities?.includes("AUDIO"));
    const transcriptPayload = JSON.parse(textRequest.contents[0].parts[0].text);

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.voiceConversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parentConversationId: "conversation-1",
        rootConversationId: "conversation-1",
        characterSnapshots: expect.arrayContaining([
          expect.objectContaining({ name: "Lina", voiceName: "Puck" }),
          expect.objectContaining({ name: "Captain Orlo", voiceName: "Sulafat" })
        ])
      })
    });
    expect(transcriptPayload.previousConversations[0].turns[0].text).toBe("Should we open the moon gate?");
    expect(ttsRequest.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs).toEqual([
      expect.objectContaining({ speaker: "Lina", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } }),
      expect.objectContaining({ speaker: "Captain Orlo", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Sulafat" } } })
    ]);
    await app.close();
  });

  it("rejects voice conversations without Gemini configuration", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/voice-conversations",
      payload: {
        prompt: "Create a scene.",
        characterIds: ["character-1", "character-2"]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("GEMINI_API_KEY");
    expect(mockPrisma.project.findUnique).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects voice conversations unless the project is complete and both characters are ready", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockPrisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: "Moon Gate",
      prompt: "A story.",
      status: "GENERATING",
      currentPlan: null
    });
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([
      readyCharacter({ id: "character-1", name: "Lina" }),
      readyCharacter({ id: "character-2", name: "Captain Orlo" })
    ]);
    const app = await buildApp();

    const incompleteProject = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/voice-conversations",
      payload: {
        prompt: "Create a scene.",
        characterIds: ["character-1", "character-2"]
      }
    });

    expect(incompleteProject.statusCode).toBe(409);
    mockPrisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      title: "Moon Gate",
      prompt: "A story.",
      status: "COMPLETE",
      currentPlan: null
    });
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([
      readyCharacter({ id: "character-1", name: "Lina" }),
      readyCharacter({ id: "character-2", name: "Captain Orlo", status: "BUILDING" })
    ]);

    const unreadyCharacter = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/voice-conversations",
      payload: {
        prompt: "Create a scene.",
        characterIds: ["character-1", "character-2"]
      }
    });

    expect(unreadyCharacter.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects voice conversations with duplicate, missing, or extra characters", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    const app = await buildApp();

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/voice-conversations",
      payload: {
        prompt: "Create a scene.",
        characterIds: ["character-1", "character-1"]
      }
    });
    const tooMany = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/voice-conversations",
      payload: {
        prompt: "Create a scene.",
        characterIds: ["character-1", "character-2", "character-3"]
      }
    });

    expect(duplicate.statusCode).toBe(400);
    expect(tooMany.statusCode).toBe(400);
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
