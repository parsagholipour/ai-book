import { describe, expect, it } from "vitest";
import { PROJECT_PROMPT_MAX_LENGTH } from "@book-maker/core";
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
          answerKind: "choice",
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
    // "Original idea" is deliberately absent: it is the join of the same user
    // messages the transcript already prints, so with a transcript present it
    // only paid the ceiling twice for one intent.
    expect(prompt).not.toContain("Original idea");
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
