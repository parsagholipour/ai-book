import { describe, expect, it } from "vitest";
import { PROJECT_PROMPT_MAX_LENGTH, type GenerateWithToolsOptions, type TextModelAdapter } from "@book-maker/core";
import { mobileComposedProjectCreateSchema } from "./mobile/schemas.js";
import {
  COMPOSED_PROJECT_PROMPT_MAX,
  adviseMobileBook,
  attachmentContextForTurn,
  briefForMobilePayload,
  chatSettingChangesFromMessage,
  composeMobileProjectPrompt,
  detectMessageLanguage,
  deterministicAdvisor,
  explicitTargetPagesForMobilePayload,
  deterministicCreationTurn,
  enrichCreationTurnWithSearch,
  greetingCreationTurn,
  isBuildRequestMessage,
  metaAnswerForMessage,
  mobileCreationDraftPayloadSchema,
  runCreationTurn,
  titleForMobilePayload,
  type MobileCreationTurnRequest
} from "./mobileCreation.js";
import type { ResearchAdapter } from "@book-maker/core";

/** One scripted assistant turn for the tools-enabled creation chat model. */
type ScriptedToolTurn =
  | { toolCalls: Array<{ name: string; arguments: unknown }>; text?: string }
  | { finish: Record<string, unknown> }
  | { text: string }
  | { error: Error }
  | { hang: true };

type ScriptedToolModel = TextModelAdapter & { calls: GenerateWithToolsOptions[] };

function toolModel(turns: ScriptedToolTurn[]): ScriptedToolModel {
  const calls: GenerateWithToolsOptions[] = [];
  let index = 0;
  return {
    calls,
    async generateWithTools(options) {
      calls.push(options);
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (!turn) {
        return { text: "", model: "fake", provider: "fake", toolCalls: [] };
      }
      if ("hang" in turn) {
        return new Promise<never>(() => undefined);
      }
      if ("error" in turn) {
        throw turn.error;
      }
      if ("finish" in turn) {
        return {
          text: "",
          model: "fake",
          provider: "fake",
          toolCalls: [{ id: `call_${index}`, name: "finish_turn", arguments: turn.finish }]
        };
      }
      return {
        text: turn.text ?? "",
        model: "fake",
        provider: "fake",
        toolCalls: ("toolCalls" in turn ? turn.toolCalls : []).map((call, callIndex) => ({
          id: `call_${index}_${callIndex}`,
          name: call.name,
          arguments: call.arguments
        }))
      };
    },
    generateText: () => Promise.reject(new Error("not used")),
    generateJson: () => Promise.reject(new Error("not used")),
    // eslint-disable-next-line require-yield
    streamText: async function* () {
      throw new Error("not used");
    }
  };
}

