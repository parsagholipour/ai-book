import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  JsonResult,
  TextModelAdapter,
  TextResult
} from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { JsonValue } from "../schemas/jsonCoercion.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import type { LibraryCharacterSnapshot } from "./libraryCharacters.js";
import { createPlanningPackage, revisePlanningPackage } from "./planner.js";
import { planLibraryCharacterGuidance, reconcilePlanLibraryCharacters } from "./planLibraryCharacters.js";

const NATALIA: LibraryCharacterSnapshot = {
  id: "lib-natalia",
  name: "Natalia",
  // The real record: who she is, with nothing at all about how she looks.
  description: "She's a great wife and future mother",
  fields: [{ key: "Age", value: "31" }]
};

describe("reconcilePlanLibraryCharacters", () => {
  it("returns the plan untouched when the reader saved no characters", () => {
    const plan = planWith([character({ name: "Someone" })]);
    expect(reconcilePlanLibraryCharacters(plan, [])).toBe(plan);
  });

  it("replaces the schema placeholder and refuses an invented look — the shipped failure", () => {
    // Exactly what "The Winning Header" carried: the name survived, the
    // description was the schema's placeholder, and the planner had written a
    // look it had no way of knowing.
    const plan = planWith([
      character({
        name: "Natalia",
        description: "Recurring character in the plan.",
        visualRules: ["hair with a small braid", "wears a simple dress"]
      })
    ]);

    const reconciled = reconcilePlanLibraryCharacters(plan, [NATALIA]);

    expect(reconciled.characters).toHaveLength(1);
    expect(reconciled.characters[0]).toMatchObject({
      name: "Natalia",
      description: "She's a great wife and future mother",
      visualRules: []
    });
  });

  it("keeps the planned role and traits, which the library says nothing about", () => {
    const plan = planWith([
      character({ name: "Natalia", role: "Team captain", traits: ["determined", "calm under pressure"] })
    ]);

    const reconciled = reconcilePlanLibraryCharacters(plan, [NATALIA]);

    expect(reconciled.characters[0]).toMatchObject({
      role: "Team captain",
      traits: ["determined", "calm under pressure"]
    });
  });

  it("uses a recorded appearance verbatim as the only visual rule", () => {
    const described: LibraryCharacterSnapshot = {
      ...NATALIA,
      appearance: "Adult woman in a black hijab and a grey embroidered top."
    };
    const plan = planWith([character({ name: "Natalia", visualRules: ["a young girl with a ponytail"] })]);

    const reconciled = reconcilePlanLibraryCharacters(plan, [described]);

    expect(reconciled.characters[0]?.visualRules).toEqual([
      "Adult woman in a black hijab and a grey embroidered top."
    ]);
  });

  it("renames a decorated or translated character back to the saved spelling", () => {
    const plan = planWith([character({ name: "Captain Natalia" })]);

    const reconciled = reconcilePlanLibraryCharacters(plan, [NATALIA]);

    expect(reconciled.characters.map((entry) => entry.name)).toEqual(["Natalia"]);
  });

  it("matches across Arabic and Persian spellings of one saved name", () => {
    // Folded by `foldCharacterName`: the Arabic yeh the model echoed back is
    // the Persian yeh the reader typed.
    const ali: LibraryCharacterSnapshot = { id: "lib-ali", name: "علی", description: "", fields: [] };
    const plan = planWith([character({ name: "علي", description: "Recurring character in the plan." })]);

    const reconciled = reconcilePlanLibraryCharacters(plan, [ali]);

    expect(reconciled.characters.map((entry) => entry.name)).toEqual(["علی"]);
  });

  it("appends a saved character the plan dropped entirely", () => {
    const plan = planWith([character({ name: "Coach Mendes" })]);

    const reconciled = reconcilePlanLibraryCharacters(plan, [NATALIA]);

    expect(reconciled.characters.map((entry) => entry.name)).toEqual(["Coach Mendes", "Natalia"]);
    expect(reconciled.characters[1]).toMatchObject({
      description: "She's a great wife and future mother",
      traits: ["Age: 31"],
      visualRules: []
    });
  });

  it("leaves characters the reader never saved exactly as planned", () => {
    const invented = character({ name: "Coach Mendes", description: "A patient coach.", visualRules: ["silver whistle"] });
    const plan = planWith([invented, character({ name: "Natalia" })]);

    const reconciled = reconcilePlanLibraryCharacters(plan, [NATALIA]);

    expect(reconciled.characters[0]).toEqual(invented);
  });

  it("collapses two entries that resolve to one saved character, keeping the richer draft", () => {
    const plan = planWith([
      character({ name: "Natalia", role: "Cameo", description: "", traits: [] }),
      character({
        name: "Natalia the striker",
        role: "Team captain",
        description: "The heart of the team across every match.",
        traits: ["determined"]
      })
    ]);

    const reconciled = reconcilePlanLibraryCharacters(plan, [NATALIA]);

    expect(reconciled.characters).toHaveLength(1);
    expect(reconciled.characters[0]).toMatchObject({
      name: "Natalia",
      role: "Team captain",
      traits: ["determined"],
      // Still the library's description: the collapse chooses which draft
      // survives, not what the saved character is.
      description: "She's a great wife and future mother"
    });
  });

  it("never appends a second character under a name the plan already uses", () => {
    // Two library rows saved under one name: appending both would give the
    // book two characters the reference-sheet name lookup cannot tell apart.
    const twin: LibraryCharacterSnapshot = { ...NATALIA, id: "lib-natalia-2", description: "A second row." };
    const plan = planWith([character({ name: "Natalia" })]);

    const reconciled = reconcilePlanLibraryCharacters(plan, [NATALIA, twin]);

    expect(reconciled.characters.map((entry) => entry.name)).toEqual(["Natalia"]);
  });

  it("names the reference images as the authority in the page rules, once", () => {
    const plan = planWith([character({ name: "Natalia" })]);

    const reconciled = reconcilePlanLibraryCharacters(plan, [NATALIA]);
    const rules = reconciled.illustrationPlan.pageRules;

    expect(rules.at(-1)).toContain("the attached character reference images are the only authority");
    expect(rules.at(-1)).toContain('"Natalia"');
    // A replan reconciles an already-reconciled plan.
    expect(reconcilePlanLibraryCharacters(reconciled, [NATALIA]).illustrationPlan.pageRules).toEqual(rules);
  });

  it("is idempotent, because every replan runs it again over its own output", () => {
    const plan = planWith([
      character({ name: "Captain Natalia", description: "Recurring character in the plan.", visualRules: ["braid"] }),
      character({ name: "Coach Mendes" })
    ]);

    const once = reconcilePlanLibraryCharacters(plan, [NATALIA]);
    expect(reconcilePlanLibraryCharacters(once, [NATALIA])).toEqual(once);
  });
});

