import { z } from "zod";
import type { VoiceProfile } from "./generation/voiceCharacters.js";

export type VoiceConversationSpeaker = {
  id: string;
  name: string;
  role?: string | null | undefined;
  description?: string | null | undefined;
  traits?: string[] | undefined;
  persona?: Record<string, unknown> | null | undefined;
  voiceProfile: VoiceProfile;
  voiceName?: string | null | undefined;
  temporary?: boolean | undefined;
};

export type VoiceConversationTurn = {
  speakerId: string;
  speakerName: string;
  text: string;
};

export type VoiceConversationTranscript = {
  title?: string | undefined;
  temporaryCharacters?: VoiceConversationTemporaryCharacter[] | undefined;
  turns: VoiceConversationTurn[];
};

export type VoiceConversationHistoryItem = {
  prompt: string;
  transcript: VoiceConversationTranscript;
};

export type VoiceConversationCharacterSnapshot = {
  id: string;
  name: string;
  role?: string | null | undefined;
  description?: string | null | undefined;
  voiceName: string;
  temporary?: boolean | undefined;
};

export type VoiceConversationTemporaryCharacter = {
  id: string;
  name: string;
  role?: string | null | undefined;
  description?: string | null | undefined;
  voiceName: string;
};

export type GeminiTtsSynthesisResult = {
  audio: Buffer;
  mimeType: "audio/wav";
  provider: "gemini_tts";
  model: string;
  durationMs: number | null;
  metadata: Record<string, unknown>;
};

const rawVoiceConversationTurnSchema = z.object({
  speaker: z.string().optional(),
  speakerName: z.string().optional(),
  text: z.string().min(1)
});

const rawTemporaryVoiceConversationCharacterSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  speakerName: z.string().trim().min(1).max(80).optional(),
  role: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(600).optional()
});

const rawVoiceConversationTranscriptSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  temporaryCharacters: z.array(rawTemporaryVoiceConversationCharacterSchema).max(2).optional(),
  temporarySpeakers: z.array(rawTemporaryVoiceConversationCharacterSchema).max(2).optional(),
  turns: z.array(rawVoiceConversationTurnSchema).min(4).max(18)
});

type RawTemporaryVoiceConversationCharacter = z.infer<typeof rawTemporaryVoiceConversationCharacterSchema>;
type VoiceConversationSpeakerReference = Pick<VoiceConversationSpeaker, "id" | "name"> &
  Partial<Pick<VoiceConversationSpeaker, "role" | "description" | "voiceName" | "voiceProfile" | "temporary">>;

const GEMINI_TTS_API_VERSION = "v1beta";
const DEFAULT_TTS_SAMPLE_RATE = 24000;
const DEFAULT_TTS_CHANNELS = 1;
const DEFAULT_TTS_SAMPLE_WIDTH = 2;
const VOICE_CONVERSATION_TRANSCRIPT_MAX_OUTPUT_TOKENS = 4096;
const MAX_VOICE_CONVERSATION_SPEAKERS = 4;
const MAX_TEMPORARY_VOICE_CONVERSATION_SPEAKERS = 2;
const TURN_SILENCE_MS = 180;

const DEFAULT_TEMPORARY_VOICE_PROFILE: VoiceProfile = {
  ageBand: "adult",
  genderPresentation: "unknown",
  energy: "medium",
  warmth: "medium",
  pace: "medium",
  formality: "balanced"
};

export const GEMINI_TTS_SUPPORTED_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat"
] as const;

export type GeminiTtsVoiceName = (typeof GEMINI_TTS_SUPPORTED_VOICES)[number];

