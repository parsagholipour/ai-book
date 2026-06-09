import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import {
  buildCharacterProfileImagePrompt,
  buildVoiceCharacterPersona,
  candidatesFromPlanCharacters,
  extractVoiceCharacterCandidates,
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
    lessCensored: false,
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

  it("reinforces in-character answers for already-saved personas", () => {
    const instructions = reinforceRealtimeCharacterRoleplay(
      "You are Lina. Stay in character, but be honest that you are an AI-generated fictional character if asked.",
      "Lina"
    );

    expect(instructions).toContain("Roleplay priority supersedes older persona text");
    expect(instructions).toContain("Answer in first person as Lina");
    expect(instructions).toContain("ordinary questions about your identity");
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