describe("runCreationTurn", () => {
  const autoRequest: MobileCreationTurnRequest = {
    messages: [{ role: "user", content: "Bedtime story for 5 year olds" }]
  };
  const childRequest: MobileCreationTurnRequest = {
    messages: [{ role: "user", content: "Bedtime story for 5 year olds" }],
    presets: {
      bookType: "short_story",
      bookTypeChoice: "children_story",
      lengthPreset: "short",
      qualityPreset: "balanced",
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: true
    }
  };

  it("greeting turn invites the user without allowing a build yet", () => {
    const turn = greetingCreationTurn();

    expect(turn.readiness.canBuild).toBe(false);
    expect(turn.quickReplies.length).toBeGreaterThan(0);
    expect(turn.question).toBeNull();
    expect(turn.assistantMessage.length).toBeGreaterThan(0);
  });

  it("throws when enrichment exhausts without a usable finish_turn patch", async () => {
    const request: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "Make a scientific book about a recent discovering" }]
    };
    const model = toolModel([
      { toolCalls: [{ name: "update_settings", arguments: { tone: "curious" } }] },
      { toolCalls: [{ name: "update_settings", arguments: { tone: "curious" } }] },
      { toolCalls: [{ name: "update_settings", arguments: { tone: "curious" } }] },
      { toolCalls: [{ name: "update_settings", arguments: { tone: "curious" } }] }
    ]);

    await expect(
      enrichCreationTurnWithSearch(
        { textModel: model, research: neverSearchAdapter() },
        request,
        deterministicCreationTurn(request)
      )
    ).rejects.toThrow(/no usable patch/i);
  });

  it("switches the book type when the user explicitly asks in chat", () => {
    const turn = deterministicCreationTurn({
      messages: [
        { role: "user", content: "Create a practical pricing guide for consultants." },
        { role: "assistant", content: "Got it - this sounds like a practical guide." },
        { role: "user", content: "Actually make it a bedtime story for 5 year olds." }
      ],
      brief: {
        lane: "practical_guide",
        title: "",
        artifact: "",
        audience: "",
        promise: "",
        tone: "",
        mainCharacter: "",
        conflict: "",
        ending: "",
        theme: "",
        nextStep: "",
        exercises: "",
        mustInclude: ""
      },
      presets: {
        bookType: "lead_magnet",
        bookTypeChoice: "auto",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true,
        coverEnabled: true,
        illustrationsEnabled: true
      }
    });

    expect(turn.detectedLane).toBe("children_story");
    expect(turn.presets.bookType).toBe("short_story");
    expect(turn.presets.bookTypeChoice).toBe("children_story");
    expect(turn.assistantMessage).toContain("children's story");
  });

  it("keeps Auto unresolved when the chat merely mentions a genre without asking to switch", () => {
    const turn = deterministicCreationTurn({
      messages: [
        { role: "user", content: "A book about how my kids story time became our family ritual." }
      ],
      presets: {
        bookType: "lead_magnet",
        bookTypeChoice: "auto",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true,
        coverEnabled: true,
        illustrationsEnabled: true
      }
    });

    expect(turn.presets.bookTypeChoice).toBe("auto");
  });

  it("honors an explicit richer book type choice", () => {
    const turn = deterministicCreationTurn({
      messages: [{ role: "user", content: "Create a practical guide for onboarding consulting clients." }],
      presets: {
        bookType: "workbook",
        bookTypeChoice: "client_tool",
        lengthPreset: "standard",
        qualityPreset: "balanced",
        imagesEnabled: true,
        coverEnabled: true,
        illustrationsEnabled: true
      }
    });

    expect(turn.detectedLane).toBe("client_tool");
    expect(turn.brief.lane).toBe("client_tool");
    expect(turn.presets.bookType).toBe("workbook");
    expect(turn.presets.bookTypeChoice).toBe("client_tool");
  });

  it("treats an in-chat build request as ready to build", () => {
    const turn = deterministicCreationTurn({
      messages: [
        { role: "user", content: "Bedtime story for 5 year olds" },
        { role: "assistant", content: "Got it. What should the book feel like?" },
        { role: "user", content: "Ok, build it" }
      ]
    });

    expect(turn.buildRequested).toBe(true);
    expect(turn.readiness.canBuild).toBe(true);
    expect(turn.question).toBeNull();
  });

  it("recognizes build phrasings and rejects non-build messages", () => {
    expect(isBuildRequestMessage("ok build it")).toBe(true);
    expect(isBuildRequestMessage("Looks good, go ahead")).toBe(true);
    expect(isBuildRequestMessage("build the plan now")).toBe(true);
    expect(isBuildRequestMessage("make it funnier")).toBe(false);
    expect(isBuildRequestMessage("what will you build?")).toBe(false);
  });

  it("detects the message language and carries it on the turn", () => {
    expect(detectMessageLanguage("یک کتاب داستان برای کودکان درباره دوستی")).toBe("fa");
    expect(detectMessageLanguage("Сказка на ночь для детей")).toBe("ru");
    expect(detectMessageLanguage("A bedtime story about a fox")).toBeUndefined();
    expect(detectMessageLanguage("write the book in Persian please")).toBe("fa");

    const turn = deterministicCreationTurn({
      messages: [{ role: "user", content: "یک کتاب داستان برای کودکان درباره دوستی و مهربانی" }]
    });
    expect(turn.language).toBe("fa");
  });

  it("does not set a book language from a topic that names one", () => {
    expect(detectMessageLanguage("Just write a book about aliens in Chinese media")).toBeUndefined();
    expect(chatSettingChangesFromMessage("Just write a book about aliens in Chinese media").language)
      .toBeUndefined();

    const turn = deterministicCreationTurn({
      messages: [{ role: "user", content: "Just write a book about aliens in Chinese media" }]
    });
    expect(turn.language).toBeUndefined();
    expect(turn.assistantMessage).not.toMatch(/in Chinese/i);
  });

  it("answers capability questions without derailing the brief", () => {
    expect(metaAnswerForMessage("How much will this cost?")).toMatch(/credits/i);
    expect(metaAnswerForMessage("What formats do I get?")).toMatch(/PDF and EPUB/i);
    expect(metaAnswerForMessage("Make the hero a dragon")).toBeNull();

    const turn = deterministicCreationTurn({
      messages: [
        { role: "user", content: "Bedtime story for 5 year olds" },
        { role: "assistant", content: "Got it. What should the book feel like?" },
        { role: "user", content: "What will this cost?" }
      ]
    });

    expect(turn.assistantMessage).toMatch(/credits/i);
    expect(turn.quickReplies).toContain("Back to my book");
    expect(turn.brief.audience.length).toBeGreaterThan(0);
  });

  it("falls back to the deterministic turn when enrichment throws", async () => {
    const turn = await runCreationTurn(autoRequest, {
      enrich: async () => {
        throw new Error("model unavailable");
      }
    });

    expect(turn.detectedLane).toBe("auto");
    expect(turn.assistantMessage.length).toBeGreaterThan(0);
  });

  it("falls back to the deterministic turn when enrichment times out", async () => {
    const turn = await runCreationTurn(autoRequest, {
      enrich: () => new Promise<never>(() => undefined),
      timeoutMs: 5
    });

    expect(turn.detectedLane).toBe("auto");
    expect(turn.readiness.canBuild).toBe(true);
  });

  it("applies a valid enrichment patch on top of the deterministic base", async () => {
    const turn = await runCreationTurn(childRequest, {
      enrich: async (_request, base) => ({
        assistantMessage: "Lovely - a cozy bedtime tale it is.",
        quickReplies: ["Add a friendly moon"],
        readiness: base.readiness
      })
    });

    expect(turn.assistantMessage).toContain("cozy bedtime");
    expect(turn.quickReplies).toContain("Add a friendly moon");
    expect(turn.detectedLane).toBe("children_story");
  });

  it("does not attach an English fallback card to a localized AI reply", async () => {
    const turn = await runCreationTurn(
      {
        messages: [
          {
            role: "user",
            content:
              "Cria para mim uma história de romance entre um homem persa e uma brasileira que querem se casar."
          }
        ],
        language: "pt"
      },
      {
        enrich: async () => ({
          assistantMessage:
            "Que linda ideia! Para começar, para quem você imagina essa história?"
        })
      }
    );

    expect(turn.assistantMessage).toContain("para quem você imagina");
    expect(turn.question).toBeNull();
    expect(turn.quickReplies).toEqual([]);
    expect(turn.readiness.missing).toEqual([]);
  });

  it("keeps a localized AI question and its readiness label together", async () => {
    const turn = await runCreationTurn(autoRequest, {
      enrich: async () => ({
        assistantMessage: "Ótima ideia. Sobre o que deve ser a história?",
        question: {
          prompt: "Sobre o que deve ser a história?",
          options: ["Uma pessoa", "Um animal", "Uma aventura"],
          allowCustom: true
        }
      })
    });

    expect(turn.question?.prompt).toBe("Sobre o que deve ser a história?");
    expect(turn.quickReplies).toEqual([]);
    expect(turn.readiness.missing).toEqual(["Sobre o que deve ser a história"]);
  });

  it("reports enrichment failures through onEnrichError", async () => {
    const failure = new Error("model unavailable");
    let reported: unknown;
    const turn = await runCreationTurn(autoRequest, {
      enrich: async () => {
        throw failure;
      },
      onEnrichError: (error) => {
        reported = error;
      }
    });

    expect(reported).toBe(failure);
    expect(turn.assistantMessage.length).toBeGreaterThan(0);
  });

  it("keeps the AI reply when the model returns bookLanguage, nulls, or unknown keys", async () => {
    // Real model output observed in production: a good tailored reply was
    // discarded (falling back to the canned interviewer) because the patch
    // used the input field name bookLanguage and carried explicit nulls.
    const model = toolModel([
      {
        finish: {
          assistantMessage: "A bedtime story sounds lovely. What should the bedtime story be about?",
          question: {
            prompt: "What should the bedtime story be about?",
            options: ["A hero", "An animal"],
            allowCustom: true
          },
          bookLanguage: "fa",
          extraneous: "ignored",
          brief: null,
          buildRequested: false
        }
      }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      autoRequest,
      deterministicCreationTurn(autoRequest)
    );

    expect(patch.assistantMessage).toContain("bedtime story");
    expect(patch.question?.prompt).toBe("What should the bedtime story be about?");
    expect(patch.language).toBe("fa");
    expect(patch.brief).toBeUndefined();
  });
});

