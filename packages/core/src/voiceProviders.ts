import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "./config.js";
import type { VoiceProfile } from "./generation/voiceCharacters.js";
import { VOICE_CALL_POLICY } from "./voiceCallMetering.js";

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
    const expiresAt = new Date(now.getTime() + GEMINI_LIVE_TOKEN_LIFETIME_MS).toISOString();
    const newSessionExpiresAt = new Date(now.getTime() + GEMINI_LIVE_NEW_SESSION_WINDOW_MS).toISOString();
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
            contextWindowCompression: geminiLiveContextCompression(instructions)
          }
        },
        lockAdditionalFields: [
          "responseModalities",
          "systemInstruction",
          "speechConfig",
          "inputAudioTranscription",
          "outputAudioTranscription",
          "realtimeInputConfig",
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

/** How long after the mint the relay may open its first provider connection. */
const GEMINI_LIVE_NEW_SESSION_WINDOW_MS = 60 * 1000;

/**
 * How long the token keeps a call's provider session usable, resumptions
 * included (Google's ephemeral-token page: the ~10-minute connection resets are
 * resumed "with the same token even if `uses: 1`" until `expireTime`). The
 * window to open, the length cap, and a minute for the handshake and the first
 * lease, so the relay's funded deadline always comes first and Google's expiry
 * is only the backstop. It was a flat 30 minutes, which was the cap when the cap
 * was 30.
 */
const GEMINI_LIVE_TOKEN_LIFETIME_MS =
  GEMINI_LIVE_NEW_SESSION_WINDOW_MS + VOICE_CALL_POLICY.maxCallMinutes * 60 * 1000 + 60 * 1000;

/**
 * In-call context compaction, counted from the top of the system instruction.
 *
 * Gemini Live bills every turn for the whole context window: the system
 * instruction as text, and the conversation so far as audio, which piles up at
 * about 25 tokens a second (Google's Live API best practices). So what a minute
 * costs is decided almost entirely by how much conversation the window may hold.
 * The sliding window drops the oldest turns once the context passes
 * `triggerTokens`, down to `targetTokens`, and always keeps the system
 * instruction (API reference, `SlidingWindow`).
 *
 * Both of those numbers count the instruction, and it runs from about 1,500
 * tokens on a first call to about 7,000 for a returning caller with a long
 * persona, a large cast and the 12,000 characters of remembered talk
 * `voiceCallHistory.ts` allows. A fixed pair therefore either keeps minutes of
 * audio behind a short instruction or none behind a long one: the 12k/6k the
 * launch review suggested would have compacted a 7,000-token caller to its last
 * turn. So the pair is set per call, above the instruction's estimated size.
 *
 * Modelled at full talk (30 s each way a minute, 8 turns), a 15-minute call costs
 * $0.14–0.17 a minute across that instruction range, against $0.25–0.29 with the
 * old fixed 24k/12k; revenue at the cheapest credit is $0.25 (120 × $0.00212).
 * Unmeasured: the Operations tab's `VOICE_CALL_MINUTE` is where to check.
 */
export const GEMINI_LIVE_CONTEXT_COMPACTION = {
  /** Conversation above the instruction that starts a compaction: about 5 minutes of two-way talk. */
  conversationTriggerTokens: 8_000,
  /** Conversation kept after one: the last 2 minutes or so, about 15 turns. */
  conversationTargetTokens: 3_000
} as const;

/**
 * About four characters a token for ASCII, three for the other alphabetic
 * scripts (Persian, Arabic, Hebrew, Cyrillic, Devanagari, Thai), and one for
 * CJK and Hangul. An estimate on purpose — counting exactly would put a
 * tokenizer call in front of every call's token mint. It errs high rather than
 * low: high costs a little more conversation kept, low costs the conversation.
 * Not UTF-8 bytes / 4: that counts a Persian letter, two bytes, as half a token,
 * half again too many, and modelled a Persian caller's 15 minutes past the
 * margin this pair exists to keep.
 */
export function estimateInstructionTokens(text: string): number {
  let ascii = 0;
  let ideographic = 0;
  let other = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) ascii += 1;
    else if (isIdeographicScript(code)) ideographic += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other / 3 + ideographic);
}

/** CJK radicals through unified ideographs (kana included), Hangul, compatibility forms, full-width forms, and the supplementary planes. */
function isIdeographicScript(code: number): boolean {
  return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) || code >= 0x20000;
}

export function geminiLiveContextCompression(systemInstruction: string): {
  triggerTokens: string;
  slidingWindow: { targetTokens: string };
} {
  const instructionTokens = estimateInstructionTokens(systemInstruction);
  return {
    triggerTokens: String(instructionTokens + GEMINI_LIVE_CONTEXT_COMPACTION.conversationTriggerTokens),
    slidingWindow: {
      targetTokens: String(instructionTokens + GEMINI_LIVE_CONTEXT_COMPACTION.conversationTargetTokens)
    }
  };
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
  if (request.manualTurnControl && request.sessionMode === "group_character") {
    return {
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: true
        }
      }
    };
  }
  // Speaker echo that leaks past browser echo cancellation can trip Gemini's
  // voice activity detection and cut character audio off mid-turn, so barge-in
  // requires a clear, sustained speech onset.
  return {
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
        prefixPaddingMs: 300
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
