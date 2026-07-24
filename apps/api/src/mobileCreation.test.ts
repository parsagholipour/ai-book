import { describe, expect, it } from "vitest";
import type { TextModelAdapter } from "@book-maker/core";
import {
  adviseMobileBook,
  attachmentContextForTurn,
  briefForMobilePayload,
  composeMobileProjectPrompt,
  detectMessageLanguage,
  deterministicAdvisor,
  explicitTargetPagesForMobilePayload,
  deterministicCreationTurn,
  enrichCreationTurnWithAi,
  enrichCreationTurnWithSearch,
  explicitWebSearchQuery,
  greetingCreationTurn,
  isBuildRequestMessage,
  metaAnswerForMessage,
  mobileCreationDraftPayloadSchema,
  runCreationTurn,
  titleForMobilePayload,
  type MobileCreationTurnRequest
} from "./mobileCreation.js";
import type { ResearchAdapter } from "@book-maker/core";

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
      imagesEnabled: true
    }
  };

  it("greeting turn invites the user without allowing a build yet", () => {
    const turn = greetingCreationTurn();

    expect(turn.readiness.canBuild).toBe(false);
    expect(turn.quickReplies.length).toBeGreaterThan(0);
    expect(turn.question).toBeNull();
    expect(turn.assistantMessage.length).toBeGreaterThan(0);
  });

  it("keeps Auto unresolved during creation chat", async () => {
    const turn = await runCreationTurn(autoRequest);

    expect(turn.detectedLane).toBe("auto");
    expect(turn.brief.lane).toBe("auto");
    expect(turn.presets.bookTypeChoice).toBe("auto");
    expect(turn.readiness.canBuild).toBe(true);
    // The audience ("5 year olds") is already in the idea, so the adaptive
    // interviewer skips it and asks about the next real gap instead.
    expect(turn.assistantMessage).toBe("Got it. What should the book feel like?");
    expect(deterministicCreationTurn(autoRequest).detectedLane).toBe("auto");
  });

  it("keeps a rabbit and turtle race unresolved while book type is Auto", () => {
    const turn = deterministicCreationTurn({
      messages: [{ role: "user", content: "Make a 4 page book of rabbit and turtle race" }],
      presets: {
        bookType: "lead_magnet",
        bookTypeChoice: "auto",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true
      }
    });

    expect(turn.detectedLane).toBe("auto");
    expect(turn.presets.bookType).toBe("lead_magnet");
    expect(turn.presets.bookTypeChoice).toBe("auto");
    expect(turn.assistantMessage).not.toContain("practical guide");
    expect(turn.question?.prompt).toBe("Who is this book for?");
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
        imagesEnabled: true
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
        imagesEnabled: true
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
        imagesEnabled: true
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

  it("applies chat settings changes like disabling images with an acknowledgement", () => {
    const turn = deterministicCreationTurn({
      messages: [
        { role: "user", content: "A guide to sourdough baking for beginners" },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "No images please" }
      ],
      presets: {
        bookType: "lead_magnet",
        bookTypeChoice: "auto",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true
      }
    });

    expect(turn.presets.imagesEnabled).toBe(false);
    expect(turn.assistantMessage).toMatch(/text-first|no images/i);
  });

  it("detects the message language and carries it on the turn", () => {
    expect(detectMessageLanguage("یک کتاب داستان برای کودکان درباره دوستی")).toBe("fa");
    expect(detectMessageLanguage("Сказка на ночь для детей")).toBe("ru");
    expect(detectMessageLanguage("A bedtime story about a fox")).toBeUndefined();

    const turn = deterministicCreationTurn({
      messages: [{ role: "user", content: "یک کتاب داستان برای کودکان درباره دوستی و مهربانی" }]
    });
    expect(turn.language).toBe("fa");
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
        assistantMessage: "Ótima ideia. Para quem é este livro?",
        question: {
          prompt: "Para quem é este livro?",
          options: ["Jovens adultos", "Leitores de romance", "Público geral"],
          allowCustom: true
        }
      })
    });

    expect(turn.question?.prompt).toBe("Para quem é este livro?");
    expect(turn.quickReplies).toEqual([]);
    expect(turn.readiness.missing).toEqual(["Para quem é este livro"]);
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
    const fakeModel: TextModelAdapter = {
      async generateJson(options) {
        expect(
          options.schema.safeParse({
            assistantMessage: "Uma resposta sem estado de pergunta."
          }).success
        ).toBe(false);
        const raw = {
          assistantMessage: "A romance about Parsa and Natalia - lovely. Who is this story for?",
          question: {
            prompt: "Who should read Parsa and Natalia's story?",
            options: ["Romance readers", "Just the two of us"],
            allowCustom: true
          },
          bookLanguage: "fa",
          extraneous: "ignored",
          brief: null,
          buildRequested: false
        };
        return {
          data: options.schema.parse(raw),
          text: JSON.stringify(raw),
          model: "fake",
          provider: "fake"
        };
      },
      generateText: () => Promise.reject(new Error("not used")),
      // eslint-disable-next-line require-yield
      streamText: async function* () {
        throw new Error("not used");
      }
    };

    const patch = await enrichCreationTurnWithAi(fakeModel, autoRequest, deterministicCreationTurn(autoRequest));

    expect(patch.assistantMessage).toContain("Parsa and Natalia");
    expect(patch.question?.prompt).toBe("Who should read Parsa and Natalia's story?");
    expect(patch.language).toBe("fa");
    expect(patch.brief).toBeUndefined();
  });
});



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

  function textModel(responses: Array<Record<string, unknown>>): TextModelAdapter {
    let index = 0;
    return {
      async generateJson(options) {
        const raw = responses[Math.min(index++, responses.length - 1)] ?? {};
        return {
          data: options.schema.parse(raw),
          text: JSON.stringify(raw),
          model: "fake",
          provider: "fake"
        };
      },
      generateText: () => Promise.reject(new Error("not used")),
      // eslint-disable-next-line require-yield
      streamText: async function* () {
        throw new Error("not used");
      }
    };
  }

  it("resolves the observed short request from recent conversation context", () => {
    const query = explicitWebSearchQuery(request.messages);

    expect(query).toContain("recent discovery");
    expect(query).toContain("Find it on the internet and tell me");
  });

  it("recognizes the observed latest-on-the-internet wording", () => {
    const query = explicitWebSearchQuery([
      { role: "user", content: "Make a scientific book about a recent discovery" },
      { role: "assistant", content: "What is the most exciting thing readers should take away?" },
      { role: "user", content: "Find the latest on the internet" }
    ]);

    expect(query).toContain("recent discovery");
    expect(query).toContain("Find the latest on the internet");
    expect(explicitWebSearchQuery([{ role: "user", content: "Find the latest chapter" }])).toBeUndefined();
  });

  it("keeps the latest request and original topic when recent context is long", () => {
    const query = explicitWebSearchQuery([
      { role: "user", content: "Make a scientific book about a recent discovery" },
      { role: "assistant", content: "A".repeat(700) },
      { role: "user", content: "B".repeat(700) },
      { role: "assistant", content: "C".repeat(700) },
      { role: "user", content: "Find the latest on the internet" }
    ]);

    expect(query).toContain("Find the latest on the internet");
    expect(query).toContain("recent discovery");
    expect(query!.length).toBeLessThanOrEqual(600);
  });

  it("does not browse for negated, narrative, or attachment-local search mentions", () => {
    expect(
      explicitWebSearchQuery([{ role: "user", content: "Don't search the internet; make it fictional" }])
    ).toBeUndefined();
    expect(
      explicitWebSearchQuery([{ role: "user", content: "My story is about the search for a missing child" }])
    ).toBeUndefined();
    expect(
      explicitWebSearchQuery([{ role: "user", content: "Search is the title of my story" }])
    ).toBeUndefined();
    expect(
      explicitWebSearchQuery([{ role: "user", content: "Search for Tomorrow is the title of my story" }])
    ).toBeUndefined();
    expect(
      explicitWebSearchQuery([{ role: "user", content: "Browse for Trouble is my chapter title" }])
    ).toBeUndefined();
    expect(
      explicitWebSearchQuery([{ role: "user", content: "Google It is the title of my book" }])
    ).toBeUndefined();
    expect(
      explicitWebSearchQuery([{ role: "user", content: "Find information in my uploaded document" }])
    ).toBeUndefined();
    expect(
      explicitWebSearchQuery([{ role: "user", content: "Find it in the attached PDF" }])
    ).toBeUndefined();
  });

  it("takes the direct search path for latest-on-the-internet requests", async () => {
    let modelCalls = 0;
    let searches = 0;
    const latestRequest: MobileCreationTurnRequest = {
      messages: [
        { role: "user", content: "Make a scientific book about a recent discovery" },
        { role: "assistant", content: "What is the most exciting thing readers should take away?" },
        { role: "user", content: "Find the latest on the internet" }
      ]
    };
    const model: TextModelAdapter = {
      ...textModel([]),
      async generateJson(options) {
        modelCalls += 1;
        const raw = {
          assistantMessage: "A newly characterized exoplanet is a strong current topic.",
          question: null
        };
        return { data: options.schema.parse(raw), text: JSON.stringify(raw), model: "fake", provider: "fake" };
      }
    };
    const research: ResearchAdapter = {
      async search(query) {
        searches += 1;
        expect(query.query).toContain("recent discovery");
        return groundedResearch.search(query);
      }
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      latestRequest,
      deterministicCreationTurn(latestRequest)
    );

    expect(searches).toBe(1);
    expect(modelCalls).toBe(1);
    expect(patch.research).toBeDefined();
  });

  it("searches, grounds the answer, and stores structured sources", async () => {
    let searched = "";
    let finalPrompt = "";
    const research: ResearchAdapter = {
      async search(query) {
        searched = query.query;
        return groundedResearch.search(query);
      }
    };
    const model: TextModelAdapter = {
      ...textModel([]),
      async generateJson(options) {
        finalPrompt = options.messages.at(-1)?.content ?? "";
        const raw = {
          assistantMessage: "A promising option is a newly characterized nearby exoplanet.",
          question: {
            prompt: "Should the book focus on how it was detected or why it matters?",
            options: ["How it was detected", "Why it matters"],
            allowCustom: true
          }
        };
        return {
          data: options.schema.parse(raw),
          text: JSON.stringify(raw),
          model: "fake",
          provider: "fake"
        };
      }
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      request,
      deterministicCreationTurn(request)
    );

    expect(searched).toContain("recent discovery");
    expect(finalPrompt).toContain("webResearch");
    expect(finalPrompt).toContain("NASA discovery brief");
    expect(patch.assistantMessage).toContain("exoplanet");
    expect(patch.research?.sources[0]).toMatchObject({
      title: "NASA discovery brief",
      url: "https://science.nasa.gov/example"
    });
  });

  it("keeps ordinary chat to one enrichment call without searching", async () => {
    let modelCalls = 0;
    let searches = 0;
    const model: TextModelAdapter = {
      ...textModel([]),
      async generateJson(options) {
        modelCalls += 1;
        const raw = {
          assistantMessage: "Lovely. What mood should the story have?",
          question: {
            prompt: "What mood should the story have?",
            options: ["Cozy", "Funny"],
            allowCustom: true
          }
        };
        return { data: options.schema.parse(raw), text: JSON.stringify(raw), model: "fake", provider: "fake" };
      }
    };
    const research: ResearchAdapter = {
      async search(query) {
        searches += 1;
        return groundedResearch.search(query);
      }
    };
    const normalRequest: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "A bedtime story about a fox" }]
    };

    await enrichCreationTurnWithSearch(
      { textModel: model, research },
      normalRequest,
      deterministicCreationTurn(normalRequest)
    );

    expect(modelCalls).toBe(1);
    expect(searches).toBe(0);
  });

  it("honors a model-detected non-English search request", async () => {
    let searches = 0;
    const nonEnglish: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "لطفاً جدیدترین کشف علمی را برایم پیدا کن" }]
    };
    const model = textModel([
      {
        assistantMessage: "جستجو می‌کنم.",
        question: null,
        webSearchQuery: "جدیدترین کشف علمی معتبر ۲۰۲۶"
      },
      {
        assistantMessage: "یک کشف تازه و مستند پیدا کردم.",
        question: null
      }
    ]);
    const research: ResearchAdapter = {
      async search(query) {
        searches += 1;
        expect(query.query).toContain("کشف علمی");
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

  it("keeps grounded evidence when final answer synthesis fails", async () => {
    const model: TextModelAdapter = {
      generateJson: () => Promise.reject(new Error("answer model unavailable")),
      generateText: () => Promise.reject(new Error("not used")),
      // eslint-disable-next-line require-yield
      streamText: async function* () {
        throw new Error("not used");
      }
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: groundedResearch },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toContain("nearby exoplanet");
    expect(patch.question).toBeNull();
    expect(patch.research?.sources[0]?.title).toBe("NASA discovery brief");
  });

  it("keeps grounded evidence when final answer synthesis times out", async () => {
    const model: TextModelAdapter = {
      generateJson: () => new Promise<never>(() => undefined),
      generateText: () => Promise.reject(new Error("not used")),
      // eslint-disable-next-line require-yield
      streamText: async function* () {
        throw new Error("not used");
      }
    };

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

    const patch = await enrichCreationTurnWithSearch(
      { textModel: textModel([]), research, searchTimeoutMs: 5 },
      request,
      deterministicCreationTurn(request)
    );

    expect(searches).toBe(1);
    expect(patch.assistantMessage).toMatch(/try again|narrow/i);
  });

  it("uses the grounded summary when synthesis returns an empty answer", async () => {
    const model = textModel([{ assistantMessage: "", question: null }]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: groundedResearch },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toContain("nearby exoplanet");
    expect(patch.research).toBeDefined();
  });

  it("keeps model-detected search failure recovery in the conversation language", async () => {
    const nonEnglish: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "لطفاً جدیدترین کشف علمی را برایم پیدا کن" }]
    };
    const model = textModel([
      {
        assistantMessage: "جستجو می‌کنم.",
        question: null,
        webSearchQuery: "جدیدترین کشف علمی معتبر ۲۰۲۶",
        webSearchFailureMessage: "جستجو الان کامل نشد؛ دوباره تلاش کنید یا موضوع را دقیق‌تر کنید."
      },
      { assistantMessage: "", question: null }
    ]);
    const research: ResearchAdapter = {
      search: () => Promise.reject(new Error("search unavailable"))
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      nonEnglish,
      deterministicCreationTurn(nonEnglish)
    );

    expect(patch.assistantMessage).toContain("جستجو الان کامل نشد");
    expect(patch.question).toBeNull();
  });

  it("uses hardcoded recovery when failure synthesis returns an empty answer", async () => {
    const research: ResearchAdapter = {
      search: () => Promise.reject(new Error("search unavailable"))
    };
    const model = textModel([{ assistantMessage: "", question: null }]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toMatch(/try again|narrow/i);
    expect(patch.question).toBeNull();
  });

  it("bounds model-detected search classification before search starts", async () => {
    const nonEnglish: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "لطفاً جدیدترین کشف علمی را برایم پیدا کن" }]
    };
    const model: TextModelAdapter = {
      generateJson: () => new Promise<never>(() => undefined),
      generateText: () => Promise.reject(new Error("not used")),
      // eslint-disable-next-line require-yield
      streamText: async function* () {
        throw new Error("not used");
      }
    };

    await expect(
      enrichCreationTurnWithSearch(
        { textModel: model, research: groundedResearch, classificationTimeoutMs: 5 },
        nonEnglish,
        deterministicCreationTurn(nonEnglish)
      )
    ).rejects.toThrow(/classification request timed out/i);
  });

  it("returns a search-specific recovery turn when the outer budget expires", async () => {
    const latestRequest: MobileCreationTurnRequest = {
      messages: [
        { role: "user", content: "Make a scientific book about a recent discovery" },
        { role: "assistant", content: "What should readers learn?" },
        { role: "user", content: "Find the latest on the internet" }
      ]
    };

    const turn = await runCreationTurn(latestRequest, {
      enrich: () => new Promise<never>(() => undefined),
      timeoutMs: 5
    });

    expect(turn.assistantMessage).toMatch(/couldn't complete that search/i);
    expect(turn.question).toBeNull();
    expect(turn.quickReplies).toContain("Try the search again");
  });

  it("returns a recoverable answer when search is unavailable", async () => {
    const research: ResearchAdapter = {
      async search() {
        throw new Error("search unavailable");
      }
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: textModel([]), research },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toMatch(/try again|narrow/i);
    expect(patch.assistantMessage).not.toMatch(/can't browse|cannot browse/i);
    expect(patch.research).toBeUndefined();
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
    // The uploaded document counts as a real idea, so the interview starts.
    expect(turn.question).not.toBeNull();
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