export async function generateGeminiVoiceConversationTranscript(options: {
  apiKey: string | undefined;
  model: string;
  project: {
    title: string;
    prompt: string;
    plan?: unknown;
  };
  userPrompt: string;
  speakers: VoiceConversationSpeaker[];
  previousConversations?: VoiceConversationHistoryItem[] | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<VoiceConversationTranscript> {
  if (!options.apiKey) {
    throw new Error("GEMINI_API_KEY is required for scripted voice conversations.");
  }
  if (options.speakers.length < 2 || options.speakers.length > MAX_VOICE_CONVERSATION_SPEAKERS) {
    throw new Error("Scripted voice conversations require 2-4 speakers.");
  }

  const response = await postGeminiGenerateContent(
    options.apiKey,
    options.model,
    {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: JSON.stringify({
                book: {
                  title: options.project.title,
                  prompt: options.project.prompt,
                  plan: compactPlanForTranscript(options.project.plan)
                },
                scenePrompt: options.userPrompt,
                previousConversations: compactVoiceConversationHistory(options.previousConversations),
                speakers: options.speakers.map((speaker) => ({
                  name: speaker.name,
                  role: speaker.role,
                  description: speaker.description,
                  traits: speaker.traits ?? [],
                  persona: compactPersonaForTranscript(speaker.persona),
                  temporary: speaker.temporary === true
                }))
              })
            }
          ]
        }
      ],
      systemInstruction: {
        parts: [
          {
            text: [
              "Write a short scripted voice conversation between fictional book characters.",
              options.previousConversations?.length
                ? "This is a continuation. Use the prior transcripts as canon, continue naturally from the latest scene, and do not reintroduce the characters."
                : "This is the first scene in this scripted voice conversation.",
              "Return one JSON object with title, optional temporaryCharacters, and turns.",
              "Each turn must have speakerName and text.",
              `Existing speaker names: ${options.speakers.map((speaker) => speaker.name).join(", ")}.`,
              "Use existing speakers by default.",
              "If the scene prompt explicitly introduces, names, or asks for another fictional character who needs spoken lines, add them to temporaryCharacters and give them turns.",
              "Do not invent temporaryCharacters for background mentions, crowds, narration, or unnamed roles.",
              "Use at most two temporaryCharacters. Each temporaryCharacters item must have name, role, and description.",
              "Every turn speakerName must exactly match either an existing speaker name or a temporaryCharacters name.",
              "Use 8-12 turns total and target a 60-120 second performance.",
              "Keep each turn concise, usually under 220 characters.",
              "Make it cool, natural, cinematic, and podcast-like without becoming generic hosts.",
              "Keep the characters in first person, let them respond to each other, and include light banter when appropriate.",
              "Use sparse English audio tags only when they improve performance, such as [pause], [laughs softly], [curious], or [quietly].",
              "Do not mention AI, prompts, apps, generated audio, transcripts, or production instructions.",
              "Do not narrate actions outside the dialogue."
            ].join(" ")
          }
        ]
      },
      generationConfig: {
        temperature: 0.75,
        maxOutputTokens: VOICE_CONVERSATION_TRANSCRIPT_MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json"
      }
    },
    options.fetchImpl
  );

  return normalizeVoiceConversationTranscript(parseGeminiJsonText(response), options.speakers, {
    allowTemporarySpeakers: true
  });
}

export type NormalizeVoiceConversationTranscriptOptions = {
  allowTemporarySpeakers?: boolean | undefined;
  maxTemporarySpeakers?: number | undefined;
};

export function normalizeVoiceConversationTranscript(
  value: unknown,
  speakers: VoiceConversationSpeakerReference[],
  options: NormalizeVoiceConversationTranscriptOptions = {}
): VoiceConversationTranscript {
  const allowTemporarySpeakers = options.allowTemporarySpeakers === true;
  if (!allowTemporarySpeakers && speakers.length !== 2) {
    throw new Error("Voice conversation transcripts require exactly 2 known speakers.");
  }
  if (allowTemporarySpeakers && (speakers.length < 2 || speakers.length > MAX_VOICE_CONVERSATION_SPEAKERS)) {
    throw new Error("Voice conversation transcripts require 2-4 speakers.");
  }
  const parsed = rawVoiceConversationTranscriptSchema.parse(value);
  const speakersByName = new Map(speakers.map((speaker) => [normalizeSpeakerKey(speaker.name), speaker]));
  const declaredTemporaryCharacters = temporaryCharactersFromTranscript(parsed);
  const temporarySpeakerByName = new Map<string, VoiceConversationSpeaker>();
  const maxTemporarySpeakers = Math.max(
    0,
    Math.min(options.maxTemporarySpeakers ?? MAX_TEMPORARY_VOICE_CONVERSATION_SPEAKERS, MAX_TEMPORARY_VOICE_CONVERSATION_SPEAKERS)
  );

  for (const speaker of speakers) {
    if (speaker.temporary) {
      temporarySpeakerByName.set(normalizeSpeakerKey(speaker.name), speakerWithDefaults(speaker));
    }
  }

  const turns = parsed.turns.map((turn) => {
    const rawName = (turn.speakerName ?? turn.speaker ?? "").trim();
    const speaker =
      speakersByName.get(normalizeSpeakerKey(rawName)) ??
      resolveTemporaryVoiceConversationSpeaker({
        rawName,
        speakers,
        declaredTemporaryCharacters,
        temporarySpeakerByName,
        allowTemporarySpeakers,
        maxTemporarySpeakers
      });
    if (!speaker) {
      throw new Error(`Voice conversation transcript used an unknown speaker: ${rawName || "(missing)"}`);
    }
    const text = cleanVoiceConversationLine(turn.text, speaker.name);
    if (!text) {
      throw new Error(`Voice conversation transcript has an empty turn for ${speaker.name}.`);
    }
    return {
      speakerId: speaker.id,
      speakerName: speaker.name,
      text
    };
  });

  const usedSpeakerIds = new Set(turns.map((turn) => turn.speakerId));
  if (!allowTemporarySpeakers && usedSpeakerIds.size !== 2) {
    throw new Error("Voice conversation transcript must include both selected speakers.");
  }
  if (allowTemporarySpeakers && usedSpeakerIds.size < 2) {
    throw new Error("Voice conversation transcript must include at least two speakers.");
  }
  const hasRequiredKnownSpeaker =
    !allowTemporarySpeakers ||
    !speakers.some((speaker) => !speaker.temporary) ||
    speakers.some((speaker) => !speaker.temporary && usedSpeakerIds.has(speaker.id));
  if (!hasRequiredKnownSpeaker) {
    throw new Error("Voice conversation transcript must include at least one selected speaker.");
  }
  if (allowTemporarySpeakers && !turns.some((turn) => turn.speakerId.startsWith("temporary:")) && speakers.length === 2 && usedSpeakerIds.size !== 2) {
    throw new Error("Voice conversation transcript must include both selected speakers.");
  }

  const temporaryCharacters = voiceConversationTemporaryCharactersForTurns(speakers, temporarySpeakerByName, usedSpeakerIds);

  return {
    ...(parsed.title ? { title: parsed.title } : {}),
    ...(temporaryCharacters.length ? { temporaryCharacters } : {}),
    turns
  };
}

