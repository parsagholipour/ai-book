import { describe, expect, it } from "vitest";
import {
  composeMobileProjectPrompt,
  deterministicAdvisor,
  mobileCreationDraftPayloadSchema
} from "./mobileCreation.js";

// Replying to an earlier turn: the quote survives the payload schema and is
// annotated in the composed prompt rather than merged into the user's own line.
// Split out of mobileCreation.test.ts, which is at its size ceiling.

describe("creation chat replies", () => {
  const replied = mobileCreationDraftPayloadSchema.parse({
    payloadVersion: 3,
    rawIdea: "A bedtime story about a rabbit",
    messages: [
      { id: "m0", parentId: null, isActiveChild: true, role: "user", content: "A bedtime story about a rabbit" },
      {
        id: "m1",
        parentId: "m0",
        isActiveChild: true,
        role: "assistant",
        content: "I could make the rabbit a night watchman, or a dreamer who collects stars."
      },
      {
        id: "m2",
        parentId: "m1",
        isActiveChild: true,
        role: "user",
        content: "The second one",
        replyTo: {
          messageId: "m1",
          role: "assistant",
          excerpt: "I could make the rabbit a night watchman, or a dreamer who collects stars."
        }
      }
    ]
  });

  it("keeps replyTo through the payload schema", () => {
    expect(replied.messages?.[2]?.replyTo).toEqual({
      messageId: "m1",
      role: "assistant",
      excerpt: "I could make the rabbit a night watchman, or a dreamer who collects stars."
    });
  });

  it("annotates the quoted turn in the project prompt", () => {
    const prompt = composeMobileProjectPrompt(replied, deterministicAdvisor(replied));

    // Attributed to whoever said it rather than merged into the user's line,
    // so "the second one" is resolvable without the quote reading as the ask.
    expect(prompt).toContain('User (replying to the assistant: "I could make the rabbit');
    expect(prompt).toContain("User (replying to the assistant");
  });

  it("leaves an ordinary turn unannotated", () => {
    const prompt = composeMobileProjectPrompt(replied, deterministicAdvisor(replied));

    expect(prompt).toContain("User: A bedtime story about a rabbit");
  });
});
