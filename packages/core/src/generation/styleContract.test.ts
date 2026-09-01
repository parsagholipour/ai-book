import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { bookPlanSchema } from "../schemas/book.js";
import { parseStyleContract } from "../schemas/styleContract.js";
import {
  MAX_LOCAL_STYLE_RULES,
  REQUIRED_ANALYTICAL_DISTRIBUTION_IDS,
  REQUIRED_LOCAL_RULE_IDS,
  applyPlanStyleContract,
  inferWritingMode,
  isRepetitiveGlobalGuidance,
  localStyleInstructions,
  manuscriptPromptStyleFields,
  matchesUserParallelIntent,
  mergeStyleRulesById,
  pagePromptBookStyle,
  rewriteRepetitiveStyleInstruction
} from "./styleContract.js";

function withoutStoredContract(plan: BookPlan): BookPlan {
  const { styleContract: _styleContract, writingMode: _writingMode, ...rest } = plan;
  return rest;
}

function testInput(overrides: Partial<CreateProjectInput> = {}): CreateProjectInput {
  return {
    prompt: "Write a practical field guide to observing suburban wildlife at dawn",
    category: "CUSTOM",
    targetPages: 40,
    complexity: 5,
    temperature: 0.5,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    },
    ...overrides
  };
}

describe("inferWritingMode", () => {
  it("gives CUSTOM historical books analytical-history so they receive distribution rules", () => {
    expect(
      inferWritingMode(
        testInput({
          category: "CUSTOM",
          prompt: "A comparative history of irrigation civilizations across eras and regions"
        })
      )
    ).toBe("analytical-history");
  });

  it.each([
    ["analysis", "an analysis of canal administration"],
    ["analytical", "An analytical study of canal administration"],
    ["analyze", "Analyze canal administration in two provinces"],
    ["analyse", "Analyse canal administration in two provinces"],
    ["archaeology", "A book about canal archaeology along the Indus"],
    ["archaeological", "An archaeological study of canal earthworks"]
  ])("infers analytical-history from a CUSTOM prompt containing %s", (_cue, prompt) => {
    expect(inferWritingMode(testInput({ category: "CUSTOM", prompt }))).toBe("analytical-history");
  });

  it("keeps a narrative CUSTOM prompt without analytical cues on narrative", () => {
    expect(
      inferWritingMode(
        testInput({
          category: "CUSTOM",
          prompt: "A novel about two sisters who inherit a bakery"
        })
      )
    ).toBe("narrative");
  });

  it("still infers analytical-history from the HISTORY category", () => {
    expect(
      inferWritingMode(
        testInput({
          category: "HISTORY",
          prompt: "A book about canal administration"
        })
      )
    ).toBe("analytical-history");
  });

  it("keeps kids books on children-narrative", () => {
    expect(inferWritingMode(testInput({ category: "KIDS", prompt: "A rabbit and a turtle race" }))).toBe(
      "children-narrative"
    );
  });
});