export async function synthesizeGeminiTtsConversation(options: {
  apiKey: string | undefined;
  model: string;
  transcript: VoiceConversationTranscript;
  speakers: VoiceConversationSpeaker[];
  fetchImpl?: typeof fetch | undefined;
}): Promise<GeminiTtsSynthesisResult> {
  if (!options.apiKey) {
    throw new Error("GEMINI_API_KEY is required for Gemini TTS voice conversations.");
  }
  const transcriptSpeakers = voiceConversationSpeakersForTranscript(options.speakers, options.transcript);
  if (transcriptSpeakers.length < 2) {
    throw new Error("Gemini TTS voice conversations require at least 2 speakers.");
  }
  if (transcriptSpeakers.length > 2) {
    return synthesizeGeminiTtsConversationByTurn({
      apiKey: options.apiKey,
      model: options.model,
      transcript: options.transcript,
      speakers: transcriptSpeakers,
      fetchImpl: options.fetchImpl
    });
  }

  const speakerVoiceConfigs = geminiTtsSpeakerVoiceConfigs(transcriptSpeakers);
  const sourceTranscript = voiceConversationTranscriptToText(options.transcript);
  const response = await postGeminiGenerateContent(
    options.apiKey,
    options.model,
    {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "Perform this exact transcript as a natural, cinematic two-character audio conversation.",
                "Preserve the speaker labels and spoken words exactly.",
                "Keep it lively, close-mic, warm, and believable, with expressive pacing but no exaggerated announcer voice.",
                "Honor bracketed delivery tags as performance direction, not spoken words.",
                "",
                sourceTranscript
              ].join("\n")
            }
          ]
        }
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs
          }
        }
      }
    },
    options.fetchImpl
  );

  const inlineAudio = extractGeminiInlineAudio(response);
  const audio = wavFromGeminiInlineAudio(inlineAudio);

  return {
    audio,
    mimeType: "audio/wav",
    provider: "gemini_tts",
    model: options.model,
    durationMs: wavDurationMs(audio),
    metadata: {
      sourceMimeType: inlineAudio.mimeType,
      voices: Object.fromEntries(speakerVoiceConfigs.map((config) => [config.speaker, config.voiceConfig.prebuiltVoiceConfig.voiceName]))
    }
  };
}

export function voiceConversationSpeakersForTranscript(
  speakers: VoiceConversationSpeaker[],
  transcript: VoiceConversationTranscript
): VoiceConversationSpeaker[] {
  const baseSpeakersById = new Map(speakers.map((speaker) => [speaker.id, speaker]));
  const baseSpeakersByName = new Map(speakers.map((speaker) => [normalizeSpeakerKey(speaker.name), speaker]));
  const temporarySpeakersById = new Map(
    (transcript.temporaryCharacters ?? []).map((character) => [
      character.id,
      voiceConversationSpeakerFromTemporaryCharacter(character)
    ])
  );
  const used: VoiceConversationSpeaker[] = [];
  const usedIds = new Set<string>();

  for (const turn of transcript.turns) {
    const speaker =
      baseSpeakersById.get(turn.speakerId) ??
      temporarySpeakersById.get(turn.speakerId) ??
      baseSpeakersByName.get(normalizeSpeakerKey(turn.speakerName));
    if (!speaker || usedIds.has(speaker.id)) {
      continue;
    }
    usedIds.add(speaker.id);
    used.push(speaker);
  }

  return used;
}

