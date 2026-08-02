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

  it("preserves the model's structured clarification for an incomplete idea", async () => {
    const request: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "Write a story" }]
    };
    const turn = await runCreationTurn(request, {
      enrich: async () => ({
        assistantMessage: "I can shape that. What should the story be about?",
        question: {
          prompt: "What should the story be about?",
          options: ["A person or hero", "An animal", "A magical adventure"],
          allowCustom: true
        }
      })
    });

    expect(turn.question).toEqual({
      prompt: "What should the story be about?",
      options: ["A person or hero", "An animal", "A magical adventure"],
      allowCustom: true
    });
    expect(turn.readiness.canBuild).toBe(false);
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
          options: ["یک قهرمان", "یک حیوان", "یک ماجراجویی"],
          allowCustom: true
        }
      })
    });

    expect(turn.question?.prompt).toBe("داستان درباره چه چیزی باشد؟");
    expect(turn.readiness.canBuild).toBe(false);
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
    expect(payload.conversation).toEqual(request.messages);
    expect(payload.conversationSummary).toBe(request.conversationSummary);
    expect(payload.attachments[0]).toMatchObject({
      name: "notes.txt",
      summary: "A three-step consulting framework."
    });
  });
});
