import { describe, expect, it } from "vitest";
import {
  buildQuestionResponseMessage,
  normalizePlanQuestions,
  pruneQuestionResponses,
  type QuestionResponse
} from "./planQuestions.js";

describe("plan question helpers", () => {
  it("normalizes string and object questions", () => {
    expect(
      normalizePlanQuestions([
        "  Who is the narrator?  ",
        {
          question: "Choose a mood",
          options: ["Cozy", "Cozy", "  Epic  ", ""],
          allowCustom: false
        },
        {
          prompt: "Pick an ending",
          choices: [{ label: "Hopeful" }, { value: "Bittersweet" }]
        },
        null
      ])
    ).toEqual([
      {
        id: "0-who-is-the-narrator-",
        prompt: "Who is the narrator?",
        options: [],
        allowCustom: true
      },
      {
        id: "1-choose-a-mood",
        prompt: "Choose a mood",
        options: ["Cozy", "Epic"],
        allowCustom: false
      },
      {
        id: "2-pick-an-ending",
        prompt: "Pick an ending",
        options: ["Hopeful", "Bittersweet"],
        allowCustom: true
      }
    ]);
  });

  it("builds response messages with answered and skipped questions", () => {
    const questions = normalizePlanQuestions(["Favorite color?", "Avoid anything?"]);
    const responses: Record<string, QuestionResponse> = {
      [questions[0]!.id]: { status: "answered", answer: "Blue" },
      [questions[1]!.id]: { status: "skipped" }
    };

    expect(buildQuestionResponseMessage(questions, responses)).toBe(
      "Planning question responses:\n1. Favorite color?\nAnswer: Blue\nSkipped questions with no preference:\n- Avoid anything?"
    );
  });

  it("prunes responses for questions that are no longer present", () => {
    const questions = normalizePlanQuestions(["Still here?"]);
    expect(
      pruneQuestionResponses(questions, {
        [questions[0]!.id]: { status: "answered", answer: "Yes" },
        stale: { status: "answered", answer: "No" }
      })
    ).toEqual({
      [questions[0]!.id]: { status: "answered", answer: "Yes" }
    });
  });
});