async function synthesizeGeminiTtsConversationByTurn(options: {
  apiKey: string;
  model: string;
  transcript: VoiceConversationTranscript;
  speakers: VoiceConversationSpeaker[];
  fetchImpl?: typeof fetch | undefined;
}): Promise<GeminiTtsSynthesisResult> {
  const speakersById = new Map(options.speakers.map((speaker) => [speaker.id, speaker]));
  const speakersByName = new Map(options.speakers.map((speaker) => [normalizeSpeakerKey(speaker.name), speaker]));
  const chunks: Pcm16AudioChunk[] = [];

  for (const [index, turn] of options.transcript.turns.entries()) {
    const speaker = speakersById.get(turn.speakerId) ?? speakersByName.get(normalizeSpeakerKey(turn.speakerName));
    if (!speaker) {
      throw new Error(`Gemini TTS transcript used an unknown speaker: ${turn.speakerName || "(missing)"}`);
    }
    const voiceName = normalizeGeminiTtsVoiceName(speaker.voiceName) ?? selectGeminiTtsVoice(speaker.voiceProfile);
    const response = await postGeminiGenerateContent(
      options.apiKey,
      options.model,
      {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [
                  "Perform one line from a scripted fictional character conversation.",
                  `Character: ${speaker.name}.`,
                  speaker.role ? `Role: ${speaker.role}.` : "",
                  speaker.description ? `Description: ${speaker.description}.` : "",
                  "Speak only the line. Honor bracketed delivery tags as performance direction, not spoken words.",
                  "",
                  turn.text
                ]
                  .filter(Boolean)
                  .join("\n")
              }
            ]
          }
        ],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName
              }
            }
          }
        }
      },
      options.fetchImpl
    );
    try {
      chunks.push(pcm16ChunkFromGeminiInlineAudio(extractGeminiInlineAudio(response)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Gemini TTS failed for turn ${index + 1} (${speaker.name}): ${message}`);
    }
  }

  const audio = wavFromPcm16(concatPcm16ChunksWithSilence(chunks, TURN_SILENCE_MS), {
    sampleRate: chunks[0]?.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE,
    channels: chunks[0]?.channels ?? DEFAULT_TTS_CHANNELS
  });
  const speakerVoiceConfigs = geminiTtsSpeakerVoiceConfigs(options.speakers);

  return {
    audio,
    mimeType: "audio/wav",
    provider: "gemini_tts",
    model: options.model,
    durationMs: wavDurationMs(audio),
    metadata: {
      synthesisMode: "turn_by_turn",
      turnCount: options.transcript.turns.length,
      voices: Object.fromEntries(
        speakerVoiceConfigs.map((config) => [config.speaker, config.voiceConfig.prebuiltVoiceConfig.voiceName])
      )
    }
  };
}

export function geminiTtsSpeakerVoiceConfigs(speakers: VoiceConversationSpeaker[]): Array<{
  speaker: string;
  voiceConfig: { prebuiltVoiceConfig: { voiceName: GeminiTtsVoiceName } };
}> {
  return speakers.map((speaker) => ({
    speaker: speaker.name,
    voiceConfig: {
      prebuiltVoiceConfig: {
        voiceName: normalizeGeminiTtsVoiceName(speaker.voiceName) ?? selectGeminiTtsVoice(speaker.voiceProfile)
      }
    }
  }));
}

export function voiceConversationCharacterSnapshots(
  speakers: VoiceConversationSpeaker[]
): VoiceConversationCharacterSnapshot[] {
  return speakers.map((speaker) => ({
    id: speaker.id,
    name: speaker.name,
    role: speaker.role,
    description: speaker.description,
    voiceName: normalizeGeminiTtsVoiceName(speaker.voiceName) ?? selectGeminiTtsVoice(speaker.voiceProfile),
    ...(speaker.temporary ? { temporary: true } : {})
  }));
}

export function normalizeGeminiTtsVoiceName(value: unknown): GeminiTtsVoiceName | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = GEMINI_TTS_SUPPORTED_VOICES.find((voiceName) => voiceName.toLowerCase() === value.trim().toLowerCase());
  return normalized;
}

export function selectGeminiTtsVoice(profile: VoiceProfile, fallback: GeminiTtsVoiceName = "Achird"): GeminiTtsVoiceName {
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
    if (profile.energy === "high") {
      return "Puck";
    }
    return profile.warmth === "high" ? "Achird" : "Charon";
  }
  if (profile.genderPresentation === "neutral" || profile.genderPresentation === "unknown") {
    return profile.warmth === "high" ? "Achird" : fallback;
  }
  return fallback;
}

export function voiceConversationTranscriptToText(transcript: VoiceConversationTranscript): string {
  return transcript.turns.map((turn) => `${turn.speakerName}: ${turn.text}`).join("\n");
}

type Pcm16AudioChunk = {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
};

function wavFromGeminiInlineAudio(inlineAudio: { data: string; mimeType?: string | undefined }): Buffer {
  const audioBytes = Buffer.from(inlineAudio.data, "base64");
  const sourceSampleRate = sampleRateFromMimeType(inlineAudio.mimeType) ?? DEFAULT_TTS_SAMPLE_RATE;
  return isWavAudio(inlineAudio.mimeType, audioBytes) ? audioBytes : wavFromPcm16(audioBytes, { sampleRate: sourceSampleRate });
}

function pcm16ChunkFromGeminiInlineAudio(inlineAudio: { data: string; mimeType?: string | undefined }): Pcm16AudioChunk {
  const audioBytes = Buffer.from(inlineAudio.data, "base64");
  if (isWavAudio(inlineAudio.mimeType, audioBytes)) {
    const chunk = parsePcm16Wav(audioBytes);
    if (!chunk) {
      throw new Error("Gemini TTS WAV response was not readable PCM16 audio.");
    }
    return chunk;
  }
  return {
    pcm: audioBytes,
    sampleRate: sampleRateFromMimeType(inlineAudio.mimeType) ?? DEFAULT_TTS_SAMPLE_RATE,
    channels: DEFAULT_TTS_CHANNELS
  };
}

function concatPcm16ChunksWithSilence(chunks: Pcm16AudioChunk[], silenceMs: number): Buffer {
  if (chunks.length === 0) {
    return Buffer.alloc(0);
  }
  const sampleRate = chunks[0]?.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
  const channels = chunks[0]?.channels ?? DEFAULT_TTS_CHANNELS;
  const silenceFrameCount = Math.max(0, Math.round((sampleRate * silenceMs) / 1000));
  const silence = Buffer.alloc(silenceFrameCount * channels * DEFAULT_TTS_SAMPLE_WIDTH);
  const parts: Buffer[] = [];

  chunks.forEach((chunk, index) => {
    if (chunk.sampleRate !== sampleRate || chunk.channels !== channels) {
      throw new Error("Gemini TTS returned inconsistent audio formats across conversation turns.");
    }
    if (index > 0 && silence.length > 0) {
      parts.push(silence);
    }
    parts.push(chunk.pcm);
  });

  return Buffer.concat(parts);
}

export function wavFromPcm16(
  pcm: Buffer,
  options: { sampleRate?: number | undefined; channels?: number | undefined } = {}
): Buffer {
  const sampleRate = options.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
  const channels = options.channels ?? DEFAULT_TTS_CHANNELS;
  const byteRate = sampleRate * channels * DEFAULT_TTS_SAMPLE_WIDTH;
  const blockAlign = channels * DEFAULT_TTS_SAMPLE_WIDTH;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(DEFAULT_TTS_SAMPLE_WIDTH * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export function wavDurationMs(wav: Buffer): number | null {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bitsPerSample = wav.readUInt16LE(34);
  const dataSize = wav.readUInt32LE(40);
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return null;
  }
  return Math.round((dataSize / bytesPerSecond) * 1000);
}

function parsePcm16Wav(wav: Buffer): Pcm16AudioChunk | null {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(chunkStart + chunkSize, wav.length);
    if (chunkEnd < chunkStart) {
      return null;
    }

    if (chunkId === "fmt " && chunkSize >= 16 && chunkStart + 16 <= wav.length) {
      audioFormat = wav.readUInt16LE(chunkStart);
      channels = wav.readUInt16LE(chunkStart + 2);
      sampleRate = wav.readUInt32LE(chunkStart + 4);
      bitsPerSample = wav.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      data = wav.subarray(chunkStart, chunkEnd);
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || !channels || !sampleRate || !data) {
    return null;
  }
  return {
    pcm: data,
    sampleRate,
    channels
  };
}

export function makeMockVoiceConversationTranscript(
  speakers: VoiceConversationSpeaker[],
  prompt: string,
  previousConversations: VoiceConversationHistoryItem[] = []
): VoiceConversationTranscript {
  const continuationPrefix = previousConversations.length > 0 ? "Continuing from before, " : "";
  return normalizeVoiceConversationTranscript(
    {
      title: previousConversations.length > 0 ? "Mock voice continuation" : "Mock voice conversation",
      turns: [
        { speakerName: speakers[0]?.name, text: `[curious] ${continuationPrefix}${prompt}` },
        { speakerName: speakers[1]?.name, text: "That feels like the right spark. Let us make it sound alive." },
        { speakerName: speakers[0]?.name, text: "Then I will start with the part that matters most." },
        { speakerName: speakers[1]?.name, text: "[laughs softly] And I will make sure we do not drift from the story." }
      ]
    },
    speakers
  );
}

function temporaryCharactersFromTranscript(parsed: z.infer<typeof rawVoiceConversationTranscriptSchema>): RawTemporaryVoiceConversationCharacter[] {
  return [...(parsed.temporaryCharacters ?? []), ...(parsed.temporarySpeakers ?? [])].flatMap((character) => {
    const name = (character.name ?? character.speakerName ?? "").trim();
    return name ? [{ ...character, name }] : [];
  });
}

function resolveTemporaryVoiceConversationSpeaker(options: {
  rawName: string;
  speakers: VoiceConversationSpeakerReference[];
  declaredTemporaryCharacters: RawTemporaryVoiceConversationCharacter[];
  temporarySpeakerByName: Map<string, VoiceConversationSpeaker>;
  allowTemporarySpeakers: boolean;
  maxTemporarySpeakers: number;
}): VoiceConversationSpeaker | undefined {
  const name = cleanTemporarySpeakerName(options.rawName);
  if (!name || !options.allowTemporarySpeakers) {
    return undefined;
  }
  const key = normalizeSpeakerKey(name);
  const existingTemporarySpeaker = options.temporarySpeakerByName.get(key);
  if (existingTemporarySpeaker) {
    return existingTemporarySpeaker;
  }

  const existingSpeakerIds = new Set(options.speakers.map((speaker) => speaker.id));
  const newTemporaryCount = Array.from(options.temporarySpeakerByName.values()).filter(
    (speaker) => !existingSpeakerIds.has(speaker.id)
  ).length;
  if (newTemporaryCount >= options.maxTemporarySpeakers) {
    throw new Error("Voice conversation transcript used too many temporary speakers.");
  }
  if (options.speakers.length + newTemporaryCount + 1 > MAX_VOICE_CONVERSATION_SPEAKERS) {
    throw new Error(`Voice conversation transcript cannot include more than ${MAX_VOICE_CONVERSATION_SPEAKERS} speakers.`);
  }

  const declared = options.declaredTemporaryCharacters.find((character) => {
    const declaredName = (character.name ?? character.speakerName ?? "").trim();
    return normalizeSpeakerKey(declaredName) === key;
  });
  const characterProfile = { name, role: declared?.role, description: declared?.description };
  const temporarySpeaker = voiceConversationSpeakerFromTemporaryCharacter({
    id: temporarySpeakerId(name, [...existingSpeakerIds, ...Array.from(options.temporarySpeakerByName.values()).map((speaker) => speaker.id)]),
    name,
    role: declared?.role ?? "Temporary character",
    description: declared?.description ?? `A temporary character introduced for this voice conversation.`,
    voiceName: selectGeminiTtsVoice(voiceProfileFromTemporaryCharacter(characterProfile))
  });
  options.temporarySpeakerByName.set(key, temporarySpeaker);
  return temporarySpeaker;
}

function voiceConversationTemporaryCharactersForTurns(
  speakers: VoiceConversationSpeakerReference[],
  temporarySpeakerByName: Map<string, VoiceConversationSpeaker>,
  usedSpeakerIds: Set<string>
): VoiceConversationTemporaryCharacter[] {
  const baseTemporarySpeakers = speakers.flatMap((speaker) =>
    speaker.temporary && usedSpeakerIds.has(speaker.id) ? [speakerWithDefaults(speaker)] : []
  );
  const newTemporarySpeakers = Array.from(temporarySpeakerByName.values()).filter((speaker) => usedSpeakerIds.has(speaker.id));
  const byId = new Map<string, VoiceConversationSpeaker>();
  for (const speaker of [...baseTemporarySpeakers, ...newTemporarySpeakers]) {
    byId.set(speaker.id, speaker);
  }
  return Array.from(byId.values()).map((speaker) => voiceConversationTemporaryCharacterFromSpeaker(speaker));
}

function voiceConversationTemporaryCharacterFromSpeaker(speaker: VoiceConversationSpeaker): VoiceConversationTemporaryCharacter {
  return {
    id: speaker.id,
    name: speaker.name,
    role: speaker.role,
    description: speaker.description,
    voiceName: normalizeGeminiTtsVoiceName(speaker.voiceName) ?? selectGeminiTtsVoice(speaker.voiceProfile)
  };
}

function voiceConversationSpeakerFromTemporaryCharacter(character: VoiceConversationTemporaryCharacter): VoiceConversationSpeaker {
  const voiceProfile = voiceProfileFromTemporaryCharacter(character);
  return {
    id: character.id,
    name: character.name,
    role: character.role ?? "Temporary character",
    description: character.description ?? "A temporary character introduced for this voice conversation.",
    traits: [],
    persona: {},
    voiceProfile,
    voiceName: normalizeGeminiTtsVoiceName(character.voiceName) ?? character.voiceName,
    temporary: true
  };
}

function speakerWithDefaults(
  speaker: VoiceConversationSpeakerReference
): VoiceConversationSpeaker {
  return {
    id: speaker.id,
    name: speaker.name,
    role: speaker.role,
    description: speaker.description,
    traits: [],
    persona: {},
    voiceProfile: speaker.voiceProfile ?? voiceProfileFromTemporaryCharacter(speaker),
    voiceName: speaker.voiceName,
    temporary: speaker.temporary
  };
}

function cleanTemporarySpeakerName(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .slice(0, 80);
}

function temporarySpeakerId(name: string, existingIds: string[]): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "character";
  let id = `temporary:${slug}`;
  let suffix = 2;
  while (existingIds.includes(id)) {
    id = `temporary:${slug}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function voiceProfileFromTemporaryCharacter(
  character: Pick<VoiceConversationTemporaryCharacter, "name" | "role" | "description">
): VoiceProfile {
  const text = `${character.name} ${character.role ?? ""} ${character.description ?? ""}`.toLowerCase();
  const ageBand: VoiceProfile["ageBand"] = /\b(child|kid|young boy|young girl|little)\b/.test(text)
    ? "child"
    : /\b(teen|teenage|adolescent)\b/.test(text)
      ? "teen"
      : /\b(elder|elderly|old|aged|ancient|grandmother|grandfather)\b/.test(text)
        ? "elder"
        : "adult";
  const genderPresentation: VoiceProfile["genderPresentation"] = /\b(she|her|woman|girl|mother|queen|lady|princess)\b/.test(text)
    ? "feminine"
    : /\b(he|him|man|boy|father|king|lord|prince|captain)\b/.test(text)
      ? "masculine"
      : "unknown";
  const energy: VoiceProfile["energy"] = /\b(excited|urgent|lively|fierce|quick|bold)\b/.test(text)
    ? "high"
    : /\b(quiet|calm|tired|slow|soft)\b/.test(text)
      ? "low"
      : DEFAULT_TEMPORARY_VOICE_PROFILE.energy;
  const warmth: VoiceProfile["warmth"] = /\b(kind|warm|gentle|friendly|tender)\b/.test(text)
    ? "high"
    : /\b(cold|stern|wary|sharp|severe)\b/.test(text)
      ? "low"
      : DEFAULT_TEMPORARY_VOICE_PROFILE.warmth;

  return {
    ...DEFAULT_TEMPORARY_VOICE_PROFILE,
    ageBand,
    genderPresentation,
    energy,
    warmth
  };
}

function cleanVoiceConversationLine(text: string, speakerName: string): string {
  const escapedName = speakerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`^\\s*${escapedName}\\s*:\\s*`, "i"), "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function normalizeSpeakerKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function compactPlanForTranscript(plan: unknown): unknown {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return undefined;
  }
  const record = plan as Record<string, unknown>;
  return {
    title: stringField(record.title),
    premise: stringField(record.premise),
    audience: stringField(record.audience),
    voiceGuide: stringArrayField(record.voiceGuide).slice(0, 6),
    characters: Array.isArray(record.characters) ? record.characters.slice(0, 8) : []
  };
}

function compactVoiceConversationHistory(history: VoiceConversationHistoryItem[] | undefined): unknown {
  if (!history?.length) {
    return [];
  }
  return history.slice(-6).map((conversation, index) => ({
    index: index + 1,
    prompt: conversation.prompt,
    title: conversation.transcript.title,
    turns: conversation.transcript.turns.map((turn) => ({
      speakerName: turn.speakerName,
      text: turn.text
    }))
  }));
}

function compactPersonaForTranscript(persona: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!persona) {
    return {};
  }
  return {
    personality: stringArrayField(persona.personality).slice(0, 5),
    goals: stringArrayField(persona.goals).slice(0, 4),
    relationships: stringArrayField(persona.relationships).slice(0, 4),
    knownFacts: stringArrayField(persona.knownFacts).slice(0, 6),
    speakingStyle: stringArrayField(persona.speakingStyle).slice(0, 5),
    spoilerBoundaries: stringArrayField(persona.spoilerBoundaries).slice(0, 4),
    instructions: stringField(persona.instructions)?.slice(0, 2000)
  };
}

