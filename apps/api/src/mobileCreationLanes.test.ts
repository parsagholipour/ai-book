import { describe, expect, it } from "vitest";
import { audienceFor, promiseFallback } from "./mobileCreationLanes.js";
import { completeRecipe } from "./mobileCreationAdvisor.js";
import { mobileCreationLaneSchema, type MobileCreationDraftPayload } from "./mobileCreationSchemas.js";

const guide =
  "I want a practical guide for new first-time managers on running genuinely useful one-on-one meetings with their direct reports: how to structure them, what questions to ask, how to give feedback, handle difficult conversations, and track follow-ups. Around 24 pages.";

describe("the fallback brief of a draft the model did not fill in", () => {
  it("names the reader the idea names and stops where the reader ends", () => {
    // Printed whole, up to the first comma, as a Quick Draft guide's audience (2026-09-30).
    expect(audienceFor(guide)).toBe("new first-time managers");
    expect(audienceFor("A money workbook for freelancers with irregular income: how to budget when paychecks vary.")).toBe("freelancers with irregular income");
    expect(audienceFor("A bedtime story for 5 year olds about a sleepy fox")).toBe("5 year olds");
    // The parent-voiced suggestion chip, hyphenated the way a parent writes it.
    expect(audienceFor("A bedtime story for my 5-year-old")).toBe("5-year-old");
  });

  it("skips a purpose for the reader behind it, and answers nothing when no reader is named", () => {
    const history = "Write a nonfiction book about what the shipping container means for supply chains today. About 28 pages, for curious general readers.";
    expect(audienceFor(history)).toBe("curious general readers");
    expect(audienceFor("A story about a fox looking for her mother")).toBe("");
    expect(audienceFor("کتابی درباره مدیریت زمان")).toBe("");
  });

  it("promises what the lane promises, never a span of the idea", () => {
    for (const lane of mobileCreationLaneSchema.options) {
      const promise = promiseFallback(lane);
      expect(promise.length).toBeGreaterThan(10);
      expect(promise).not.toMatch(/\bi want\b|,\s*what\b/i);
    }
  });

  it("builds a brief from the idea with no junk in it, and lets the stated audience speak when the idea names none", () => {
    const payload = { rawIdea: guide, optionalDetails: {} } as MobileCreationDraftPayload;
    const recipe = completeRecipe(payload, "practical_guide");
    expect(recipe.audience).toBe("new first-time managers");
    expect(recipe.promise).toBe("leave with a clear, practical first step on the topic");
    const stated = completeRecipe({ ...payload, rawIdea: "A pricing guide", brief: { topic: "Pricing", audience: "solo consultants" } } as MobileCreationDraftPayload, "practical_guide");
    expect(stated.audience).toBe("solo consultants");
    expect(completeRecipe({ ...payload, rawIdea: "A pricing guide" }, "practical_guide").audience).toBe("readers who want a practical next step");
  });
});