function neverSearchAdapter(): ResearchAdapter {
  return {
    search: () => Promise.reject(new Error("search must not run"))
  };
}



describe("creation chat web search", () => {
  const request: MobileCreationTurnRequest = {
    messages: [
      { role: "user", content: "Make a scientific book about a recent discovery" },
      { role: "assistant", content: "What recent discovery would you like to focus on?" },
      { role: "user", content: "Find it on the internet and tell me" }
    ]
  };

  const groundedResearch: ResearchAdapter = {
    async search(query) {
      return {
        query: query.query,
        summary: "Astronomers reported a newly characterized nearby exoplanet.",
        sources: [
          {
            title: "NASA discovery brief",
            url: "https://science.nasa.gov/example",
            summary: "NASA describes the evidence and discovery method."
          }
        ]
      };
    }
  };

  const searchThenAnswer: ScriptedToolTurn[] = [
    { toolCalls: [{ name: "web_search", arguments: { query: "latest credible scientific discovery 2026" } }] },
    {
      finish: {
        assistantMessage: "A promising option is a newly characterized nearby exoplanet.",
        question: {
          prompt: "Should the book focus on how it was detected or why it matters?",
          options: ["How it was detected", "Why it matters"],
          allowCustom: true
        }
      }
    }
  ];

  it("exposes web_search, update_settings, request_build, and finish_turn tools to the model", async () => {
    const model = toolModel([{ finish: { assistantMessage: "Sounds good.", question: null } }]);

    await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "update_settings",
      "request_build",
      "finish_turn"
    ]);
    expect(model.calls[0]!.purpose).toBe("mobile-book-conversation");
  });

  it("applies update_settings from the model tool and confirms in the finish patch", async () => {
    const model = toolModel([
      {
        toolCalls: [
          {
            name: "update_settings",
            arguments: { imagesEnabled: false, bookTypeChoice: "workbook", targetPages: 40 }
          }
        ]
      },
      {
        finish: {
          assistantMessage: "Got it — visuals off, workbook shape, about 40 pages.",
          question: null
        }
      }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.presets).toMatchObject({
      imagesEnabled: false,
      bookTypeChoice: "workbook",
      targetPages: 40,
      pageCountMode: "custom",
      pageCountSource: "chat"
    });
    expect(patch.assistantMessage).toContain("visuals off");
    expect(patch.buildRequested).toBe(false);
  });

  it("applies exact cover-only settings from the model tool", async () => {
    const model = toolModel([
      {
        toolCalls: [
          {
            name: "update_settings",
            arguments: { coverEnabled: true, illustrationsEnabled: false }
          }
        ]
      },
      {
        finish: {
          assistantMessage: "Got it — the cover stays and in-book illustrations are off.",
          question: null
        }
      }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.presets).toMatchObject({
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: false
    });
  });

  it("sets buildRequested only when request_build is called", async () => {
    const model = toolModel([
      { toolCalls: [{ name: "request_build", arguments: {} }] },
      {
        finish: {
          assistantMessage: "Perfect — I'll start building the plan.",
          question: null,
          buildRequested: true
        }
      }
    ]);
    const buildRequest = {
      ...request,
      messages: [
        ...request.messages,
        { role: "user" as const, content: "Ok, build it" }
      ]
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      buildRequest,
      deterministicCreationTurn(buildRequest)
    );

    expect(patch.buildRequested).toBe(true);
    expect(patch.question).toBeNull();
  });

  it("does not inherit a deterministic regex build request when enrichment succeeds without request_build", async () => {
    const model = toolModel([
      {
        finish: {
          assistantMessage: "Tell me a bit more about the ending first.",
          question: {
            prompt: "How should it end?",
            options: ["Happy", "Bittersweet"],
            allowCustom: true
          }
        }
      }
    ]);
    const buildish = {
      ...request,
      messages: [
        { role: "user" as const, content: "A story about a fox." },
        { role: "user" as const, content: "Ok, build it" }
      ]
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      buildish,
      deterministicCreationTurn(buildish)
    );

    expect(patch.buildRequested).toBe(false);
    expect(patch.question?.prompt).toContain("end");
  });

  it("searches when the model calls web_search, grounds the answer, and stores structured sources", async () => {
    let searched = "";
    const research: ResearchAdapter = {
      async search(query) {
        searched = query.query;
        return groundedResearch.search(query);
      }
    };
    const model = toolModel(searchThenAnswer);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      request,
      deterministicCreationTurn(request)
    );

    expect(searched).toBe("latest credible scientific discovery 2026");
    // The second model call must see the tool result with the evidence.
    const secondCallMessages = model.calls[1]!.messages;
    const toolResult = secondCallMessages.find((message) => message.role === "tool");
    expect(toolResult?.content).toContain("NASA discovery brief");
    expect(toolResult?.toolName).toBe("web_search");
    expect(patch.assistantMessage).toContain("exoplanet");
    expect(patch.research?.sources[0]).toMatchObject({
      title: "NASA discovery brief",
      url: "https://science.nasa.gov/example"
    });
  });

  it("keeps ordinary chat to one model call without searching", async () => {
    let searches = 0;
    const research: ResearchAdapter = {
      async search(query) {
        searches += 1;
        return groundedResearch.search(query);
      }
    };
    const model = toolModel([
      {
        finish: {
          assistantMessage: "Lovely. What mood should the story have?",
          question: { prompt: "What mood should the story have?", options: ["Cozy", "Funny"], allowCustom: true }
        }
      }
    ]);
    const normalRequest: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "A bedtime story about a fox" }]
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      normalRequest,
      deterministicCreationTurn(normalRequest)
    );

    expect(model.calls).toHaveLength(1);
    expect(searches).toBe(0);
    expect(patch.research).toBeUndefined();
    expect(patch.assistantMessage).toContain("mood");
  });

  it("honors a non-English search request from the model", async () => {
    let searches = 0;
    const nonEnglish: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "\u0644\u0637\u0641\u0627\u064b \u062c\u062f\u06cc\u062f\u062a\u0631\u06cc\u0646 \u06a9\u0634\u0641 \u0639\u0644\u0645\u06cc \u0631\u0627 \u0628\u0631\u0627\u06cc\u0645 \u067e\u06cc\u062f\u0627 \u06a9\u0646" }]
    };
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "\u062c\u062f\u06cc\u062f\u062a\u0631\u06cc\u0646 \u06a9\u0634\u0641 \u0639\u0644\u0645\u06cc \u0645\u0639\u062a\u0628\u0631 \u06f2\u06f0\u06f2\u06f6" } }] },
      { finish: { assistantMessage: "\u06cc\u06a9 \u06a9\u0634\u0641 \u062a\u0627\u0632\u0647 \u0648 \u0645\u0633\u062a\u0646\u062f \u067e\u06cc\u062f\u0627 \u06a9\u0631\u062f\u0645.", question: null } }
    ]);
    const research: ResearchAdapter = {
      async search(query) {
        searches += 1;
        expect(query.query).toContain("\u06a9\u0634\u0641 \u0639\u0644\u0645\u06cc");
        return groundedResearch.search(query);
      }
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      nonEnglish,
      deterministicCreationTurn(nonEnglish)
    );

    expect(searches).toBe(1);
    expect(patch.research).toBeDefined();
  });

  it("keeps grounded evidence when the model fails after a successful search", async () => {
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "recent scientific discovery" } }] },
      { error: new Error("answer model unavailable") }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: groundedResearch },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toContain("nearby exoplanet");
    expect(patch.question).toBeNull();
    expect(patch.research?.sources[0]?.title).toBe("NASA discovery brief");
  });

  it("keeps grounded evidence when the follow-up model call times out", async () => {
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "recent scientific discovery" } }] },
      { hang: true }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: groundedResearch, answerTimeoutMs: 5 },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toContain("nearby exoplanet");
    expect(patch.question).toBeNull();
    expect(patch.research?.sources[0]?.title).toBe("NASA discovery brief");
  });

  it("does not retry timed-out searches, avoiding duplicate provider work", async () => {
    let searches = 0;
    const research: ResearchAdapter = {
      search() {
        searches += 1;
        return new Promise<never>(() => undefined);
      }
    };
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "recent scientific discovery" } }] },
      { finish: { assistantMessage: "", question: null } }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research, searchTimeoutMs: 5 },
      request,
      deterministicCreationTurn(request)
    );

    expect(searches).toBe(1);
    expect(patch.assistantMessage).toMatch(/try again|narrow/i);
  });

  it("keeps a model-authored failure message in the conversation language", async () => {
    const nonEnglish: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "\u0644\u0637\u0641\u0627\u064b \u062c\u062f\u06cc\u062f\u062a\u0631\u06cc\u0646 \u06a9\u0634\u0641 \u0639\u0644\u0645\u06cc \u0631\u0627 \u0628\u0631\u0627\u06cc\u0645 \u067e\u06cc\u062f\u0627 \u06a9\u0646" }]
    };
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "\u062c\u062f\u06cc\u062f\u062a\u0631\u06cc\u0646 \u06a9\u0634\u0641 \u0639\u0644\u0645\u06cc" } }] },
      { finish: { assistantMessage: "\u062c\u0633\u062a\u062c\u0648 \u0627\u0644\u0627\u0646 \u06a9\u0627\u0645\u0644 \u0646\u0634\u062f\u061b \u062f\u0648\u0628\u0627\u0631\u0647 \u062a\u0644\u0627\u0634 \u06a9\u0646\u06cc\u062f \u06cc\u0627 \u0645\u0648\u0636\u0648\u0639 \u0631\u0627 \u062f\u0642\u06cc\u0642\u200c\u062a\u0631 \u06a9\u0646\u06cc\u062f.", question: null } }
    ]);
    const research: ResearchAdapter = {
      search: () => Promise.reject(new Error("search unavailable"))
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      nonEnglish,
      deterministicCreationTurn(nonEnglish)
    );

    expect(patch.assistantMessage).toContain("\u062c\u0633\u062a\u062c\u0648 \u0627\u0644\u0627\u0646 \u06a9\u0627\u0645\u0644 \u0646\u0634\u062f");
    expect(patch.question).toBeNull();
    // The failed search must be reported to the model as a tool error result.
    const toolResult = model.calls[1]!.messages.find((message) => message.role === "tool");
    expect(toolResult?.content).toContain("failed");
  });

  it("uses hardcoded recovery when the model returns an empty answer after a failed search", async () => {
    const research: ResearchAdapter = {
      search: () => Promise.reject(new Error("search unavailable"))
    };
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "recent scientific discovery" } }] },
      { finish: { assistantMessage: "", question: null } }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toMatch(/try again|narrow/i);
    expect(patch.assistantMessage).not.toMatch(/can't browse|cannot browse/i);
    expect(patch.question).toBeNull();
  });

  it("uses the grounded summary when the model finishes with an empty answer", async () => {
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "recent scientific discovery" } }] },
      { finish: { assistantMessage: "", question: null } }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: groundedResearch },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toContain("nearby exoplanet");
    expect(patch.research).toBeDefined();
  });

  it("recovers a finish payload the model emitted as plain text", async () => {
    const model = toolModel([
      { text: JSON.stringify({ assistantMessage: "Here is a plain-text finish.", question: null }) }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toBe("Here is a plain-text finish.");
  });

  it("nudges once when the model chats in plain text, then accepts the finish", async () => {
    const model = toolModel([
      { text: "Let me think about that." },
      { finish: { assistantMessage: "Done thinking - here is my reply.", question: null } }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.messages.at(-1)?.content).toContain("finish_turn");
    expect(patch.assistantMessage).toBe("Done thinking - here is my reply.");
  });

  it("feeds invalid finish arguments back to the model for repair", async () => {
    const model = toolModel([
      { finish: { assistantMessage: "x".repeat(1000), question: null } },
      { finish: { assistantMessage: "A corrected concise reply.", question: null } }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(model.calls).toHaveLength(2);
    const repairPrompt = model.calls[1]!.messages.at(-1);
    expect(repairPrompt?.role).toBe("tool");
    expect(repairPrompt?.content).toContain("Invalid finish_turn arguments");
    expect(patch.assistantMessage).toBe("A corrected concise reply.");
  });

  it("bounds the first model call before any search starts", async () => {
    const model = toolModel([{ hang: true }]);

    await expect(
      enrichCreationTurnWithSearch(
        { textModel: model, research: groundedResearch, classificationTimeoutMs: 5 },
        request,
        deterministicCreationTurn(request)
      )
    ).rejects.toThrow(/creation turn request timed out/i);
  });

  it("falls back to the deterministic turn when the outer budget expires", async () => {
    const turn = await runCreationTurn(request, {
      enrich: () => new Promise<never>(() => undefined),
      timeoutMs: 5
    });

    expect(turn.assistantMessage.length).toBeGreaterThan(0);
  });
});

describe("briefForMobilePayload", () => {
  it("builds a brief from a chat whose combined user text exceeds the topic cap", () => {
    // Regression: rawIdea joins every user message; a long interview made
    // the strict 280-char topic parse throw and the build endpoint 500.
    const longIdea = `Write a 4 page romantic story about Parsa and Natalia. ${"They meet in a quiet library on a rainy afternoon and slowly fall in love over shared books and long conversations. ".repeat(3)}`.trim();
    const payload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: longIdea,
      messages: [{ role: "user", content: longIdea }]
    });

    const brief = briefForMobilePayload(payload);

    expect(longIdea.length).toBeGreaterThan(280);
    expect(brief.topic).toBeDefined();
    expect(brief.topic!.length).toBeLessThanOrEqual(280);
    expect(brief.topic).toMatch(/^Write a 4 page romantic story about Parsa and Natalia/);
    expect(brief.topic).not.toMatch(/\s$/);
  });
});

describe("mobile creation title selection", () => {
  it("does not promote rough ideas, recipe titles, or advisor suggestions into project titles", () => {
    const payload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: "I want to create a similar story to the Rabit and Turtle race",
      messages: [{ role: "user", content: "I want to create a similar story to the Rabit and Turtle race" }]
    });
    const advisor = deterministicAdvisor(payload);

    expect(
      titleForMobilePayload(payload, {
        ...advisor,
        recipe: { ...advisor.recipe, title: "I Want To Create A Similar" },
        titleSuggestions: ["I Want To Create A Similar"]
      })
    ).toBeUndefined();
  });

  it("uses only explicit mobile title declarations", () => {
    const optionalTitlePayload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: "Story about a careful race.",
      optionalDetails: { title: "The Meadow Finish" },
      messages: [{ role: "user", content: "Story about a careful race." }]
    });
    const chatTitlePayload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: "I want a short story.\nTitle: Slow Steps Home",
      messages: [{ role: "user", content: "I want a short story.\nTitle: Slow Steps Home" }]
    });

    expect(titleForMobilePayload(optionalTitlePayload, deterministicAdvisor(optionalTitlePayload))).toBe("The Meadow Finish");
    expect(titleForMobilePayload(chatTitlePayload, deterministicAdvisor(chatTitlePayload))).toBe("Slow Steps Home");
  });
});