async function postGeminiGenerateContent(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/${GEMINI_TTS_API_VERSION}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini generateContent failed (${response.status}): ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Gemini generateContent returned non-JSON response. Response excerpt: ${truncateForError(text)}`);
  }
}

function parseGeminiJsonText(response: unknown): unknown {
  const text = geminiResponseText(response);
  const parsed = tryParseGeminiJsonText(text);
  if (parsed.ok) {
    return parsed.value;
  }

  throw new Error(
    `Gemini transcript response did not contain valid JSON. ${geminiResponseDebugSummary(response, text)}`
  );
}

export function parseGeminiTranscriptJsonText(text: string): unknown {
  const parsed = tryParseGeminiJsonText(text);
  if (parsed.ok) {
    return parsed.value;
  }
  throw new Error(`Gemini transcript response did not contain valid JSON. Response excerpt: ${truncateForError(text)}`);
}

function tryParseGeminiJsonText(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    return { ok: false };
  }

  const direct = tryJsonParse(trimmed);
  if (direct.ok) {
    return direct;
  }

  const fencedBlocks = trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fencedBlocks) {
    const fenced = match[1]?.trim();
    if (!fenced) {
      continue;
    }
    const parsed = tryJsonParse(fenced);
    if (parsed.ok) {
      return parsed;
    }
  }

  const embeddedObject = extractFirstBalancedJsonObject(trimmed);
  if (embeddedObject) {
    const parsed = tryJsonParse(embeddedObject);
    if (parsed.ok) {
      return parsed;
    }
  }

  return { ok: false };
}

function tryJsonParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function extractFirstBalancedJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function geminiResponseDebugSummary(response: unknown, text: string): string {
  const record = recordField(response);
  const candidates = Array.isArray(record?.candidates)
    ? record.candidates.flatMap((candidate): Record<string, unknown>[] => {
        const candidateRecord = recordField(candidate);
        return candidateRecord ? [candidateRecord] : [];
      })
    : [];
  const finishReasons = candidates.flatMap((candidate) => {
    const reason = stringField(candidate.finishReason);
    return reason ? [reason] : [];
  });
  const promptFeedback = recordField(record?.promptFeedback);
  const blockReason = stringField(promptFeedback?.blockReason);
  const details = [
    finishReasons.length ? `finishReason=${Array.from(new Set(finishReasons)).join(",")}` : undefined,
    blockReason ? `promptBlockReason=${blockReason}` : undefined,
    `responseExcerpt=${truncateForError(text)}`
  ].filter(Boolean);
  return details.join(" ");
}

function truncateForError(text: string, maxLength = 1200): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "<empty>";
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function geminiResponseText(response: unknown): string {
  const parts = geminiResponseParts(response);
  return parts
    .map((part) => stringField(part.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractGeminiInlineAudio(response: unknown): { data: string; mimeType?: string | undefined } {
  const inlineData = geminiResponseParts(response)
    .map((part) => recordField(part.inlineData) ?? recordField(part.inline_data))
    .find((candidate) => typeof candidate?.data === "string");
  if (!inlineData || typeof inlineData.data !== "string") {
    throw new Error(
      `Gemini TTS response did not contain inline audio data. ${geminiResponseDebugSummary(response, geminiResponseText(response))}`
    );
  }
  return {
    data: inlineData.data,
    mimeType: stringField(inlineData.mimeType) ?? stringField(inlineData.mime_type)
  };
}

function geminiResponseParts(response: unknown): Record<string, unknown>[] {
  const record = recordField(response);
  const candidates = Array.isArray(record?.candidates) ? record.candidates : [];
  const parts = candidates.flatMap((candidate) => {
    const content = recordField(recordField(candidate)?.content);
    return Array.isArray(content?.parts) ? content.parts : [];
  });
  const directParts = Array.isArray(record?.parts) ? record.parts : [];
  return [...parts, ...directParts].flatMap((part) => {
    const recordPart = recordField(part);
    return recordPart ? [recordPart] : [];
  });
}

function isWavAudio(mimeType: string | undefined, bytes: Buffer): boolean {
  return /wav|wave/i.test(mimeType ?? "") || (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF");
}

function sampleRateFromMimeType(mimeType: string | undefined): number | undefined {
  const match = /rate=(\d+)/i.exec(mimeType ?? "");
  const rate = match?.[1] ? Number(match[1]) : undefined;
  return rate && Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayField(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => (typeof entry === "string" && entry.trim() ? [entry.trim()] : []));
}
