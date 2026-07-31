import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter, unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import {
  buildCharacterProfileImagePrompt,
  buildRealtimeGroupCharacterInstructions,
  buildVoiceCharacterPersona,
  candidatesFromPlanCharacters,
  extractVoiceCharacterCandidates,
  refineVoiceCharacterCandidatesWithPageSamples,
  reinforceRealtimeCharacterRoleplay,
  shouldExtractFallbackVoiceCharacters,
  voiceCharactersDisabledForInput
} from "./voiceCharacters.js";

const input: CreateProjectInput = {
  prompt: "A bedtime story about a brave girl and her old moon captain friend.",
  category: "KIDS",
  targetPages: 12,
  complexity: 3,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "every-page",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

const plan: BookPlan = {
  ...makeFallbackPlan(input),
  characters: [
    {
      name: "Lina",
      role: "Girl protagonist",
      description: "A brave girl who asks careful questions.",
      traits: ["brave", "warm"],
      visualRules: ["Red scarf", "Bright boots"]
    },
    {
      name: "Captain Orlo",
      role: "Elder moon captain",
      description: "An old captain with a measured voice and kind eyes.",
      traits: ["patient", "formal"],
      visualRules: ["Silver coat", "Star compass"]
    }
  ]
};

describe("voice character helpers", () => {
  it("uses existing plan characters and infers age/gender conservatively", () => {
    const candidates = candidatesFromPlanCharacters(input, plan);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      name: "Lina",
      source: "PLAN",
      voiceProfile: {
        ageBand: "child",
        genderPresentation: "feminine",
        warmth: "high"
      }
    });
    expect(candidates[1]).toMatchObject({
      name: "Captain Orlo",
      voiceProfile: {
        ageBand: "elder",
        formality: "formal"
      }
    });
  });

  it("refines generic plan character voice profiles from page pronouns", async () => {
    const animalPlan: BookPlan = {
      ...plan,
      characters: [
        {
          name: "Turtle",
          role: "Protagonist, a slow but determined racer",
          description: "Recurring character in the plan.",
          traits: [],
          visualRules: []
        },
        {
          name: "Rabbit",
          role: "Antagonist, a fast but overconfident racer",
          description: "Recurring character in the plan.",
          traits: [],
          visualRules: []
        }
      ]
    };

    const candidates = await extractVoiceCharacterCandidates({
      input,
      plan: animalPlan,
      pages: [
        {
          index: 1,
          markdown: [
            "Turtle has a tiny leaf on her shell.",
            "Rabbit zooms ahead.",
            "Her feet kick up puffs of dust."
          ].join("\n"),
          summary: "Rabbit is fast and sure she will win. Turtle is slow but steady."
        },
        {
          index: 2,
          markdown: "Turtle walks on. One step, then another. She keeps going.",
          summary: "Turtle continues step by step."
        }
      ],
      textModel: new FakeTextModelAdapter(input)
    });

    expect(candidates.find((candidate) => candidate.name === "Turtle")?.voiceProfile).toMatchObject({
      genderPresentation: "feminine",
      pace: "slow"
    });
    expect(candidates.find((candidate) => candidate.name === "Rabbit")?.voiceProfile).toMatchObject({
      genderPresentation: "feminine",
      pace: "fast"
    });
  });

  it("disables likely real-person categories unless the prompt is fictional", () => {
    expect(
      voiceCharactersDisabledForInput({
        prompt: "A biography of Ada Lovelace",
        category: "BIOGRAPHY"
      })
    ).toBe(true);
    expect(
      shouldExtractFallbackVoiceCharacters({
        prompt: "A historical fantasy story about a fictional clockmaker",
        category: "HISTORY"
      })
    ).toBe(true);
  });

  it("falls back to first-page extraction for story-like books without plan characters", async () => {
    const emptyPlan = { ...plan, characters: [] };
    const candidates = await extractVoiceCharacterCandidates({
      input,
      plan: emptyPlan,
      pages: [{ index: 1, title: "One", markdown: "A fictional character waves from the moon.", summary: "A wave." }],
      textModel: new FakeTextModelAdapter(input)
    });

    expect(candidates[0]).toMatchObject({
      name: "Mock Character",
      source: "BOOK_SAMPLE",
      voiceProfile: {
        genderPresentation: "neutral"
      }
    });
  });

  it("builds a persona and call instructions from a candidate", async () => {
    const candidate = candidatesFromPlanCharacters(input, plan)[0]!;
    const persona = await buildVoiceCharacterPersona({
      input,
      plan,
      candidate,
      pages: [{ index: 1, markdown: "Lina checks the moon map.", summary: "Lina studies the map." }],
      textModel: new FakeTextModelAdapter(input)
    });

    expect(persona.name).toBe("Lina");
    expect(persona.instructions).toContain("You are Lina");
    expect(persona.instructions).toContain("speaking from inside the story world");
    expect(persona.instructions).toContain("ordinary character-detail questions");
    expect(persona.instructions).not.toContain("be honest that you are an AI-generated fictional character");
    expect(persona.voiceProfile.warmth).toBe("high");
  });

  it("does not cap voice character JSON output with app-level max tokens", async () => {
    const requests: Array<{ purpose: string | undefined; hasMaxTokens: boolean; maxTokens: number | undefined }> = [];
    const textModel: TextModelAdapter = {
      async generateText(options) {
        return {
          text: `text for ${options.purpose ?? "unknown"}`,
          model: "recording-model",
          provider: "recording"
        };
      },
      async generateJson(options) {
        requests.push({
          purpose: options.purpose,
          hasMaxTokens: Object.hasOwn(options, "maxTokens"),
          maxTokens: options.maxTokens
        });
        const data =
          options.purpose === "extract-voice-character-candidates"
            ? { characters: [] }
            : {
                personality: ["Curious"],
                goals: ["Stay faithful to the book."],
                relationships: [],
                knownFacts: ["Known from supplied pages."],
                speakingStyle: ["Conversational."],
                spoilerBoundaries: ["Avoid later spoilers unless asked."],
                greeting: "Hello.",
                voiceProfile: {
                  ageBand: "adult",
                  genderPresentation: "neutral",
                  energy: "medium",
                  warmth: "medium",
                  pace: "medium",
                  formality: "balanced"
                }
              };
        return {
          data: options.schema.parse(data),
          text: JSON.stringify(data),
          model: "recording-model",
          provider: "recording"
        };
      },
      async *streamText() {
        yield "stream";
      },
      generateWithTools: unsupportedGenerateWithTools
    };

    await extractVoiceCharacterCandidates({
      input,
      plan: { ...plan, characters: [] },
      pages: [{ index: 1, title: "One", markdown: "Lina checks the moon map.", summary: "Lina studies the map." }],
      textModel
    });

    await buildVoiceCharacterPersona({
      input,
      plan,
      candidate: candidatesFromPlanCharacters(input, plan)[0]!,
      pages: [{ index: 1, markdown: "Lina checks the moon map.", summary: "Lina studies the map." }],
      textModel
    });

    expect(requests).toEqual([
      {
        purpose: "extract-voice-character-candidates",
        hasMaxTokens: false,
        maxTokens: undefined
      },
      {
        purpose: "build-voice-character-persona",
        hasMaxTokens: false,
        maxTokens: undefined
      }
    ]);
  });

  it("splits long voice page context without clipping text", async () => {
    const pageChunks: Array<{
      index: number;
      total: number;
      pages: Array<{ excerpt: string }>;
    }> = [];
    const textModel: TextModelAdapter = {
      async generateText() {
        return {
          text: "text",
          model: "recording-model",
          provider: "recording"
        };
      },
      async generateJson(options) {
        const payload = JSON.parse(options.messages[options.messages.length - 1]!.content) as {
          pageChunk: {
            index: number;
            total: number;
            pages: Array<{ excerpt: string }>;
          };
        };
        pageChunks.push(payload.pageChunk);
        const data = {
          personality: ["Curious"],
          goals: ["Stay faithful to the book."],
          relationships: [],
          knownFacts: ["Known from supplied pages."],
          speakingStyle: ["Conversational."],
          spoilerBoundaries: ["Avoid later spoilers unless asked."],
          greeting: "Hello.",
          voiceProfile: {
            ageBand: "adult",
            genderPresentation: "neutral",
            energy: "medium",
            warmth: "medium",
            pace: "medium",
            formality: "balanced"
          }
        };
        return {
          data: options.schema.parse(data),
          text: JSON.stringify(data),
          model: "recording-model",
          provider: "recording"
        };
      },
      async *streamText() {
        yield "stream";
      },
      generateWithTools: unsupportedGenerateWithTools
    };
    const longPage = Array.from({ length: 7_000 }, (_, index) => `token${index}`).join(" ");

    await buildVoiceCharacterPersona({
      input,
      plan,
      candidate: candidatesFromPlanCharacters(input, plan)[0]!,
      pages: [{ index: 1, markdown: longPage, summary: "Lina follows a long moon map." }],
      textModel
    });

    expect(pageChunks.length).toBeGreaterThan(1);
    expect(pageChunks.map((chunk) => chunk.index)).toEqual(pageChunks.map((_, index) => index + 1));
    expect(pageChunks.every((chunk) => chunk.total === pageChunks.length)).toBe(true);
    expect(pageChunks.flatMap((chunk) => chunk.pages.map((page) => page.excerpt)).join(" ")).toBe(longPage);
    expect(pageChunks.flatMap((chunk) => chunk.pages.map((page) => page.excerpt)).join(" ")).not.toContain("...");
  });

  it("reinforces in-character answers for already-saved personas", () => {
    const instructions = reinforceRealtimeCharacterRoleplay(
      "You are Lina. Stay in character, but be honest that you are an AI-generated fictional character if asked.",
      "Lina"
    );

    expect(instructions).toContain("Roleplay priority supersedes older persona text");
    expect(instructions).toContain("Answer in first person as Lina");
    expect(instructions).toContain("ordinary questions about your identity");
  });

  it("wraps saved personas with group voice room turn rules", () => {
    const instructions = buildRealtimeGroupCharacterInstructions({
      baseInstructions: "You are Lina. Avoid later spoilers unless asked.",
      characterName: "Lina",
      participantNames: ["Lina", "Captain Orlo"]
    });

    expect(instructions).toContain("You are Lina");
    expect(instructions).toContain("Roleplay priority supersedes older persona text");
    expect(instructions).toContain("Group voice room rules");
    expect(instructions).toContain("Other characters in the room: Captain Orlo");
    expect(instructions).toContain("Speak only as Lina");
    expect(instructions).toContain("Avoid later spoilers unless asked");
  });

  describe("age inference", () => {
    function ageFor(role: string, description: string, category: CreateProjectInput["category"] = "STORY") {
      const candidates = candidatesFromPlanCharacters(
        { ...input, category },
        { ...plan, characters: [{ name: "Sam", role, description, traits: [], visualRules: [] }] }
      );
      return candidates[0]!.voiceProfile.ageBand;
    }

    it("reads a stated age over any other word in the description", () => {
      // The regression this whole group exists for: an adult described as a
      // "slave girl" was read as a child, which put a child's voice into an
      // explicit book.
      expect(ageFor("Protagonist, slave girl", "A young woman in her early twenties.")).toBe("young_adult");
      expect(ageFor("Master", "A tall, imposing man in his late thirties.")).toBe("adult");
      expect(ageFor("Neighbour", "She is 34 years old.")).toBe("adult");
      expect(ageFor("Elder", "A man aged 71.")).toBe("elder");
    });

    it("still reads a child in a children's book", () => {
      expect(ageFor("Girl protagonist", "A brave girl who asks careful questions.", "KIDS")).toBe("child");
      expect(ageFor("Sidekick", "A small boy with a wooden sword.", "KIDS")).toBe("child");
    });

    it("does not read an adult called a girl or boy as a child", () => {
      // Outside a children's book, "girl" and "boy" are gender words.
      expect(ageFor("Escort", "A call girl working the late shift.")).toBe("adult");
      expect(ageFor("Clerk", "The new boy in accounting.")).toBe("adult");
      // And an adult stays an adult even inside one.
      expect(ageFor("Mum", "A girl no longer — a woman with two children.", "KIDS")).toBe("adult");
    });
  });

  describe("gender refinement from page samples", () => {
    const pages = [
      {
        index: 1,
        title: "One",
        summary: "",
        markdown: [
          "Parsa watched from the doorway.",
          "She shivered, and her breath caught.",
          "She reached for the lamp.",
          "Her hands were shaking."
        ].join(" ")
      }
    ];

    function refine(genderPresentation: "masculine" | "unknown") {
      const candidate = {
        name: "Parsa",
        role: "Master",
        description: "A man.",
        traits: [],
        visualRules: [],
        source: "PLAN" as const,
        voiceProfile: {
          ageBand: "adult" as const,
          genderPresentation,
          energy: "medium" as const,
          warmth: "medium" as const,
          pace: "medium" as const,
          formality: "balanced" as const
        }
      };
      return refineVoiceCharacterCandidatesWithPageSamples([candidate], pages)[0]!.voiceProfile
        .genderPresentation;
    }

    it("never overrules a gender the description stated", () => {
      // Prose that sits close to one character floods the text around every
      // other name with her pronouns. That is not evidence about Parsa.
      expect(refine("masculine")).toBe("masculine");
    });

    it("still fills in a gender the description left open", () => {
      const pages = [
        {
          index: 1,
          title: "One",
          summary: "",
          // Each sentence names him and carries his pronoun: evidence only
          // counts where it can actually be attributed.
          markdown: "Parsa said he was calm. Parsa knew he was right. Parsa took his coat."
        }
      ];
      const candidate = {
        name: "Parsa",
        role: "Master",
        description: "Someone.",
        traits: [],
        visualRules: [],
        source: "PLAN" as const,
        voiceProfile: {
          ageBand: "adult" as const,
          genderPresentation: "unknown" as const,
          energy: "medium" as const,
          warmth: "medium" as const,
          pace: "medium" as const,
          formality: "balanced" as const
        }
      };
      expect(
        refineVoiceCharacterCandidatesWithPageSamples([candidate], pages)[0]!.voiceProfile.genderPresentation
      ).toBe("masculine");
    });

    it("does not credit a character with pronouns from sentences that never name them", () => {
      // One sentence names Parsa; the three after it are about someone else.
      // Carrying his name forward handed him all of their pronouns.
      expect(refine("unknown")).toBe("unknown");
    });
  });

  it("builds a text-free profile portrait prompt", () => {
    const prompt = buildCharacterProfileImagePrompt({
      plan,
      candidate: candidatesFromPlanCharacters(input, plan)[0]!
    });

    expect(prompt).toContain("square profile portrait");
    expect(prompt).toContain("Lina");
    expect(prompt).toContain("feminine gender presentation");
    expect(prompt).toContain("Do not include readable text");
  });
});