describe("creation chat attachments", () => {
  const pricingDoc = {
    id: "att_doc1",
    kind: "document" as const,
    name: "pricing-notes.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    summary: "A short guide to value-based pricing for consultants.",
    content: "Value-based pricing beats hourly billing. Anchor high, offer three tiers, and never discount without removing scope.",
    truncated: false,
    pages: 3,
    createdAt: "2026-07-06T00:00:00.000Z"
  };

  it("acknowledges a document sent with the latest message and treats it as substance", () => {
    const turn = deterministicCreationTurn({
      messages: [
        {
          role: "user",
          content: "",
          attachments: [{ id: pricingDoc.id, kind: "document", name: pricingDoc.name }]
        }
      ],
      attachments: [pricingDoc]
    });

    expect(turn.assistantMessage).toContain("pricing-notes.pdf");
    expect(turn.assistantMessage).toContain("source material");
    // The upload counts as usable input, but the deterministic fallback does
    // not guess whether a semantic clarification is needed.
    expect(turn.question).toBeNull();
    expect(turn.readiness.canBuild).toBe(true);
  });

  it("acknowledges a photo differently from a document", () => {
    const turn = deterministicCreationTurn({
      messages: [
        {
          role: "user",
          content: "Use this as inspiration",
          attachments: [{ id: "att_p1", kind: "photo", name: "garden.jpg" }]
        }
      ],
      attachments: [
        {
          ...pricingDoc,
          id: "att_p1",
          kind: "photo",
          name: "garden.jpg",
          summary: "A photo of a wild garden at dusk.",
          content: "A wild garden at dusk with a stone path and fireflies."
        }
      ]
    });

    expect(turn.assistantMessage).toContain("I've looked at garden.jpg");
  });

  it("counts attachments toward build readiness scoring like source notes", () => {
    const withAttachment = deterministicCreationTurn({
      messages: [{ role: "user", content: "A pricing guide for consultants" }],
      attachments: [pricingDoc]
    });
    const withoutAttachment = deterministicCreationTurn({
      messages: [{ role: "user", content: "A pricing guide for consultants" }]
    });

    expect(withAttachment.readiness.score).toBeGreaterThan(withoutAttachment.readiness.score);
  });

  it("budgets per-turn attachment excerpts newest-first", () => {
    const big = (id: string, name: string) => ({
      ...pricingDoc,
      id,
      name,
      content: "x".repeat(6000)
    });
    const context = attachmentContextForTurn([
      big("att_1", "first.pdf"),
      big("att_2", "second.pdf"),
      big("att_3", "third.pdf"),
      big("att_4", "fourth.pdf")
    ]);

    expect(context.map((entry) => entry.name)).toEqual(["first.pdf", "second.pdf", "third.pdf", "fourth.pdf"]);
    const totalExcerpt = context.reduce((total, entry) => total + entry.excerpt.length, 0);
    expect(totalExcerpt).toBeLessThanOrEqual(7500);
    // Newest files keep their excerpts; the oldest is summary-only when the budget runs out.
    expect(context.at(-1)!.excerpt.length).toBeGreaterThan(0);
    expect(context[0]!.excerpt.length).toBe(0);
    expect(context[0]!.summary.length).toBeGreaterThan(0);
  });

  it("answers upload capability questions deterministically", () => {
    expect(metaAnswerForMessage("Can I upload a PDF?")).toContain("paperclip");
    expect(metaAnswerForMessage("how do I attach a photo?")).toContain("paperclip");
  });

  it("references uploaded files in the project prompt without inlining their content", () => {
    const payload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: "A pricing guide for consultants",
      messages: [{ role: "user", content: "A pricing guide for consultants" }],
      attachments: [pricingDoc]
    });
    const prompt = composeMobileProjectPrompt(payload, deterministicAdvisor(payload));

    expect(prompt).toContain("pricing-notes.pdf");
    expect(prompt).toContain("uploaded file");
    expect(prompt).not.toContain("Anchor high");
  });

  it("keeps attachments in the payload schema and allows attachment-only messages", () => {
    const payload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      messages: [
        {
          role: "user",
          content: "",
          attachments: [{ id: "att_doc1", kind: "document", name: "pricing-notes.pdf" }]
        }
      ],
      attachments: [pricingDoc]
    });

    expect(payload.attachments?.[0]?.name).toBe("pricing-notes.pdf");
    expect(payload.messages?.[0]?.attachments?.[0]?.id).toBe("att_doc1");
    expect(() =>
      mobileCreationDraftPayloadSchema.parse({
        payloadVersion: 3,
        messages: [{ role: "user", content: "" }]
      })
    ).toThrow();
  });
});

