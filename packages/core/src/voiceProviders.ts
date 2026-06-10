import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "./config.js";
import type { VoiceProfile } from "./generation/voiceCharacters.js";

export type VoiceChatProviderId = "openai_realtime" | "gemini_live";
export type VoiceTransport = "webrtc_sdp" | "gemini_live";

export type VoiceProviderCapabilities = {
  realtime: boolean;
  transports: VoiceTransport[];
  configurableVoiceProfile: boolean;
};

export type VoiceProviderOption = {
  id: VoiceChatProviderId;
  label: string;
  configured: boolean;
  default: boolean;
  transport: VoiceTransport;
  model: string;
  modelOptions: VoiceModelOption[];
};

export type VoiceModelOption = {
  model: string;
  label: string;
  default: boolean;
  description?: string;
};

export type VoiceSelection = {
  provider: VoiceChatProviderId;
  model: string;
  voiceId: string;
  instructions: string;
  metadata: Record<string, unknown>;
};

export type CreateRealtimeSessionRequest = {
  characterName: string;
  instructions: string;
  voiceProfile: VoiceProfile;
  voiceModel?: string | undefined;
  voiceId?: string | undefined;
  reconnectContext?: string | undefined;
  providerMetadata?: Record<string, unknown> | undefined;
  manualTurnControl?: boolean | undefined;
  outputAudio?: boolean | undefined;
  inputAudioTranscription?: boolean | undefined;
  sessionMode?: "single" | "group_character" | "group_listener" | undefined;
};

export type CreateOpenAIRealtimeSessionRequest = CreateRealtimeSessionRequest & {
  offerSdp: string;
};

export type CreateGeminiLiveSessionRequest = CreateRealtimeSessionRequest & {
  sessionHandle?: string | undefined;
};

export type OpenAIRealtimeSessionResponse = {
  type: "webrtc_sdp_answer";
  answerSdp: string;
  provider: "openai_realtime";
  model: string;
  voiceId: string;
  metadata: Record<string, unknown>;
};

export type GeminiLiveSessionResponse = {
  type: "gemini_live_token";
  token: string;
  expiresAt: string;
  newSessionExpiresAt: string;
  provider: "gemini_live";
  model: string;
  voiceId: string;
  metadata: Record<string, unknown>;
};

export type RealtimeSessionResponse = OpenAIRealtimeSessionResponse | GeminiLiveSessionResponse;

export interface VoiceChatProvider {
  readonly id: VoiceChatProviderId;
  readonly capabilities: VoiceProviderCapabilities;
  selectVoice(profile: VoiceProfile): VoiceSelection;
  createRealtimeSession(request: CreateOpenAIRealtimeSessionRequest | CreateGeminiLiveSessionRequest): Promise<RealtimeSessionResponse>;
}

export function voiceProviderOptions(config: AppConfig): VoiceProviderOption[] {
  const defaultProvider = config.VOICE_CHAT_PROVIDER;
  return [
    {
      id: "gemini_live",
      label: "Gemini Live",
      configured: Boolean(config.GEMINI_API_KEY?.trim()),
      default: defaultProvider === "gemini_live",
      transport: "gemini_live",
      model: config.GEMINI_LIVE_MODEL,
      modelOptions: [
        {
          model: config.GEMINI_LIVE_MODEL,
          label: config.GEMINI_LIVE_MODEL,
          default: true
        }
      ]
    },
    {
      id: "openai_realtime",
      label: "OpenAI Realtime",
      configured: Boolean(config.OPENAI_API_KEY?.trim()),
      default: defaultProvider === "openai_realtime",
      transport: "webrtc_sdp",
      model: config.OPENAI_REALTIME_MODEL,
      modelOptions: openAIRealtimeModelOptions(config.OPENAI_REALTIME_MODEL)
    }
  ];
}

