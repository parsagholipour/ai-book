import { describe, expect, it } from "vitest";
import { PageMapResponseInvalidError, decodeGeneratedChapterBrief } from "./generatedChapterBriefAcceptance.js";
import { MODEL_PAGE_ARRAY_KEYS } from "./generatedPageResponse.js";
import { mechanicsChapterBriefContract, validGlobalChapterBriefResponse } from "./testing/generatedChapterBriefFixtures.js";

describe("generated page response reading", () => {
  it("unwraps only named chapter-brief envelopes and never searches arbitrary nested data", () => {
    expect(MODEL_PAGE_ARRAY_KEYS).not.toContain("payload");

    const nested = {
      payload: validGlobalChapterBriefResponse()
    };

    expect(() => decodeGeneratedChapterBrief(nested, mechanicsChapterBriefContract)).toThrow(
      PageMapResponseInvalidError
    );

    try {
      decodeGeneratedChapterBrief(nested, mechanicsChapterBriefContract);
    } catch (error) {
      expect(error).toMatchObject({
        code: "PAGE_MAP_RESPONSE_INVALID",
        violations: expect.arrayContaining([
          expect.objectContaining({ code: "PAGE_ARRAY_MISSING", indexes: [4, 5, 6] })
        ])
      });
    }
  });
});