describe("composed project prompt budget", () => {
  // A chat that ran a web search on every assistant turn, each result stored at
  // its schema maximum: a 4000-char summary and six 700-char sources.
  const researchHeavy = mobileCreationDraftPayloadSchema.parse({
    payloadVersion: 3,
    rawIdea: "R".repeat(2000),
    messages: Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0
        ? { role: "user", content: `Turn ${index}: ${"detail ".repeat(80)}` }
        : {
            role: "assistant",
            content: `Answer ${index}`,
            research: {
              query: "q".repeat(600),
              summary: "s".repeat(4000),
              sources: Array.from({ length: 6 }, (_, n) => ({
                title: `Source ${n}`,
                url: `https://example.com/${n}`,
                summary: "e".repeat(700)
              }))
            }
          }
    )
  });

  it("keeps a research-heavy chat inside the project prompt ceiling", () => {
    const prompt = composeMobileProjectPrompt(researchHeavy, deterministicAdvisor(researchHeavy));

    // The build route hands this straight to buildMobileCreateProjectInput, so
    // a prompt over the cap threw a ZodError and reached the app as a 500.
    expect(
      mobileComposedProjectCreateSchema.safeParse({
        bookType: "lead_magnet",
        prompt
      }).success
    ).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(COMPOSED_PROJECT_PROMPT_MAX);
    // Headroom has to survive for the worker's source-material injection.
    expect(COMPOSED_PROJECT_PROMPT_MAX).toBeLessThan(PROJECT_PROMPT_MAX_LENGTH);
    // Trimming shortens the evidence; it never drops the sections themselves.
    expect(prompt).toContain("Original idea");
    expect(prompt).toContain("Creation chat");
    expect(prompt).toContain("Untrusted web evidence");
  });
});