function openAIRealtimeModelOptions(configuredModel: string): VoiceModelOption[] {
  const configured = configuredModel.trim() || "gpt-realtime-2";
  const options: VoiceModelOption[] = [
    {
      model: "gpt-realtime-2",
      label: "GPT-Realtime-2",
      default: configured === "gpt-realtime-2",
      description: "Most capable realtime voice model."
    },
    {
      model: "gpt-realtime-mini",
      label: "GPT-Realtime mini",
      default: configured === "gpt-realtime-mini",
      description: "Lower-cost realtime voice model."
    }
  ];

  if (!options.some((option) => option.model === configured)) {
    options.unshift({
      model: configured,
      label: configured,
      default: true,
      description: "Configured OpenAI realtime model."
    });
  }

  const firstOption = options[0];
  if (firstOption && !options.some((option) => option.default)) {
    options[0] = { ...firstOption, default: true };
  }

  return options;
}

export function createVoiceProvider(config: AppConfig, providerId: VoiceChatProviderId = config.VOICE_CHAT_PROVIDER): VoiceChatProvider {
  if (providerId === "openai_realtime") {
    return new OpenAIRealtimeVoiceProvider({
      apiKey: config.OPENAI_API_KEY,
      model: config.OPENAI_REALTIME_MODEL,
      defaultVoice: config.OPENAI_REALTIME_VOICE
    });
  }
  if (providerId === "gemini_live") {
    return new GeminiLiveVoiceProvider({
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_LIVE_MODEL,
      defaultVoice: config.GEMINI_LIVE_VOICE
    });
  }
  throw new Error(`Unsupported VOICE_CHAT_PROVIDER: ${String(providerId)}`);
}

export class OpenAIRealtimeVoiceProvider implements VoiceChatProvider {
  readonly id = "openai_realtime" as const;
  readonly capabilities: VoiceProviderCapabilities = {
    realtime: true,
    transports: ["webrtc_sdp"],
    configurableVoiceProfile: true
  };

  constructor(
    private readonly options: {
      apiKey: string | undefined;
      model: string;
      defaultVoice: string;
    }
  ) {}

  selectVoice(profile: VoiceProfile): VoiceSelection {
    const voiceId = selectOpenAIRealtimeVoice(profile, this.options.defaultVoice);
    return {
      provider: this.id,
      model: this.options.model,
      voiceId,
      instructions: voiceDirectionForProfile(profile),
      metadata: {
        selectedBy: "voice_profile_v1",
        profile
      }
    };
  }

  async createRealtimeSession(request: CreateOpenAIRealtimeSessionRequest | CreateGeminiLiveSessionRequest): Promise<OpenAIRealtimeSessionResponse> {
    if (!("offerSdp" in request) || !request.offerSdp) {
      throw new Error("OpenAI Realtime voice calls require a WebRTC offer SDP.");
    }
    if (!this.options.apiKey) {
      throw new Error("OPENAI_API_KEY is required for OpenAI Realtime voice calls.");
    }

    const selected = request.voiceId
      ? {
          provider: this.id,
          model: request.voiceModel ?? this.options.model,
          voiceId: request.voiceId,
          instructions: voiceDirectionForProfile(request.voiceProfile),
          metadata: request.providerMetadata ?? {}
        }
      : this.selectVoice(request.voiceProfile);
    const model = request.voiceModel ?? selected.model;
    const reconnectInstructions = buildReconnectInstructions(request.reconnectContext);
    const session = JSON.stringify({
      type: "realtime",
      model,
      instructions: [request.instructions, reconnectInstructions, selected.instructions].filter(Boolean).join("\n\n"),
      audio: openAIRealtimeAudioConfig(request, selected.voiceId)
    });

    const formData = new FormData();
    formData.set("sdp", request.offerSdp);
    formData.set("session", session);

    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`
      },
      body: formData
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI Realtime call failed (${response.status}): ${text.slice(0, 500)}`);
    }

    return {
      type: "webrtc_sdp_answer",
      answerSdp: text,
      provider: this.id,
      model,
      voiceId: selected.voiceId,
      metadata: {
        ...selected.metadata,
        transport: "webrtc_sdp"
      }
    };
  }
}

export type GeminiAuthTokenFactory = (params: Record<string, unknown>) => Promise<{ name?: string }>;

