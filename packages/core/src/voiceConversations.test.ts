import { describe, expect, it, vi } from "vitest";
import {
  geminiTtsSpeakerVoiceConfigs,
  generateGeminiVoiceConversationTranscript,
  normalizeVoiceConversationTranscript,
  parseGeminiTranscriptJsonText,
  selectGeminiTtsVoice,
  synthesizeGeminiTtsConversation,
  voiceConversationSpeakersForTranscript,
  wavDurationMs,
  wavFromPcm16
} from "./voiceConversations.js";
import type { VoiceProfile } from "./generation/voiceCharacters.js";

const neutralProfile: VoiceProfile = {
  ageBand: "adult",
  genderPresentation: "unknown",
  energy: "medium",
  warmth: "medium",
  pace: "medium",
  formality: "balanced"
};

const speakers = [
  { id: "lina", name: "Lina" },
  { id: "orlo", name: "Captain Orlo" }
];

describe("voice conversations", () => {
  it("selects Gemini TTS voices from existing voice profiles", () => {
    expect(selectGeminiTtsVoice({ ...neutralProfile, genderPresentation: "feminine" })).toBe("Sulafat");
    expect(selectGeminiTtsVoice({ ...neutralProfile, genderPresentation: "feminine", energy: "high" })).toBe("Kore");
    expect(selectGeminiTtsVoice({ ...neutralProfile, genderPresentation: "masculine", warmth: "high" })).toBe("Achird");
    expect(selectGeminiTtsVoice({ ...neutralProfile, ageBand: "child", genderPresentation: "masculine" })).toBe("Puck");
    expect(selectGeminiTtsVoice({ ...neutralProfile, ageBand: "elder", genderPresentation: "masculine" })).toBe("Gacrux");
  });

  it("builds speaker configs with exact speaker names", () => {
    const configs = geminiTtsSpeakerVoiceConfigs([
      { id: "lina", name: "Lina", voiceProfile: { ...neutralProfile, genderPresentation: "feminine" } },
      { id: "orlo", name: "Captain Orlo", voiceProfile: { ...neutralProfile, genderPresentation: "masculine" } }
    ]);

    expect(configs).toEqual([
      { speaker: "Lina", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Sulafat" } } },
      { speaker: "Captain Orlo", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } }
    ]);
  });

  it("keeps saved Gemini TTS voice names for continuations", () => {
    const configs = geminiTtsSpeakerVoiceConfigs([
      { id: "lina", name: "Lina", voiceName: "Puck", voiceProfile: { ...neutralProfile, genderPresentation: "feminine" } },
      { id: "orlo", name: "Captain Orlo", voiceName: "Sulafat", voiceProfile: { ...neutralProfile, genderPresentation: "masculine" } }
    ]);

    expect(configs).toEqual([
      { speaker: "Lina", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
      { speaker: "Captain Orlo", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Sulafat" } } }
    ]);
  });

  it("wraps PCM as browser-playable WAV audio", () => {
    const wav = wavFromPcm16(Buffer.alloc(48_000), { sampleRate: 24_000 });

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(48_000);
    expect(wavDurationMs(wav)).toBe(1000);
  });

  it("rejects transcript turns from unknown speakers", () => {
    expect(() =>
      normalizeVoiceConversationTranscript(
        {
          turns: [
            { speakerName: "Lina", text: "I know this place." },
            { speakerName: "Captain Orlo", text: "Then lead us." },
            { speakerName: "Mira", text: "I should not be here." },
            { speakerName: "Lina", text: "Stay close." }
          ]
        },
        speakers
      )
    ).toThrow(/unknown speaker/i);
  });

  it("adds temporary speakers when transcript generation introduces a named character", () => {
    const transcript = normalizeVoiceConversationTranscript(
      {
        title: "Mira Arrives",
        temporaryCharacters: [
          {
            name: "Mira",
            role: "Gate mechanic",
            description: "A warm, quick-speaking mechanic who knows the gate."
          }
        ],
        turns: [
          { speakerName: "Lina", text: "The lock is waking up." },
          { speakerName: "Captain Orlo", text: "Then tell it to sleep." },
          { speakerName: "Mira", text: "[laughs softly] It never listens to captains." },
          { speakerName: "Lina", text: "Mira, we could use your hands." }
        ]
      },
      speakers,
      { allowTemporarySpeakers: true }
    );

    expect(transcript.temporaryCharacters).toEqual([
      expect.objectContaining({
        id: "temporary:mira",
        name: "Mira",
        role: "Gate mechanic"
      })
    ]);
    expect(transcript.turns[2]).toEqual(
      expect.objectContaining({ speakerId: "temporary:mira", speakerName: "Mira" })
    );
  });

  it("rejects transcript turns with empty text", () => {
    expect(() =>
      normalizeVoiceConversationTranscript(
        {
          turns: [
            { speakerName: "Lina", text: "Start with the signal." },
            { speakerName: "Captain Orlo", text: "I hear it." },
            { speakerName: "Lina", text: "   " },
            { speakerName: "Captain Orlo", text: "Then we wait." }
          ]
        },
        speakers
      )
    ).toThrow();
  });

  it("parses Gemini transcript JSON wrapped in prose", () => {
    const parsed = parseGeminiTranscriptJsonText(`
      Here is the scene:
      {
        "title": "Signal Below",
        "turns": [
          { "speakerName": "Lina", "text": "The signal is under us." },
          { "speakerName": "Captain Orlo", "text": "Then we walk softly." },
          { "speakerName": "Lina", "text": "[quietly] You never walk softly." },
          { "speakerName": "Captain Orlo", "text": "I do when the floor complains first." }
        ]
      }
      Hope this helps.
    `);

    expect(parsed).toEqual({
      title: "Signal Below",
      turns: [
        { speakerName: "Lina", text: "The signal is under us." },
        { speakerName: "Captain Orlo", text: "Then we walk softly." },
        { speakerName: "Lina", text: "[quietly] You never walk softly." },
        { speakerName: "Captain Orlo", text: "I do when the floor complains first." }
      ]
    });
  });

  it("synthesizes casts above two speakers turn by turn", async () => {
    const pcm = Buffer.alloc(480).toString("base64");
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
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
      )
    );
    const transcript = normalizeVoiceConversationTranscript(
      {
        temporaryCharacters: [{ name: "Mira", role: "Mechanic", description: "A warm mechanic." }],
        turns: [
          { speakerName: "Lina", text: "The gate is stuck." },
          { speakerName: "Captain Orlo", text: "That is rarely good news." },
          { speakerName: "Mira", text: "It is if you brought me a wrench." },
          { speakerName: "Lina", text: "I brought two." }
        ]
      },
      [
        { id: "lina", name: "Lina", voiceProfile: neutralProfile },
        { id: "orlo", name: "Captain Orlo", voiceProfile: neutralProfile }
      ],
      { allowTemporarySpeakers: true }
    );
    const transcriptSpeakers = voiceConversationSpeakersForTranscript(
      [
        { id: "lina", name: "Lina", voiceProfile: neutralProfile },
        { id: "orlo", name: "Captain Orlo", voiceProfile: neutralProfile }
      ],
      transcript
    );

    const result = await synthesizeGeminiTtsConversation({
      apiKey: "test-key",
      model: "gemini-tts-test",
      transcript,
      speakers: transcriptSpeakers,
      fetchImpl: fetchMock
    });
    const audioRequests = (fetchMock.mock.calls as unknown as Array<[unknown, { body?: string }]>).map((call) =>
      JSON.parse(String(call[1]?.body))
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.metadata.synthesisMode).toBe("turn_by_turn");
    expect(result.audio.toString("ascii", 0, 4)).toBe("RIFF");
    expect(audioRequests[0]?.generationConfig?.speechConfig?.voiceConfig).toBeDefined();
    expect(audioRequests[0]?.generationConfig?.speechConfig?.multiSpeakerVoiceConfig).toBeUndefined();
  });

  it("reports the turn and Gemini finish reason when turn-by-turn TTS returns no audio", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.alloc(480).toString("base64") } }]
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "SAFETY",
                content: {
                  parts: [{ text: "Audio could not be generated for this line." }]
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    const transcript = normalizeVoiceConversationTranscript(
      {
        temporaryCharacters: [{ name: "Mira", role: "Mechanic", description: "A warm mechanic." }],
        turns: [
          { speakerName: "Lina", text: "The gate is stuck." },
          { speakerName: "Mira", text: "I can fix it." },
          { speakerName: "Captain Orlo", text: "Then fix it quickly." },
          { speakerName: "Lina", text: "We trust you." }
        ]
      },
      [
        { id: "lina", name: "Lina", voiceProfile: neutralProfile },
        { id: "orlo", name: "Captain Orlo", voiceProfile: neutralProfile }
      ],
      { allowTemporarySpeakers: true }
    );
    const transcriptSpeakers = voiceConversationSpeakersForTranscript(
      [
        { id: "lina", name: "Lina", voiceProfile: neutralProfile },
        { id: "orlo", name: "Captain Orlo", voiceProfile: neutralProfile }
      ],
      transcript
    );

    await expect(
      synthesizeGeminiTtsConversation({
        apiKey: "test-key",
        model: "gemini-tts-test",
        transcript,
        speakers: transcriptSpeakers,
        fetchImpl: fetchMock
      })
    ).rejects.toThrow(/turn 2 \(Mira\).*finishReason=SAFETY.*Audio could not be generated/);
  });

  it("reports Gemini transcript excerpts and finish reasons when JSON parsing fails", async () => {
    await expect(
      generateGeminiVoiceConversationTranscript({
        apiKey: "test-key",
        model: "gemini-test",
        project: { title: "The Moon Gate", prompt: "A portal story." },
        userPrompt: "Continue the argument.",
        speakers: [
          { id: "lina", name: "Lina", voiceProfile: neutralProfile },
          { id: "orlo", name: "Captain Orlo", voiceProfile: neutralProfile }
        ],
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  finishReason: "STOP",
                  content: {
                    parts: [{ text: "I can write this as a lively dialogue, but not as JSON right now." }]
                  }
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      })
    ).rejects.toThrow(/finishReason=STOP.*I can write this as a lively dialogue/);
  });

  it("requests enough transcript output tokens for temporary-character JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: "Mira Arrives",
                      temporaryCharacters: [
                        {
                          name: "Mira",
                          role: "Gate mechanic",
                          description: "A warm mechanic who knows the old lock."
                        }
                      ],
                      turns: [
                        { speakerName: "Lina", text: "The lock is waking up." },
                        { speakerName: "Captain Orlo", text: "Then tell it to sleep." },
                        { speakerName: "Mira", text: "It never listens to captains." },
                        { speakerName: "Lina", text: "Mira, we could use your hands." }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await generateGeminiVoiceConversationTranscript({
      apiKey: "test-key",
      model: "gemini-test",
      project: { title: "The Moon Gate", prompt: "A portal story." },
      userPrompt: "Have Mira interrupt.",
      speakers: [
        { id: "lina", name: "Lina", voiceProfile: neutralProfile },
        { id: "orlo", name: "Captain Orlo", voiceProfile: neutralProfile }
      ],
      fetchImpl: fetchMock
    });
    const request = (fetchMock.mock.calls as unknown as Array<[unknown, { body?: string }]>)[0]?.[1];
    const requestBody = JSON.parse(String(request?.body)) as {
      generationConfig?: { maxOutputTokens?: number };
    };

    expect(requestBody.generationConfig?.maxOutputTokens).toBeGreaterThanOrEqual(4096);
  });
});
