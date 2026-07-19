import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  GeminiLiveVoiceProvider,
  OpenAIRealtimeVoiceProvider,
  selectGeminiLiveVoice,
  selectOpenAIRealtimeVoice,
  voiceProviderOptions
} from "./voiceProviders.js";
import type { VoiceProfile } from "./generation/voiceCharacters.js";

const neutralProfile: VoiceProfile = {
  ageBand: "adult",
  genderPresentation: "unknown",
  energy: "medium",
  warmth: "medium",
  pace: "medium",
  formality: "balanced"
};

describe("voice providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selects OpenAI realtime voices from age and gender profile", () => {
    expect(selectOpenAIRealtimeVoice({ ...neutralProfile, genderPresentation: "feminine" })).toBe("shimmer");
    expect(selectOpenAIRealtimeVoice({ ...neutralProfile, genderPresentation: "masculine", warmth: "high" })).toBe("cedar");
    expect(selectOpenAIRealtimeVoice({ ...neutralProfile, ageBand: "elder", genderPresentation: "masculine" })).toBe("cedar");
    expect(selectOpenAIRealtimeVoice({ ...neutralProfile, ageBand: "child", genderPresentation: "unknown" })).toBe("alloy");
    expect(selectOpenAIRealtimeVoice(neutralProfile, "marin")).toBe("alloy");
  });

  it("reports configured voice providers with the configured default", () => {
    const config = loadConfig({
      OPENAI_API_KEY: "openai-key",
      GEMINI_API_KEY: "gemini-key",
      VOICE_CHAT_PROVIDER: "gemini_live",
      GEMINI_LIVE_MODEL: "gemini-3.1-flash-live-preview"
    } as NodeJS.ProcessEnv);

    expect(voiceProviderOptions(config)).toEqual([
      expect.objectContaining({
        id: "gemini_live",
        configured: true,
        default: true,
        transport: "gemini_live",
        model: "gemini-3.1-flash-live-preview"
      }),
      expect.objectContaining({
        id: "openai_realtime",
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
  });

  it("selects Gemini Live voices from age and gender profile", () => {
    expect(selectGeminiLiveVoice({ ...neutralProfile, genderPresentation: "feminine" })).toBe("Sulafat");
    expect(selectGeminiLiveVoice({ ...neutralProfile, genderPresentation: "masculine", warmth: "high" })).toBe("Achird");
    expect(selectGeminiLiveVoice({ ...neutralProfile, ageBand: "elder", genderPresentation: "masculine" })).toBe("Gacrux");
    expect(selectGeminiLiveVoice({ ...neutralProfile, ageBand: "child", genderPresentation: "unknown" })).toBe("Aoede");
    expect(selectGeminiLiveVoice(neutralProfile, "Puck")).toBe("Puck");
  });

  it("creates provider-neutral realtime sessions", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("answer-sdp", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIRealtimeVoiceProvider({
      apiKey: "test-key",
      model: "gpt-realtime-2",
      defaultVoice: "marin"
    });

    const response = await provider.createRealtimeSession({
      offerSdp: "offer-sdp",
      characterName: "Lina",
      instructions: "You are Lina.",
      voiceProfile: { ...neutralProfile, genderPresentation: "feminine" },
      reconnectContext: "User: Are you still there?\nAssistant: Yes, I was explaining the map."
    });

    expect(response).toMatchObject({
      type: "webrtc_sdp_answer",
      answerSdp: "answer-sdp",
      provider: "openai_realtime",
      model: "gpt-realtime-2",
      voiceId: "shimmer"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/calls",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer test-key" }
      })
    );
    const request = fetchMock.mock.calls.at(0)?.[1] as { body?: FormData } | undefined;
    const session = JSON.parse(String(request?.body?.get("session"))) as { instructions?: string };
    expect(session.instructions).toContain("same ongoing voice call");
    expect(session.instructions).toContain("User: Are you still there?");
  });

  it("creates manual OpenAI realtime sessions for group listeners", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("answer-sdp", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIRealtimeVoiceProvider({
      apiKey: "test-key",
      model: "gpt-realtime-2",
      defaultVoice: "alloy"
    });

    await provider.createRealtimeSession({
      offerSdp: "listener-offer",
      characterName: "Voice room listener",
      instructions: "You are a hidden listener.",
      voiceProfile: neutralProfile,
      manualTurnControl: true,
      outputAudio: false,
      sessionMode: "group_listener"
    });

    const request = fetchMock.mock.calls.at(0)?.[1] as { body?: FormData } | undefined;
    const session = JSON.parse(String(request?.body?.get("session"))) as {
      audio?: { output?: unknown; input?: { transcription?: unknown; turn_detection?: { create_response?: boolean } } };
    };
    expect(session.audio?.output).toBeUndefined();
    expect(session.audio?.input?.transcription).toEqual({ model: "gpt-4o-mini-transcribe" });
    expect(session.audio?.input?.turn_detection?.create_response).toBe(false);
  });

  it("creates OpenAI group character sessions without microphone input control", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("answer-sdp", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAIRealtimeVoiceProvider({
      apiKey: "test-key",
      model: "gpt-realtime-2",
      defaultVoice: "alloy"
    });

    await provider.createRealtimeSession({
      offerSdp: "participant-offer",
      characterName: "Lina",
      instructions: "You are Lina in a group room.",
      voiceProfile: neutralProfile,
      manualTurnControl: true,
      outputAudio: true,
      inputAudioTranscription: false,
      sessionMode: "group_character"
    });

    const request = fetchMock.mock.calls.at(0)?.[1] as { body?: FormData } | undefined;
    const session = JSON.parse(String(request?.body?.get("session"))) as {
      audio?: { output?: unknown; input?: unknown };
    };
    expect(session.audio?.output).toEqual({ voice: "alloy" });
    expect(session.audio?.input).toBeUndefined();
  });

  it("creates constrained Gemini Live token sessions", async () => {
    const createAuthToken = vi.fn(async (_params: Record<string, unknown>) => ({ name: "gemini-ephemeral-token" }));
    const provider = new GeminiLiveVoiceProvider({
      apiKey: "gemini-key",
      model: "gemini-3.1-flash-live-preview",
      defaultVoice: "Achird",
      createAuthToken,
      now: () => new Date("2026-06-09T10:00:00.000Z")
    });

    const response = await provider.createRealtimeSession({
      characterName: "Lina",
      instructions: "You are Lina.",
      voiceProfile: { ...neutralProfile, genderPresentation: "feminine" },
      reconnectContext: "User: Are you still there?",
      sessionHandle: "resume-handle"
    });

    expect(response).toMatchObject({
      type: "gemini_live_token",
      token: "gemini-ephemeral-token",
      provider: "gemini_live",
      model: "gemini-3.1-flash-live-preview",
      voiceId: "Sulafat",
      expiresAt: "2026-06-09T10:30:00.000Z",
      newSessionExpiresAt: "2026-06-09T10:01:00.000Z"
    });
    const params = createAuthToken.mock.calls[0]?.[0] as any;
    expect(params.config.uses).toBe(1);
    expect(params.config.liveConnectConstraints.model).toBe("gemini-3.1-flash-live-preview");
    expect(params.config.liveConnectConstraints.config.responseModalities).toEqual(["AUDIO"]);
    expect(params.config.liveConnectConstraints.config.systemInstruction).toContain("You are Lina.");
    expect(params.config.liveConnectConstraints.config.systemInstruction).toContain("same ongoing voice call");
    expect(params.config.liveConnectConstraints.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Sulafat");
    expect(params.config.liveConnectConstraints.config.sessionResumption.handle).toBe("resume-handle");
    expect(params.config.liveConnectConstraints.config.realtimeInputConfig).toEqual({
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
        prefixPaddingMs: 300
      }
    });
    expect(params.config.lockAdditionalFields).toContain("systemInstruction");
    expect(params.config.lockAdditionalFields).toContain("realtimeInputConfig");
  });

  it("creates Gemini Live sessions with manual input control for group characters", async () => {
    const createAuthToken = vi.fn(async (_params: Record<string, unknown>) => ({ name: "gemini-ephemeral-token" }));
    const provider = new GeminiLiveVoiceProvider({
      apiKey: "gemini-key",
      model: "gemini-3.1-flash-live-preview",
      defaultVoice: "Achird",
      createAuthToken
    });

    await provider.createRealtimeSession({
      characterName: "Lina",
      instructions: "You are Lina in a group room.",
      voiceProfile: neutralProfile,
      manualTurnControl: true,
      sessionMode: "group_character"
    });

    const params = createAuthToken.mock.calls[0]?.[0] as any;
    expect(params.config.liveConnectConstraints.config.realtimeInputConfig).toEqual({
      automaticActivityDetection: {
        disabled: true
      }
    });
    expect(params.config.lockAdditionalFields).toContain("realtimeInputConfig");
  });

  it("fails clearly when Gemini Live is not configured", async () => {
    const provider = new GeminiLiveVoiceProvider({
      apiKey: undefined,
      model: "gemini-3.1-flash-live-preview",
      defaultVoice: "Achird"
    });

    await expect(
      provider.createRealtimeSession({
        characterName: "Lina",
        instructions: "You are Lina.",
        voiceProfile: neutralProfile
      })
    ).rejects.toThrow("GEMINI_API_KEY is required");
  });
});
