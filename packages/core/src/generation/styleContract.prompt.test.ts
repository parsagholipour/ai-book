import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { buildContextPack } from "../context/contextPack.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { generatePageDraft, generateWholeBookDraft } from "./pages.js";
import { applyPlanStyleContract, manuscriptPromptStyleFields, pagePromptBookStyle } from "./styleContract.js";

const LOCAL_MARKER = "UNIQUE_LOCAL_PAGE_RULE_MARKER";
const DISTRIBUTION_MARKER = "UNIQUE_DISTRIBUTION_MANUSCRIPT_RULE_MARKER";

function historyInput(): CreateProjectInput {
  return {
    prompt: "A comparative history of irrigation across eras",
    category: "HISTORY",
    targetPages: 2,
    complexity: 6,
    temperature: 0.4,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    }
  };
}

function planWithMarkers() {
  const input = historyInput();
  const base = makeFallbackPlan(input);
  return applyPlanStyleContract(
    {
      ...base,
      styleContract: {
        localRules: [
          ...(base.styleContract?.localRules ?? []),
          { id: "custom-local", instruction: LOCAL_MARKER }
        ],
        distributionRules: [
          ...(base.styleContract?.distributionRules ?? []),
          { id: "custom-dist", instruction: DISTRIBUTION_MARKER }
        ]
      }
    },
    { input }
  );
}

function capturingModel(rawData: unknown): { model: TextModelAdapter; requests: GenerateJsonOptions<unknown>[] } {
  const requests: GenerateJsonOptions<unknown>[] = [];
  return {
    requests,
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools,
      async generateJson(options) {
        requests.push(options);
        return {
          data: options.schema.parse(rawData),
          text: JSON.stringify(rawData),
          model: "test-model",
          provider: "test"
        };
      }
    }
  };
}

describe("style contract prompt routing", () => {
  it("puts local rules in page prompts and keeps distribution rules out", async () => {
    const input = historyInput();
    const plan = planWithMarkers();
    expect(pagePromptBookStyle(plan).antiAiRules).toContain(LOCAL_MARKER);
    expect(pagePromptBookStyle(plan).antiAiRules).not.toContain(DISTRIBUTION_MARKER);

    const pack = buildContextPack({
      plan,
      chapter: plan.chapters[0],
      pageIndex: 1,
      targetPages: 2,
      previousSummaries: [],
      continuityNotes: [],
      researchNotes: [],
      tokenBudget: 2000
    });
    expect(pack.system).toContain(LOCAL_MARKER);
    expect(pack.system).not.toContain(DISTRIBUTION_MARKER);

    const pageDraft = capturingModel({
      title: "Cubits",
      markdown: "The Palermo Stone lists cubit heights for several Nile floods.",
      summary: "Nile cubits are recorded.",
      continuityNotes: []
    });
    await generatePageDraft({
      input,
      plan,
      chapter: plan.chapters[0],
      pageIndex: 1,
      previousSummaries: [],
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: pageDraft.model
    });
    const pageUser = pageDraft.requests[0]?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(pageUser).toContain(LOCAL_MARKER);
    expect(pageUser).not.toContain(DISTRIBUTION_MARKER);

    const whole = capturingModel({
      pages: [
        {
          index: 1,
          title: "Cubits",
          markdown: "The Palermo Stone lists cubit heights for several Nile floods.",
          summary: "Nile cubits are recorded."
        },
        {
          index: 2,
          title: "Silt",
          markdown: "Han memorials name Yellow River silt rather than cubits.",
          summary: "Silt is a different measure."
        }
      ]
    });
    await generateWholeBookDraft({
      input,
      plan,
      textModel: whole.model,
      researchNotes: []
    });
    const wholeUser = whole.requests[0]?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(wholeUser).toContain(LOCAL_MARKER);
    expect(wholeUser).not.toContain(DISTRIBUTION_MARKER);
  });

  it("puts distribution rules on the manuscript review payload helper", () => {
    const fields = manuscriptPromptStyleFields(planWithMarkers());
    expect(fields.distributionRules).toContain(DISTRIBUTION_MARKER);
    expect(fields.distributionRules.join(" ")).not.toContain(LOCAL_MARKER);
  });
});