export class GeminiLiveVoiceProvider implements VoiceChatProvider {
  readonly id = "gemini_live" as const;
  readonly capabilities: VoiceProviderCapabilities = {
    realtime: true,
    transports: ["gemini_live"],
    configurableVoiceProfile: true
  };

  constructor(
    private readonly options: {
      apiKey: string | undefined;
      model: string;
      defaultVoice: string;
      createAuthToken?: GeminiAuthTokenFactory | undefined;
      now?: (() => Date) | undefined;
    }
  ) {}

  selectVoice(profile: VoiceProfile): VoiceSelection {
    const voiceId = selectGeminiLiveVoice(profile, this.options.defaultVoice);
    return {
      provider: this.id,
      model: this.options.model,
      voiceId,
      instructions: voiceDirectionForProfile(profile),
      metadata: {
        selectedBy: "voice_profile_v1",
        profile
      }
    };
  }

  async createRealtimeSession(request: CreateOpenAIRealtimeSessionRequest | CreateGeminiLiveSessionRequest): Promise<GeminiLiveSessionResponse> {
    if (!this.options.apiKey) {
      throw new Error("GEMINI_API_KEY is required for Gemini Live voice calls.");
    }

    const selected = request.voiceId
      ? {
          provider: this.id,
          model: request.voiceModel ?? this.options.model,
          voiceId: request.voiceId,
          instructions: voiceDirectionForProfile(request.voiceProfile),
          metadata: request.providerMetadata ?? {}
        }
      : this.selectVoice(request.voiceProfile);
    const model = request.voiceModel ?? selected.model;
    const reconnectInstructions = buildReconnectInstructions(request.reconnectContext);
    const instructions = [request.instructions, reconnectInstructions, selected.instructions].filter(Boolean).join("\n\n");
    const now = this.options.now?.() ?? new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    const newSessionExpiresAt = new Date(now.getTime() + 60 * 1000).toISOString();
    const sessionHandle = "sessionHandle" in request ? request.sessionHandle?.trim() : undefined;
    const token = await this.createAuthToken({
      config: {
        uses: 1,
        expireTime: expiresAt,
        newSessionExpireTime: newSessionExpiresAt,
        liveConnectConstraints: {
          model,
          config: {
            responseModalities: ["AUDIO"],
            systemInstruction: instructions,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: selected.voiceId
                }
              }
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            ...geminiRealtimeInputConfig(request),
            sessionResumption: sessionHandle ? { handle: sessionHandle } : {},
            contextWindowCompression: {
              triggerTokens: "24000",
              slidingWindow: {
                targetTokens: "12000"
              }
            }
          }
        },
        lockAdditionalFields: [
          "responseModalities",
          "systemInstruction",
          "speechConfig",
          "inputAudioTranscription",
          "outputAudioTranscription",
          ...(request.manualTurnControl ? ["realtimeInputConfig"] : []),
          "sessionResumption",
          "contextWindowCompression"
        ]
      }
    });
    if (!token.name) {
      throw new Error("Gemini Live did not return an ephemeral token.");
    }

    return {
      type: "gemini_live_token",
      token: token.name,
      expiresAt,
      newSessionExpiresAt,
      provider: this.id,
      model,
      voiceId: selected.voiceId,
      metadata: {
        ...selected.metadata,
        transport: "gemini_live",
        sessionResumption: true
      }
    };
  }

  private async createAuthToken(params: Record<string, unknown>): Promise<{ name?: string }> {
    if (this.options.createAuthToken) {
      return this.options.createAuthToken(params);
    }
    const apiKey = this.options.apiKey;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required for Gemini Live voice calls.");
    }
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: "v1alpha" }
    });
    return ai.authTokens.create(params as never);
  }
}

function buildReconnectInstructions(reconnectContext?: string): string {
  const trimmed = reconnectContext?.trim();
  if (!trimmed) {
    return "";
  }
  return [
    "This is a reconnection to the same ongoing voice call after the line dropped.",
    "Continue naturally from the prior conversation. Do not introduce yourself again or restart the chat unless the user asks.",
    "Recent conversation before reconnect:",
    trimmed
  ].join("\n");
}