describe("planLibraryCharacterGuidance", () => {
  it("says nothing when the reader mentioned no saved characters", () => {
    expect(planLibraryCharacterGuidance([])).toEqual([]);
  });

  it("carries the records inline so the appearance rule has a line to point at", () => {
    const described: LibraryCharacterSnapshot = { ...NATALIA, appearance: "Adult woman in a black hijab." };
    const guidance = planLibraryCharacterGuidance([described]).join(" ");

    expect(guidance).toContain("Appearance (fixed — use verbatim, do not invent or alter): Adult woman in a black hijab.");
    expect(guidance).toContain("reuse it word for word in visualRules");
    // Self-contained: the revision prompt has no userInput to point at.
    expect(guidance).not.toContain("userInput");
  });

  it("forbids inventing a look for a character whose appearance was never recorded", () => {
    const guidance = planLibraryCharacterGuidance([NATALIA]).join(" ");

    expect(guidance).toContain("Leave their visualRules empty");
    expect(guidance).toContain("never translate, transliterate, shorten, or re-spell a saved name");
  });
});

describe("planner prompts", () => {
  it("puts the verbatim-name rule after the translate-everything rule", async () => {
    const input = testInput({ language: "fa", mediaSettings: mediaSettingsWith([NATALIA]) });
    const { systemPrompt } = await runPlanner(input);

    const translateEverything = systemPrompt.indexOf("Write all book-facing string values in Persian");
    const keepTheName = systemPrompt.indexOf("never translate, transliterate, shorten, or re-spell a saved name");
    expect(translateEverything).toBeGreaterThanOrEqual(0);
    expect(keepTheName).toBeGreaterThan(translateEverything);
    // The language rule carries the exemption itself, for every other model
    // that reads it without any library guidance beside it.
    expect(systemPrompt).toContain("Proper names the user supplied are identifiers, not text to translate");
  });

  it("puts the library rules after the generic invent-visualRules demand", async () => {
    const input = testInput({ mediaSettings: mediaSettingsWith([NATALIA]) });
    const { systemPrompt } = await runPlanner(input);

    const inventVisualRules = systemPrompt.indexOf("For every recurring character, include concrete visualRules");
    const leaveEmpty = systemPrompt.indexOf("Leave their visualRules empty");
    expect(inventVisualRules).toBeGreaterThanOrEqual(0);
    expect(leaveEmpty).toBeGreaterThan(inventVisualRules);
  });

  it("reconciles the parsed plan, so a renamed and re-described character comes back", async () => {
    const input = testInput({ mediaSettings: mediaSettingsWith([NATALIA]) });
    const { plan } = await runPlanner(input, [
      character({
        name: "Natália the young striker",
        description: "Recurring character in the plan.",
        visualRules: ["dark hair in a ponytail, wearing a simple dress"]
      })
    ]);

    expect(plan.characters).toHaveLength(1);
    expect(plan.characters[0]).toMatchObject({
      name: "Natalia",
      description: "She's a great wife and future mother",
      visualRules: []
    });
  });

  it("restores a saved character into a forced fallback plan, so MOCK_AI matches production", async () => {
    const input = testInput({ mediaSettings: mediaSettingsWith([NATALIA]) });

    const plan = await createPlanningPackage({
      input,
      textModel: unusedTextModel(),
      research: stubResearch(),
      forceFallback: true
    });

    expect(plan.characters.map((entry) => entry.name)).toEqual(["Natalia"]);
  });
});