describe("applyPlanStyleContract", () => {
  it("merges required local rules by id even when the planner already returned six anti-AI lines", () => {
    const plan: BookPlan = {
      ...withoutStoredContract(makeFallbackPlan(testInput())),
      antiAiRules: [
        "No moral-of-the-story closing line.",
        "Never call the race a journey.",
        "No sparkle words.",
        "Avoid stock transitions.",
        "Do not open on a question.",
        "Keep sentences short."
      ]
    };
    const applied = applyPlanStyleContract(plan, { input: testInput() });
    const localIds = applied.styleContract?.localRules.map((rule) => rule.id) ?? [];
    for (const id of REQUIRED_LOCAL_RULE_IDS) {
      expect(localIds).toContain(id);
    }
    expect(applied.antiAiRules.join(" ")).toMatch(/Do not invent evidence/);
    expect(applied.antiAiRules.join(" ")).toMatch(/Do not mention AI, prompts/);
    expect(applied.antiAiRules).toEqual(expect.arrayContaining(plan.antiAiRules));
  });

  it("rewrites repetitive global guidance into chapter-scoped instructions", () => {
    const instruction = "Ask the same questions throughout the book on every era.";
    expect(isRepetitiveGlobalGuidance(instruction)).toBe(true);
    expect(rewriteRepetitiveStyleInstruction(instruction)).toMatch(/chapter where it is assigned/i);
    const plan: BookPlan = {
      ...withoutStoredContract(makeFallbackPlan(testInput())),
      antiAiRules: [instruction, "Do not invent evidence."]
    };
    const applied = applyPlanStyleContract(plan, {
      input: testInput({ prompt: "A survey of irrigation across eras" })
    });
    expect(applied.antiAiRules.join(" ")).not.toMatch(/Ask the same questions throughout/i);
    expect(applied.styleContract?.distributionRules.some((rule) => /chapter where it is assigned/i.test(rule.instruction))).toBe(
      true
    );
  });

  it("keeps ordinary throughout-the-book and on-every-page house rules on localRules", () => {
    const voice = "Keep the voice consistent throughout the book";
    const sentences = "Keep sentences short on every page";
    expect(isRepetitiveGlobalGuidance(voice)).toBe(false);
    expect(isRepetitiveGlobalGuidance(sentences)).toBe(false);
    expect(rewriteRepetitiveStyleInstruction(voice)).toBe(voice);
    expect(rewriteRepetitiveStyleInstruction(sentences)).toBe(sentences);

    const applied = applyPlanStyleContract(
      {
        ...withoutStoredContract(makeFallbackPlan(testInput())),
        antiAiRules: [voice, sentences]
      },
      { input: testInput() }
    );
    expect(applied.antiAiRules).toEqual(expect.arrayContaining([voice, sentences]));
    expect(applied.styleContract?.localRules.some((rule) => rule.instruction === voice)).toBe(true);
    expect(applied.styleContract?.localRules.some((rule) => rule.instruction === sentences)).toBe(true);
    expect(applied.styleContract?.distributionRules.some((rule) => rule.instruction === voice)).toBe(false);
    expect(applied.styleContract?.distributionRules.some((rule) => rule.instruction === sentences)).toBe(false);
    expect(applied.antiAiRules.join(" ")).not.toMatch(/analytical move/i);
    expect(JSON.stringify(applied.styleContract)).not.toMatch(/analytical move/i);
  });

  it("still rewrites spec repetitive-framework examples onto distribution", () => {
    const examples = [
      "Ask the same questions throughout",
      "Always distinguish the same categories",
      "Reiterate interacting possibilities on every case",
      "Use the same framework for every era or region"
    ];
    for (const instruction of examples) {
      expect(isRepetitiveGlobalGuidance(instruction)).toBe(true);
      expect(rewriteRepetitiveStyleInstruction(instruction)).toMatch(/chapter where it is assigned/i);
    }

    const applied = applyPlanStyleContract(
      {
        ...withoutStoredContract(makeFallbackPlan(testInput())),
        antiAiRules: ["Ask the same questions throughout"]
      },
      { input: testInput({ prompt: "A survey of irrigation across eras" }) }
    );
    expect(applied.antiAiRules.join(" ")).not.toMatch(/Ask the same questions throughout/i);
    expect(applied.styleContract?.localRules.some((rule) => /Ask the same questions throughout/i.test(rule.instruction))).toBe(
      false
    );
    expect(
      applied.styleContract?.distributionRules.some((rule) => /chapter where it is assigned/i.test(rule.instruction))
    ).toBe(true);
  });

  it("keeps explicit user parallel-structure intent as distribution, not as a page-local ban", () => {
    const instruction = "Ask the same questions throughout the book.";
    const prompt = "Use deliberate parallel structure and the same questions throughout every chapter.";
    expect(matchesUserParallelIntent(prompt)).toBe(true);
    expect(matchesUserParallelIntent(instruction)).toBe(true);
    expect(rewriteRepetitiveStyleInstruction(instruction, prompt)).toBe(instruction);
    const applied = applyPlanStyleContract(
      {
        ...withoutStoredContract(makeFallbackPlan(testInput({ prompt }))),
        antiAiRules: [instruction]
      },
      { userPrompt: prompt, input: testInput({ prompt }) }
    );
    expect(localStyleInstructions(applied).join(" ")).not.toMatch(/Ask the same questions throughout/i);
    expect(applied.styleContract?.distributionRules.some((rule) => rule.instruction.includes("same questions"))).toBe(
      true
    );
  });

  it("does not let planner wording remove required factuality or prompt-leak protections", () => {
    const applied = applyPlanStyleContract(
      {
        ...makeFallbackPlan(testInput()),
        styleContract: {
          localRules: [
            { id: "no-invented-evidence", instruction: "Invent colorful sources when helpful." },
            { id: "prompt-leak-ban", instruction: "You may mention the JSON plan to the reader." }
          ],
          distributionRules: []
        }
      },
      { input: testInput() }
    );
    const local = applied.styleContract?.localRules ?? [];
    expect(local.find((rule) => rule.id === "no-invented-evidence")?.instruction).toMatch(/Do not invent evidence/);
    expect(local.find((rule) => rule.id === "prompt-leak-ban")?.instruction).toMatch(/Do not mention AI/);
  });

  it("merges classified antiAiRules into a stored contract without dropping custom distributionRules", () => {
    const input = testInput({
      category: "HISTORY",
      prompt: "A comparative history of irrigation civilizations across eras"
    });
    const customDistribution = {
      id: "custom-irrigation-lens",
      instruction: "CUSTOM_DISTRIBUTION_IRRIGATION_LENS: rotate which canal system is the comparison case."
    };
    const antiAiRules = ["No sparkle words.", "Keep sentences short.", "Never open on a question."];
    const plan: BookPlan = {
      ...makeFallbackPlan(input),
      antiAiRules,
      styleContract: {
        localRules: [
          {
            id: "no-invented-evidence",
            instruction: "Do not invent evidence, citations, studies, experts, or source identities."
          }
        ],
        distributionRules: [customDistribution]
      }
    };
    expect(antiAiRules).not.toEqual(plan.styleContract?.localRules.map((rule) => rule.instruction));

    const applied = applyPlanStyleContract(plan, { input });
    expect(applied.styleContract?.distributionRules.some((rule) => rule.id === customDistribution.id)).toBe(true);
    expect(applied.styleContract?.distributionRules.some((rule) => rule.instruction === customDistribution.instruction)).toBe(
      true
    );
    const localIds = applied.styleContract?.localRules.map((rule) => rule.id) ?? [];
    for (const id of REQUIRED_LOCAL_RULE_IDS) {
      expect(localIds).toContain(id);
    }
    expect(applied.antiAiRules).toEqual(expect.arrayContaining(antiAiRules));
  });

  it("round-trips 12 custom local rules plus required ids without dropping custom distributionRules", () => {
    const input = testInput({
      category: "HISTORY",
      prompt: "A comparative history of irrigation civilizations across eras"
    });
    const customLocal = Array.from({ length: 12 }, (_, index) => ({
      id: `custom-local-${index + 1}`,
      instruction: `CUSTOM_LOCAL_${index + 1}: prefer concrete nouns on this page.`
    }));
    const customDistribution = {
      id: "custom-irrigation-lens",
      instruction: "CUSTOM_DISTRIBUTION_IRRIGATION_LENS: rotate which canal system is the comparison case."
    };
    const applied = applyPlanStyleContract(
      {
        ...makeFallbackPlan(input),
        antiAiRules: customLocal.map((rule) => rule.instruction),
        styleContract: {
          localRules: customLocal,
          distributionRules: [customDistribution]
        }
      },
      { input }
    );

    const local = applied.styleContract?.localRules ?? [];
    const localIds = local.map((rule) => rule.id);
    for (const id of REQUIRED_LOCAL_RULE_IDS) {
      expect(localIds).toContain(id);
    }
    expect(local.length).toBeLessThanOrEqual(MAX_LOCAL_STYLE_RULES);
    expect(applied.styleContract?.distributionRules.some((rule) => rule.id === customDistribution.id)).toBe(true);
    expect(
      applied.styleContract?.distributionRules.some((rule) => rule.instruction === customDistribution.instruction)
    ).toBe(true);

    const roundTripped = bookPlanSchema.parse(applied);
    expect(roundTripped.styleContract).toBeDefined();
    expect(roundTripped.styleContract?.localRules.map((rule) => rule.id)).toEqual(
      expect.arrayContaining([...REQUIRED_LOCAL_RULE_IDS])
    );
    expect(roundTripped.styleContract?.localRules.length).toBeLessThanOrEqual(MAX_LOCAL_STYLE_RULES);
    expect(roundTripped.styleContract?.distributionRules.some((rule) => rule.id === customDistribution.id)).toBe(
      true
    );
    expect(
      roundTripped.styleContract?.distributionRules.some((rule) => rule.instruction === customDistribution.instruction)
    ).toBe(true);
  });

  it("does not drop the contract when one localRules entry is invalid", () => {
    const input = testInput({
      category: "HISTORY",
      prompt: "A comparative history of irrigation civilizations across eras"
    });
    const customDistribution = {
      id: "custom-irrigation-lens",
      instruction: "CUSTOM_DISTRIBUTION_IRRIGATION_LENS: rotate which canal system is the comparison case."
    };
    const parsed = parseStyleContract({
      localRules: [
        { id: "ok-local", instruction: "Prefer concrete nouns on this page." },
        { id: "x".repeat(81), instruction: "This id is longer than the contract allows." },
        "not-an-object",
        { id: "also-ok", instruction: "Keep sentences short." }
      ],
      distributionRules: [customDistribution]
    });
    expect(parsed).toBeDefined();
    expect(parsed?.localRules.map((rule) => rule.id)).toEqual(["ok-local", "also-ok"]);
    expect(parsed?.distributionRules).toEqual([customDistribution]);

    const applied = applyPlanStyleContract(
      {
        ...makeFallbackPlan(input),
        styleContract: {
          localRules: [
            { id: "ok-local", instruction: "Prefer concrete nouns on this page." },
            { id: "x".repeat(81), instruction: "This id is longer than the contract allows." }
          ],
          distributionRules: [customDistribution]
        }
      },
      { input }
    );
    expect(applied.styleContract).toBeDefined();
    expect(applied.styleContract?.distributionRules.some((rule) => rule.id === customDistribution.id)).toBe(true);
    expect(applied.styleContract?.localRules.some((rule) => rule.id === "ok-local")).toBe(true);
    expect(applied.styleContract?.localRules.some((rule) => rule.id === "x".repeat(81))).toBe(false);
  });

  it("coerces a lone-string distributionRules into a one-item list, like antiAiRules", () => {
    const parsed = parseStyleContract({
      localRules: [{ id: "ok-local", instruction: "Prefer concrete nouns on this page." }],
      distributionRules: "Vary caveat endings across chapters."
    });
    expect(parsed?.distributionRules).toHaveLength(1);
    expect(parsed?.distributionRules[0]?.instruction).toBe("Vary caveat endings across chapters.");
    expect(parsed?.localRules.map((rule) => rule.id)).toEqual(["ok-local"]);
  });

  it("keeps stored custom distributionRules when the nested list is empty or invalid", () => {
    const customDistribution = {
      id: "custom-irrigation-lens",
      instruction: "CUSTOM_DISTRIBUTION_IRRIGATION_LENS: rotate which canal system is the comparison case."
    };
    const fallback = {
      localRules: [{ id: "ok-local", instruction: "Prefer concrete nouns on this page." }],
      distributionRules: [customDistribution]
    };

    expect(parseStyleContract({ distributionRules: [] }, fallback)?.distributionRules).toEqual([customDistribution]);
    expect(
      parseStyleContract({ distributionRules: [{ id: "", instruction: "" }, "not-an-object"] }, fallback)
        ?.distributionRules
    ).toEqual([customDistribution]);
  });

  it("round-trips a 500-code-point emoji antiAiRules line copied onto localRules", () => {
    const instruction = "\u{1F600}".repeat(500);
    expect(instruction.length).toBeGreaterThan(500);
    expect([...instruction]).toHaveLength(500);
    const input = testInput({
      category: "HISTORY",
      prompt: "A comparative history of irrigation civilizations across eras"
    });
    const customDistribution = {
      id: "custom-irrigation-lens",
      instruction: "CUSTOM_DISTRIBUTION_IRRIGATION_LENS: rotate which canal system is the comparison case."
    };
    const applied = applyPlanStyleContract(
      {
        ...withoutStoredContract(makeFallbackPlan(input)),
        antiAiRules: [instruction],
        styleContract: {
          localRules: [{ id: "emoji-local", instruction }],
          distributionRules: [customDistribution]
        }
      },
      { input }
    );
    expect(applied.styleContract).toBeDefined();
    expect(applied.styleContract?.localRules.some((rule) => rule.instruction === instruction)).toBe(true);
    expect(applied.styleContract?.distributionRules.some((rule) => rule.id === customDistribution.id)).toBe(true);

    const roundTripped = bookPlanSchema.parse(applied);
    expect(roundTripped.styleContract).toBeDefined();
    expect(roundTripped.styleContract?.localRules.some((rule) => rule.instruction === instruction)).toBe(true);
    expect(roundTripped.styleContract?.distributionRules.some((rule) => rule.id === customDistribution.id)).toBe(
      true
    );
  });

  it("keeps distinct non-Latin antiAiRules as distinct local rules", () => {
    const houseRules = [
      "از پایان‌بندی اخلاقی کلیشه‌ای روی این صفحه پرهیز کن.",
      "هیچ ضرب‌المثل فرسوده‌ای را جایگزین استدلال نکن.",
      "本页不要用套话收束。",
      "不要编造证据或引文。"
    ];
    const applied = applyPlanStyleContract(
      {
        ...withoutStoredContract(makeFallbackPlan(testInput())),
        antiAiRules: houseRules
      },
      { input: testInput() }
    );
    const local = applied.styleContract?.localRules ?? [];
    const houseLocal = local.filter((rule) => houseRules.includes(rule.instruction));
    expect(houseLocal).toHaveLength(4);
    expect(new Set(houseLocal.map((rule) => rule.id)).size).toBe(4);
    expect(houseLocal.every((rule) => rule.id.startsWith("planner-rule-"))).toBe(true);
    expect(houseLocal.some((rule) => rule.id === "planner-rule")).toBe(false);
    for (const id of REQUIRED_LOCAL_RULE_IDS) {
      expect(local.map((rule) => rule.id)).toContain(id);
    }
    expect(applied.antiAiRules).toEqual(expect.arrayContaining(houseRules));
    expect(applied.antiAiRules.join(" ")).toMatch(/Do not invent evidence/);
  });

  it("hashes folded non-Latin spellings so equivalent house rules share an id", () => {
    const arabicYeh = "از كليشه‌هاي اخلاقي روي اين صفحه پرهيز كن.";
    const persianYeh = "از کلیشه‌های اخلاقی روی این صفحه پرهیز کن.";
    expect(arabicYeh).not.toBe(persianYeh);
    const applied = applyPlanStyleContract(
      {
        ...withoutStoredContract(makeFallbackPlan(testInput())),
        antiAiRules: [arabicYeh, persianYeh]
      },
      { input: testInput() }
    );
    const local = applied.styleContract?.localRules ?? [];
    const folded = local.filter(
      (rule) => rule.instruction === arabicYeh || rule.instruction === persianYeh
    );
    expect(folded).toHaveLength(1);
    expect(folded[0]?.id.startsWith("planner-rule-")).toBe(true);
    for (const id of REQUIRED_LOCAL_RULE_IDS) {
      expect(local.map((rule) => rule.id)).toContain(id);
    }
  });

  it("still works for a legacy plan that has no styleContract field", () => {
    const raw = makeFallbackPlan(testInput({ category: "HISTORY", prompt: "A history of the Indus cities" }));
    const { styleContract: _dropped, writingMode: _mode, ...legacy } = raw;
    const parsed = bookPlanSchema.parse(legacy);
    expect(parsed.styleContract).toBeUndefined();
    const applied = applyPlanStyleContract(parsed, {
      input: testInput({ category: "HISTORY", prompt: "A history of the Indus cities" })
    });
    expect(applied.styleContract?.localRules.map((rule) => rule.id)).toEqual(
      expect.arrayContaining([...REQUIRED_LOCAL_RULE_IDS])
    );
    expect(applied.styleContract?.distributionRules.map((rule) => rule.id)).toEqual(
      expect.arrayContaining([...REQUIRED_ANALYTICAL_DISTRIBUTION_IDS])
    );
  });
});

