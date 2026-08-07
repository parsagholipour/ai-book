import { describe, expect, it } from "vitest";
import {
  creationTurnMessages,
  deterministicCreationTurn,
  runCreationTurn,
  type MobileCreationTurnRequest
} from "./mobileCreation.js";

describe("creation chat clarification policy", () => {
  it("keeps Auto unresolved and makes the deterministic fallback permissive", () => {
    const request: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "Bedtime story for 5 year olds" }]
    };
    const turn = deterministicCreationTurn(request);

    expect(turn.detectedLane).toBe("auto");
    expect(turn.brief.lane).toBe("auto");
    expect(turn.presets.bookTypeChoice).toBe("auto");
    expect(turn.readiness.canBuild).toBe(true);
    expect(turn.question).toBeNull();
    expect(turn.quickReplies).toContain("Build the plan");
  });

  it("preserves the model's structured clarification but still allows skipping it", async () => {
    const request: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "Write a story" }]
    };
    const turn = await runCreationTurn(request, {
      enrich: async () => ({
        assistantMessage: "I can shape that. What should the story be about?",
        question: {
          prompt: "What should the story be about?",
          answerKind: "choice",
          options: ["A person or hero", "An animal", "A magical adventure"],
          allowCustom: true
        }
      })
    });

    expect(turn.question).toEqual({
      prompt: "What should the story be about?",
      answerKind: "choice",
      options: ["A person or hero", "An animal", "A magical adventure"],
      allowCustom: true
    });
    // The question is optional: the app offers "Skip and build the plan".
    expect(turn.readiness.canBuild).toBe(true);
    expect(turn.readiness.missing).toEqual(["What should the story be about"]);
  });

  // The interviewer used to be told to attach 2-4 options to every question, so
  // "what name should go on the book?" came back with options describing how to
  // answer ("I'll write a Persian name"). Tapping one answered nothing and the
  // same question came back on the next turn.
  it("strips the options off a question whose answer only the user can supply", async () => {
    const turn = await runCreationTurn(
      { messages: [{ role: "user", content: "حکایتی مثل بوستان سعدی بنام من بساز" }] },
      {
        enrich: async () => ({
          assistantMessage: "نامی که روی کتاب درج شود چیست؟",
          question: {
            prompt: "نامی که روی کتاب درج شود چیست؟",
            answerKind: "open",
            options: ["یک نام فارسی می‌نویسم", "یک نام لاتین می‌نویسم", "همین‌جا می‌نویسم"],
            allowCustom: true
          }
        })
      }
    );

    expect(turn.question).toEqual({
      prompt: "نامی که روی کتاب درج شود چیست؟",
      answerKind: "open",
      options: [],
      allowCustom: true
    });
    // The prompt still reaches the app: only the fake answers are gone.
    expect(turn.readiness.missing).toEqual(["نامی که روی کتاب درج شود چیست؟"]);
    expect(turn.readiness.canBuild).toBe(true);
  });

  it("treats a single tappable answer as an open question", async () => {
    const turn = await runCreationTurn(
      { messages: [{ role: "user", content: "Write a story about my dog" }] },
      {
        enrich: async () => ({
          assistantMessage: "What is your dog's name?",
          question: {
            prompt: "What is your dog's name?",
            answerKind: "choice",
            options: ["I'll type it"],
            allowCustom: true
          }
        })
      }
    );

    expect(turn.question).toEqual({
      prompt: "What is your dog's name?",
      answerKind: "open",
      options: [],
      allowCustom: true
    });
  });

  // "Which of these themes?" is honestly answered by several options at once.
  // Declaring it keeps all six and lets the app send them together, instead of
  // the model listing them inside the prompt and asking for a typed answer.
  it("keeps a multi-answer question multi, with room for six options", async () => {
    const options = [
      "بخشش و گذشت",
      "صبر و بردباری",
      "عدالت و انصاف",
      "قناعت و ساده‌زیستی",
      "دوستی و وفاداری",
      "راستگویی و صداقت"
    ];
    const turn = await runCreationTurn(
      { messages: [{ role: "user", content: "حکایتی مثل بوستان سعدی بساز" }] },
      {
        enrich: async () => ({
          assistantMessage: "حکایت‌ها حول کدام موضوع اخلاقی باشند؟",
          question: {
            prompt: "حکایت‌ها حول کدام موضوع اخلاقی باشند؟",
            answerKind: "multi",
            options,
            allowCustom: true
          }
        })
      }
    );

    expect(turn.question).toEqual({
      prompt: "حکایت‌ها حول کدام موضوع اخلاقی باشند؟",
      answerKind: "multi",
      options,
      allowCustom: true
    });
  });

  it("accepts the model's null decision when the subject is concrete", async () => {
    const turn = await runCreationTurn(
      {
        messages: [{ role: "user", content: "Make a 4 page book of rabbit and turtle race" }]
      },
      {
        enrich: async () => ({
          assistantMessage: "The rabbit-and-turtle race is ready to plan.",
          question: null
        })
      }
    );

    expect(turn.question).toBeNull();
    expect(turn.readiness.canBuild).toBe(true);
  });

  it("preserves a multilingual model clarification without language-specific matching", async () => {
    const request: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "یک داستان بنویس" }]
    };
    const turn = await runCreationTurn(request, {
      enrich: async () => ({
        assistantMessage: "داستان درباره چه چیزی باشد؟",
        question: {
          prompt: "داستان درباره چه چیزی باشد؟",
          answerKind: "choice",
          options: ["یک قهرمان", "یک حیوان", "یک ماجراجویی"],
          allowCustom: true
        }
      })
    });

    expect(turn.question?.prompt).toBe("داستان درباره چه چیزی باشد؟");
    expect(turn.readiness.canBuild).toBe(true);
  });

  it("passes full context and the strict clarification contract to the model", () => {
    const request: MobileCreationTurnRequest = {
      messages: [
        { role: "user", content: "Use my uploaded notes for a practical guide." }
      ],
      conversationSummary: "The reader is a new consultant.",
      attachments: [
        {
          id: "notes-1",
          kind: "document",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 32,
          summary: "A three-step consulting framework.",
          content: "Discover, diagnose, deliver.",
          truncated: false,
          createdAt: "2026-08-02T00:00:00.000Z"
        }
      ]
    };
    const base = deterministicCreationTurn(request);
    const messages = creationTurnMessages(request, base);
    const systemPrompt = messages[0]?.content ?? "";
    const payload = JSON.parse(messages[1]!.content);

    expect(systemPrompt).toContain("complete conversation");
    expect(systemPrompt).toContain("Do not ask for optional preferences");
    expect(systemPrompt).toContain("required nullable question field is the authoritative");
    // Options are no longer mandatory: a value only the user knows is asked open.
    expect(systemPrompt).not.toContain("Use 2-4 short tappable options plus a custom answer");
    expect(systemPrompt).toContain('set answerKind to "open", leave options empty');
    expect(systemPrompt).toContain('Set answerKind to "multi" with up to 6 options');
    expect(systemPrompt).toContain("Never invent options that only describe how the user will answer");
    expect(systemPrompt).toContain("Never ask a follow-up that narrows a fact you already asked about");
    expect(payload.conversation).toEqual(request.messages);
    expect(payload.conversationSummary).toBe(request.conversationSummary);
    expect(payload.attachments[0]).toMatchObject({
      name: "notes.txt",
      summary: "A three-step consulting framework."
    });
  });
});
