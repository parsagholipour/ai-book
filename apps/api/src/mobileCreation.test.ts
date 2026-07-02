import { describe, expect, it } from "vitest";
import {
  detectMessageLanguage,
  deterministicAdvisor,
  deterministicCreationTurn,
  greetingCreationTurn,
  isBuildRequestMessage,
  metaAnswerForMessage,
  mobileCreationDraftPayloadSchema,
  runCreationTurn,
  titleForMobilePayload,
  type MobileCreationTurnRequest
} from "./mobileCreation.js";

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