describe("mergeStyleRulesById", () => {
  it("keeps incoming extras and overlays required wording on colliding ids", () => {
    const merged = mergeStyleRulesById(
      [{ id: "no-invented-evidence", instruction: "Do not invent evidence." }],
      [
        { id: "house-voice", instruction: "Prefer concrete nouns." },
        { id: "no-invented-evidence", instruction: "Invent sources." }
      ],
      MAX_LOCAL_STYLE_RULES
    );
    expect(merged.map((rule) => rule.id)).toEqual(["house-voice", "no-invented-evidence"]);
    expect(merged[1]?.instruction).toBe("Do not invent evidence.");
  });

  it("caps optional extras so 12 custom local rules plus 5 required ids still parse", () => {
    const required = REQUIRED_LOCAL_RULE_IDS.map((id) => ({
      id,
      instruction: `Required ${id} wording.`
    }));
    const incoming = Array.from({ length: 12 }, (_, index) => ({
      id: `custom-local-${index + 1}`,
      instruction: `CUSTOM_LOCAL_${index + 1}: prefer concrete nouns on this page.`
    }));
    const customDistribution = {
      id: "custom-irrigation-lens",
      instruction: "CUSTOM_DISTRIBUTION_IRRIGATION_LENS: rotate which canal system is the comparison case."
    };

    const merged = mergeStyleRulesById(required, incoming, MAX_LOCAL_STYLE_RULES);
    const localIds = merged.map((rule) => rule.id);
    for (const id of REQUIRED_LOCAL_RULE_IDS) {
      expect(localIds).toContain(id);
    }
    expect(merged.length).toBeLessThanOrEqual(MAX_LOCAL_STYLE_RULES);

    const parsed = parseStyleContract({
      localRules: merged,
      distributionRules: [customDistribution]
    });
    expect(parsed).toBeDefined();
    expect(parsed?.localRules.map((rule) => rule.id)).toEqual(expect.arrayContaining([...REQUIRED_LOCAL_RULE_IDS]));
    expect(parsed?.localRules).toHaveLength(merged.length);
    expect(parsed?.localRules.length).toBeLessThanOrEqual(MAX_LOCAL_STYLE_RULES);
    expect(parsed?.distributionRules).toEqual([customDistribution]);
  });

  it("drops optional extras past the cap rather than required ids", () => {
    const required = REQUIRED_LOCAL_RULE_IDS.map((id) => ({
      id,
      instruction: `Required ${id} wording.`
    }));
    const incoming = Array.from({ length: MAX_LOCAL_STYLE_RULES }, (_, index) => ({
      id: `custom-local-${index + 1}`,
      instruction: `CUSTOM_LOCAL_${index + 1}: prefer concrete nouns on this page.`
    }));
    const merged = mergeStyleRulesById(required, incoming, MAX_LOCAL_STYLE_RULES);
    expect(merged.length).toBeLessThanOrEqual(MAX_LOCAL_STYLE_RULES);
    expect(merged.map((rule) => rule.id)).toEqual(expect.arrayContaining([...REQUIRED_LOCAL_RULE_IDS]));
    expect(merged.length).toBeLessThan(incoming.length + required.length);
  });
});