function openAIRealtimeAudioConfig(request: CreateRealtimeSessionRequest, voiceId: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (request.inputAudioTranscription !== false) {
    input.transcription = { model: "gpt-4o-mini-transcribe" };
  }
  if (request.manualTurnControl && request.sessionMode !== "group_character") {
    input.turn_detection = {
      type: "server_vad",
      create_response: false,
      interrupt_response: true
    };
  }
  const audio: Record<string, unknown> = Object.keys(input).length ? { input } : {};
  if (request.outputAudio !== false) {
    audio.output = { voice: voiceId };
  }
  return audio;
}

function geminiRealtimeInputConfig(request: CreateRealtimeSessionRequest): Record<string, unknown> {
  if (!request.manualTurnControl) {
    return {};
  }
  return {
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: request.sessionMode === "group_character"
      }
    }
  };
}

const NEUTRAL_REALTIME_VOICE = "alloy";
const NEUTRAL_GEMINI_LIVE_VOICE = "Achird";

export function selectOpenAIRealtimeVoice(profile: VoiceProfile, fallback = NEUTRAL_REALTIME_VOICE): string {
  if (profile.ageBand === "elder") {
    if (profile.genderPresentation === "masculine") {
      return "cedar";
    }
    if (profile.genderPresentation === "feminine") {
      return "sage";
    }
    return NEUTRAL_REALTIME_VOICE;
  }
  if (profile.ageBand === "child" || profile.ageBand === "teen") {
    if (profile.genderPresentation === "masculine") {
      return "verse";
    }
    if (profile.genderPresentation === "feminine") {
      return "shimmer";
    }
    return NEUTRAL_REALTIME_VOICE;
  }
  if (profile.genderPresentation === "feminine") {
    return profile.energy === "high" ? "coral" : "shimmer";
  }
  if (profile.genderPresentation === "masculine") {
    return profile.warmth === "high" ? "cedar" : "echo";
  }
  if (profile.genderPresentation === "neutral" || profile.genderPresentation === "unknown") {
    return NEUTRAL_REALTIME_VOICE;
  }
  return fallback || NEUTRAL_REALTIME_VOICE;
}

export function selectGeminiLiveVoice(profile: VoiceProfile, fallback = NEUTRAL_GEMINI_LIVE_VOICE): string {
  if (profile.ageBand === "child" || profile.ageBand === "teen") {
    if (profile.genderPresentation === "feminine") {
      return "Leda";
    }
    if (profile.genderPresentation === "masculine") {
      return "Puck";
    }
    return "Aoede";
  }
  if (profile.ageBand === "elder") {
    if (profile.genderPresentation === "feminine") {
      return "Sulafat";
    }
    if (profile.genderPresentation === "masculine") {
      return "Gacrux";
    }
    return "Schedar";
  }
  if (profile.genderPresentation === "feminine") {
    return profile.energy === "high" ? "Kore" : "Sulafat";
  }
  if (profile.genderPresentation === "masculine") {
    return profile.warmth === "high" ? "Achird" : "Charon";
  }
  if (profile.genderPresentation === "neutral" || profile.genderPresentation === "unknown") {
    return fallback || NEUTRAL_GEMINI_LIVE_VOICE;
  }
  return fallback || NEUTRAL_GEMINI_LIVE_VOICE;
}

function voiceDirectionForProfile(profile: VoiceProfile): string {
  const gender =
    profile.genderPresentation === "unknown"
      ? "neutral gender presentation"
      : `${profile.genderPresentation} gender presentation`;
  const age =
    profile.ageBand === "young_adult"
      ? "young adult"
      : profile.ageBand;
  return [
    "Voice direction:",
    `Sound like a ${age} fictional character with ${gender}.`,
    `Energy: ${profile.energy}. Warmth: ${profile.warmth}. Pace: ${profile.pace}. Formality: ${profile.formality}.`,
    profile.accentNotes ? `Accent or dialect note, only if natural and respectful: ${profile.accentNotes}.` : "",
    "Do not imitate any real person or celebrity."
  ]
    .filter(Boolean)
    .join(" ");
}