describe("creation chat branch isolation", () => {
  // Mirrors an edited first message: the original (m1/m2) is an abandoned
  // sibling branch; the corrected thread is m3 onward.
  const branched = mobileCreationDraftPayloadSchema.parse({
    payloadVersion: 3,
    rawIdea: "A romance about a Persian man and a Brazilian woman fighting for a halal marriage",
    messages: [
      { id: "m0", parentId: null, isActiveChild: true, role: "assistant", content: "Hi! Tell me about the book you want to make." },
      {
        id: "m1",
        parentId: "m0",
        isActiveChild: false,
        role: "user",
        content: "A romance about a Persian man and an Iranian woman. Make it 200 pages.\nTitle: Wrong Turn"
      },
      { id: "m2", parentId: "m1", isActiveChild: true, role: "assistant", content: "Lovely idea! A Persian man and an Iranian woman. Who should read it?" },
      { id: "m3", parentId: "m0", isActiveChild: true, role: "user", content: "A romance about a Persian man and a Brazilian woman" },
      { id: "m4", parentId: "m3", isActiveChild: true, role: "assistant", content: "Lovely idea! A Persian man and a Brazilian woman. Who should read it?" },
      { id: "m5", parentId: "m4", isActiveChild: true, role: "user", content: "Young adults" }
    ]
  });

  it("keeps edited-away branches out of the project prompt", () => {
    const prompt = composeMobileProjectPrompt(branched, deterministicAdvisor(branched));

    expect(prompt).toContain("Brazilian woman");
    expect(prompt).not.toContain("Iranian woman");
  });

  it("ignores titles and page counts that only exist in edited-away branches", () => {
    expect(titleForMobilePayload(branched, deterministicAdvisor(branched))).toBeUndefined();
    expect(explicitTargetPagesForMobilePayload(branched)).toBeUndefined();
  });

  it("keeps edited-away web research out of the project prompt", () => {
    const branchedWithResearch = mobileCreationDraftPayloadSchema.parse({
      ...branched,
      messages: branched.messages?.map((message) =>
        message.id === "m2"
          ? {
              ...message,
              research: {
                query: "wrong branch research",
                summary: "This abandoned evidence must not be used.",
                sources: [
                  {
                    title: "Wrong source",
                    url: "https://example.com/wrong",
                    summary: "Wrong branch only."
                  }
                ]
              }
            }
          : message.id === "m4"
            ? {
                ...message,
                research: {
                  query: "Brazilian romance research",
                  summary: "Active evidence for the corrected branch.",
                  sources: [
                    {
                      title: "Active source",
                      url: "https://example.com/active",
                      summary: "Correct branch evidence."
                    }
                  ]
                }
              }
            : message
      )
    });

    const prompt = composeMobileProjectPrompt(branchedWithResearch, deterministicAdvisor(branchedWithResearch));

    expect(prompt).toContain("Active source");
    expect(prompt).not.toContain("Wrong source");
    expect(prompt).toContain("Untrusted web evidence");
  });

  it("sends only the active thread to the AI advisor enrichment", async () => {
    let enrichedMessages: string | undefined;
    await adviseMobileBook(branched, {
      enrich: async (payload) => {
        enrichedMessages = JSON.stringify(payload.messages ?? []);
        return {};
      }
    });

    expect(enrichedMessages).toBeDefined();
    expect(enrichedMessages).toContain("Brazilian woman");
    expect(enrichedMessages).not.toContain("Iranian woman");
  });
});