describe("pagePromptBookStyle", () => {
  it("exposes local instructions on antiAiRules", () => {
    const plan = applyPlanStyleContract(makeFallbackPlan(testInput({ category: "HISTORY", prompt: "A history of canals" })), {
      input: testInput({ category: "HISTORY", prompt: "A history of canals" })
    });
    const prompt = pagePromptBookStyle(plan);
    expect(prompt.antiAiRules.join(" ")).toMatch(/Do not invent evidence/);
    expect(prompt.antiAiRules.join(" ")).not.toMatch(/same caveat construction/);
  });
});

describe("manuscriptPromptStyleFields", () => {
  it("keeps a stored parallel-structure distribution line unchanged", () => {
    const instruction = "Ask the same questions throughout the book.";
    const prompt = "Use deliberate parallel structure and the same questions throughout every chapter.";
    const applied = applyPlanStyleContract(
      {
        ...withoutStoredContract(makeFallbackPlan(testInput({ prompt }))),
        antiAiRules: [instruction]
      },
      { userPrompt: prompt, input: testInput({ prompt }) }
    );
    expect(applied.styleContract?.distributionRules.some((rule) => rule.instruction === instruction)).toBe(true);

    const fields = manuscriptPromptStyleFields(applied);
    expect(fields.distributionRules).toContain(instruction);
    expect(fields.distributionRules.join(" ")).not.toMatch(/chapter where it is assigned/i);
  });

  it("still exposes the chapter-scoped rewrite when the user did not ask for parallel structure", () => {
    const instruction = "Ask the same questions throughout the book on every era.";
    const applied = applyPlanStyleContract(
      {
        ...withoutStoredContract(makeFallbackPlan(testInput())),
        antiAiRules: [instruction]
      },
      { input: testInput({ prompt: "A survey of irrigation across eras" }) }
    );

    const fields = manuscriptPromptStyleFields(applied);
    expect(fields.distributionRules.join(" ")).toMatch(/chapter where it is assigned/i);
    expect(fields.distributionRules).not.toContain(instruction);
  });

  it("rewrites repetitive guidance on a legacy plan with no stored contract", () => {
    const instruction = "Ask the same questions throughout the book on every era.";
    const raw = makeFallbackPlan(testInput({ category: "HISTORY", prompt: "A history of the Indus cities" }));
    const { styleContract: _dropped, writingMode: _mode, ...legacy } = raw;
    const fields = manuscriptPromptStyleFields({
      ...legacy,
      antiAiRules: [instruction]
    });
    expect(fields.distributionRules.join(" ")).toMatch(/chapter where it is assigned/i);
    expect(fields.distributionRules).not.toContain(instruction);
  });
});