describe("revisePlanningPackage library characters", () => {
  it("carries the saved characters into the revision prompt and payload", async () => {
    const input = testInput({ mediaSettings: mediaSettingsWith([NATALIA]) });
    let request: GenerateJsonOptions<unknown> | undefined;
    const textModel = recordingTextModel(
      (options) => {
        request = options as GenerateJsonOptions<unknown>;
      },
      { title: "Shorter Winning Header", questions: [] }
    );

    await revisePlanningPackage({
      currentPlan: planWith([character({ name: "Natalia" })]),
      userMessage: "Make it shorter.",
      textModel,
      input,
      targetPages: input.targetPages
    });

    const systemPrompt = request!.messages.find((message) => message.role === "system")!.content;
    expect(systemPrompt).toContain("She's a great wife and future mother");
    const userPayload = JSON.parse(request!.messages.find((message) => message.role === "user")!.content);
    expect(userPayload.libraryCharacters).toEqual([NATALIA]);
  });

  it("puts a saved character the revision dropped back into the plan", async () => {
    const input = testInput({ mediaSettings: mediaSettingsWith([NATALIA]) });
    const currentPlan = planWith([character({ name: "Natalia" })]);
    const textModel = recordingTextModel(() => undefined, {
      title: "Shorter Winning Header",
      questions: [],
      // An array in a revision is an atomic replacement, which is how "make it
      // shorter" used to delete the reader's own character.
      characters: [{ name: "Coach Mendes", role: "Mentor", description: "A patient coach.", traits: [], visualRules: [] }]
    });

    const revised = await revisePlanningPackage({
      currentPlan,
      userMessage: "Make it shorter.",
      textModel,
      input,
      targetPages: input.targetPages
    });

    expect(revised.characters.map((entry) => entry.name)).toEqual(["Coach Mendes", "Natalia"]);
  });

  it("leaves a revision with no library characters alone", async () => {
    const input = testInput();
    const currentPlan = planWith([character({ name: "Coach Mendes" })]);
    let request: GenerateJsonOptions<unknown> | undefined;
    const textModel = recordingTextModel(
      (options) => {
        request = options as GenerateJsonOptions<unknown>;
      },
      { title: "Shorter", questions: [] }
    );

    await revisePlanningPackage({ currentPlan, userMessage: "Make it shorter.", textModel, input });

    const userPayload = JSON.parse(request!.messages.find((message) => message.role === "user")!.content);
    expect(userPayload.libraryCharacters).toBeUndefined();
  });
});

async function runPlanner(
  input: CreateProjectInput,
  characters: BookPlan["characters"] = []
): Promise<{ plan: BookPlan; systemPrompt: string }> {
  const fallback = makeFallbackPlan(input);
  let request: GenerateJsonOptions<unknown> | undefined;
  const textModel = recordingTextModel(
    (options) => {
      request = options as GenerateJsonOptions<unknown>;
    },
    { ...fallback, characters }
  );

  const plan = await createPlanningPackage({ input, textModel, research: stubResearch() });
  return {
    plan,
    systemPrompt: request!.messages.find((message) => message.role === "system")!.content
  };
}

function recordingTextModel(onRequest: (options: GenerateJsonOptions<unknown>) => void, data: unknown): TextModelAdapter {
  return {
    async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
      onRequest(options as GenerateJsonOptions<unknown>);
      return { data: data as T, text: JSON.stringify(data), model: "test-model", provider: "test" };
    },
    async generateText(_options: GenerateTextOptions): Promise<TextResult> {
      throw new Error("Not used");
    },
    async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
      throw new Error("Not used");
    },
    generateWithTools: unsupportedGenerateWithTools
  };
}

function unusedTextModel(): TextModelAdapter {
  return recordingTextModel(() => {
    throw new Error("Not used");
  }, {});
}

function stubResearch() {
  return {
    async search(query: { query: string }) {
      return { query: query.query, summary: "", sources: [] };
    }
  };
}

function character(overrides: Partial<BookPlan["characters"][number]> = {}): BookPlan["characters"][number] {
  return {
    name: "Someone",
    role: "Supporting character",
    description: "Recurring character in the plan.",
    traits: [],
    visualRules: [],
    ...overrides
  };
}

function planWith(characters: BookPlan["characters"]): BookPlan {
  return { ...makeFallbackPlan(testInput()), characters };
}

function mediaSettingsWith(characters: LibraryCharacterSnapshot[]): CreateProjectInput["mediaSettings"] {
  return {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral",
    // Round-tripped exactly as the stored snapshot is: `mobile` is opaque JSON,
    // and a snapshot type is only structurally JSON-shaped.
    mobile: JSON.parse(JSON.stringify({ characters })) as JsonValue
  };
}

function testInput(overrides: Partial<CreateProjectInput> = {}): CreateProjectInput {
  return {
    prompt: "Make a 4 page book about a football match won by a header",
    category: "STORY",
    targetPages: 4,
    complexity: 5,
    temperature: 0.7,
    language: "en",
    mediaSettings: mediaSettingsWith([]),
    ...overrides
  };
}
