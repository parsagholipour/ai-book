import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import { AdapterJsonValidationError, parseSchemaWithContext } from "../adapters/json.js";
import { isChapterBriefProviderCallMetadata } from "../adapters/types.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import {
  malformedGeneratedChapterBriefFixtures,
  mechanicsChapterBriefContract,
  mechanicsPage,
  numericPageArrayResponse,
  validAliasedChapterBriefResponse,
  validGlobalChapterBriefResponse,
  validLocalChapterBriefResponse
} from "./testing/generatedChapterBriefFixtures.js";
import {
  PageMapResponseInvalidError,
  decodeGeneratedChapterBrief,
  pageMapResponseInvalidErrorFromSchemaError,
  pageMapResponseViolationCodesFromError
} from "./generatedChapterBriefAcceptance.js";
import { generateChapterBrief, generateWholeBookPageMap } from "./pagesPageMap.js";

const input: CreateProjectInput = {
  prompt: "Explain the mechanics of friction through a sequence of concrete measurements.",
  category: "EDUCATION",
  targetPages: 6,
  complexity: 5,
  temperature: 0.7,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

const chapter = {
  index: 2,
  title: "Forces in Contact",
  summary: "Friction turns contact into a measurable change in motion.",
  targetPages: 3,
  keyBeats: []
};

describe("decodeGeneratedChapterBrief", () => {
  it("rejects numeric page arrays instead of inventing page assignments", () => {
    expect(() => decodeGeneratedChapterBrief(numericPageArrayResponse, mechanicsChapterBriefContract)).toThrow(
      PageMapResponseInvalidError
    );

    try {
      decodeGeneratedChapterBrief(numericPageArrayResponse, mechanicsChapterBriefContract);
    } catch (error) {
      expect(error).toMatchObject({
        code: "PAGE_MAP_RESPONSE_INVALID",
        chapterIndex: 2,
        expectedRange: { start: 4, end: 6 },
        violations: [expect.objectContaining({ code: "PAGE_NOT_OBJECT", indexes: [4, 5, 6] })]
      });
    }
  });

  it("reports the expected violation for every distilled malformed response", () => {
    for (const fixture of malformedGeneratedChapterBriefFixtures) {
      let caught: unknown;
      try {
        decodeGeneratedChapterBrief(fixture.raw, mechanicsChapterBriefContract);
      } catch (error) {
        caught = error;
      }
      expect(caught, fixture.name).toBeInstanceOf(PageMapResponseInvalidError);
      expect(caught, fixture.name).toMatchObject({
        code: "PAGE_MAP_RESPONSE_INVALID",
        violations: expect.arrayContaining([
          expect.objectContaining({ code: fixture.expectedCode, indexes: fixture.expectedIndexes })
        ])
      });
    }
  });

  it("accepts exact global, complete local, and meaningful aliased object assignments", () => {
    const responses = [
      validGlobalChapterBriefResponse(),
      validLocalChapterBriefResponse(),
      validAliasedChapterBriefResponse()
    ];

    for (const raw of responses) {
      const brief = decodeGeneratedChapterBrief(raw, mechanicsChapterBriefContract);
      expect(brief.chapterIndex).toBe(2);
      expect(brief.pages.map((page) => page.pageIndex)).toEqual([4, 5, 6]);
      expect(brief.pages.every((page) => page.chapterIndex === 2)).toBe(true);
      expect(brief.pages.every((page) => page.purpose.length > 20)).toBe(true);
      expect(brief.pages.every((page) => page.beat.length > 20)).toBe(true);
      expect(brief.pages.every((page) => page.endingPressure.length > 20)).toBe(true);
    }
  });

  it("carries a page's claim and evidence anchors through decode under their aliases", () => {
    const response = validGlobalChapterBriefResponse();
    response.pages[0] = {
      ...response.pages[0]!,
      thesis: "Friction scales with the normal load, not the contact area.",
      anchors: ["spring-scale trial 1", " brick on sandpaper "]
    } as (typeof response.pages)[number];

    const brief = decodeGeneratedChapterBrief(response, mechanicsChapterBriefContract);

    expect(brief.pages[0]).toMatchObject({
      claim: "Friction scales with the normal load, not the contact area.",
      evidenceAnchors: ["spring-scale trial 1", "brick on sandpaper"]
    });
    expect(brief.pages[1]).not.toHaveProperty("claim");
  });

  it("rejects every accepted field alias when it is returned as metadata instead of content", () => {
    const response = validGlobalChapterBriefResponse();
    const metadataOnlyPurposeAlias = "function";
    response.pages[0] = {
      ...response.pages[0]!,
      purpose: metadataOnlyPurposeAlias,
      beat: "action",
      endingPressure: "pageTurn"
    };

    expect(() => decodeGeneratedChapterBrief(response, mechanicsChapterBriefContract)).toThrowError(
      expect.objectContaining({
        violations: expect.arrayContaining([
          { code: "PURPOSE_NOT_SUBSTANTIVE", indexes: [4] },
          { code: "BEAT_NOT_SUBSTANTIVE", indexes: [4] },
          { code: "ENDING_PRESSURE_NOT_SUBSTANTIVE", indexes: [4] }
        ])
      })
    );
  });

  it("rejects generic one-word placeholders and still accepts concrete one-word aliases", () => {
    const generic = validGlobalChapterBriefResponse();
    generic.pages[0] = {
      ...generic.pages[0]!,
      purpose: "Introduction",
      beat: "Continue",
      endingPressure: "Tension"
    };
    expect(() => decodeGeneratedChapterBrief(generic, mechanicsChapterBriefContract)).toThrowError(
      expect.objectContaining({
        violations: expect.arrayContaining([
          { code: "PURPOSE_NOT_SUBSTANTIVE", indexes: [4] },
          { code: "BEAT_NOT_SUBSTANTIVE", indexes: [4] },
          { code: "ENDING_PRESSURE_NOT_SUBSTANTIVE", indexes: [4] }
        ])
      })
    );

    const concreteAlias = validGlobalChapterBriefResponse();
    concreteAlias.pages[0] = {
      globalPageIndex: 4,
      chapterNumber: 2,
      objective: "Evacuation",
      action: "Blackout",
      continuityNotes: ["Keep the failed lift unavailable."],
      nextPagePressure: "Separation"
    } as unknown as (typeof concreteAlias.pages)[number];
    const accepted = decodeGeneratedChapterBrief(concreteAlias, mechanicsChapterBriefContract);
    expect(accepted.pages[0]).toMatchObject({
      purpose: "Evacuation",
      beat: "Blackout",
      endingPressure: "Separation"
    });
  });

  it("overwrites a mismatched chapterIndex instead of rejecting the brief", () => {
    const brief = decodeGeneratedChapterBrief({
      ...validGlobalChapterBriefResponse(),
      chapterIndex: 999,
      pages: [mechanicsPage(4, 999), mechanicsPage(5, 999), mechanicsPage(6, 999)]
    }, mechanicsChapterBriefContract);

    expect(brief.chapterIndex).toBe(2);
    expect(brief.pages.map((page) => page.pageIndex)).toEqual([4, 5, 6]);
    expect(brief.pages.every((page) => page.chapterIndex === 2)).toBe(true);
  });

  it("orders a global page-index permutation after acceptance", () => {
    const brief = decodeGeneratedChapterBrief(
      { ...validGlobalChapterBriefResponse(), pages: [mechanicsPage(5), mechanicsPage(4), mechanicsPage(6)] },
      mechanicsChapterBriefContract
    );
    expect(brief.pages.map((page) => page.pageIndex)).toEqual([4, 5, 6]);
  });

  it("orders and remaps a complete local page-index permutation", () => {
    const brief = decodeGeneratedChapterBrief(
      { ...validGlobalChapterBriefResponse(), pages: [mechanicsPage(3), mechanicsPage(1), mechanicsPage(2)] },
      mechanicsChapterBriefContract
    );
    expect(brief.pages.map((page) => page.pageIndex)).toEqual([4, 5, 6]);
  });

  it("fails with PAGE_ARRAY_MISSING when the pages array is missing", () => {
    expect(() => decodeGeneratedChapterBrief({
      chapterIndex: 999,
      title: "Forces in Contact",
      summary: "Friction turns contact into a measurable change in motion."
    }, mechanicsChapterBriefContract)).toThrowError(
      expect.objectContaining({
        code: "PAGE_MAP_RESPONSE_INVALID",
        violations: [{ code: "PAGE_ARRAY_MISSING", indexes: [4, 5, 6] }]
      })
    );
  });

  it("fails with PAGE_NOT_OBJECT when pages are not objects", () => {
    expect(() => decodeGeneratedChapterBrief(
      { ...numericPageArrayResponse, chapterIndex: 999 },
      mechanicsChapterBriefContract
    )).toThrowError(
      expect.objectContaining({
        code: "PAGE_MAP_RESPONSE_INVALID",
        violations: [{ code: "PAGE_NOT_OBJECT", indexes: [4, 5, 6] }]
      })
    );
  });
});

describe("generateChapterBrief strict provider acceptance", () => {
  it("repairs a schema-invalid response within the original logical call", async () => {
    const model = sequenceJsonModel([numericPageArrayResponse, validGlobalChapterBriefResponse()]);

    const brief = await generateChapterBrief({
      input,
      plan: makeFallbackPlan(input),
      chapter,
      chapterPageStart: 4,
      chapterPageEnd: 6,
      textModel: model.adapter
    });

    expect(brief.pages.map((page) => page.pageIndex)).toEqual([4, 5, 6]);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.temperature).toBe(0.2);
    expect(model.requests[1]?.messages[0]?.content).toContain("PAGE_NOT_OBJECT");
    expect(model.requests.every((request) => request.purpose === "generate-chapter-brief")).toBe(true);
    const metadata = model.requests.map((request) => request.providerCallMetadata);
    const logicalIds = metadata.map((item) =>
      isChapterBriefProviderCallMetadata(item) ? item.chapterBriefLogicalCallId : null
    );
    expect(logicalIds.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(logicalIds).size).toBe(1);
    expect(metadata).toEqual([
      expect.objectContaining({
        chapterBriefTier: "balanced",
        chapterBriefChapterIndex: 2,
        chapterBriefPageStart: 4,
        chapterBriefPageEnd: 6,
        chapterBriefAttempt: 1,
        chapterBriefMaxAttempts: 3
      }),
      expect.objectContaining({ chapterBriefAttempt: 2, chapterBriefMaxAttempts: 3 })
    ]);
  });

  it("exhausts two repair attempts and never returns an invented fallback assignment", async () => {
    const model = sequenceJsonModel([numericPageArrayResponse]);

    await expect(
      generateChapterBrief({
        input,
        plan: makeFallbackPlan(input),
        chapter,
        chapterPageStart: 4,
        chapterPageEnd: 6,
        textModel: model.adapter
      })
    ).rejects.toMatchObject({
      code: "PAGE_MAP_RESPONSE_INVALID",
      chapterIndex: 2,
      expectedRange: { start: 4, end: 6 },
      violations: [expect.objectContaining({ code: "PAGE_NOT_OBJECT", indexes: [4, 5, 6] })]
    });
    expect(model.requests).toHaveLength(3);
    const logicalIds = model.requests.map((request) => {
      const metadata = request.providerCallMetadata;
      return isChapterBriefProviderCallMetadata(metadata) ? metadata.chapterBriefLogicalCallId : null;
    });
    expect(new Set(logicalIds).size).toBe(1);
    expect(model.requests.map((request) => {
      const metadata = request.providerCallMetadata;
      return isChapterBriefProviderCallMetadata(metadata) ? metadata.chapterBriefAttempt : null;
    })).toEqual([1, 2, 3]);
    expect(model.providerErrors).toHaveLength(3);
    expect(model.providerErrors.every((error) => error instanceof AdapterJsonValidationError)).toBe(true);
    expect(model.providerErrors[2]).toMatchObject({
      context: {
        parsedObject: numericPageArrayResponse,
        validationMessage: expect.stringContaining("PAGE_NOT_OBJECT"),
        validationIssues: expect.arrayContaining([
          expect.objectContaining({
            params: {
              pageMapResponseViolation: { code: "PAGE_NOT_OBJECT", indexes: [4, 5, 6] }
            }
          })
        ])
      }
    });
  });

  it("translates a direct Zod failure into the typed page-map error without inventing a fallback", async () => {
    const model = sequenceJsonModel([numericPageArrayResponse], "direct");

    await expect(
      generateChapterBrief({
        input,
        plan: makeFallbackPlan(input),
        chapter,
        chapterPageStart: 4,
        chapterPageEnd: 6,
        textModel: model.adapter
      })
    ).rejects.toMatchObject({
      code: "PAGE_MAP_RESPONSE_INVALID",
      chapterIndex: 2,
      expectedRange: { start: 4, end: 6 },
      violations: [expect.objectContaining({ code: "PAGE_NOT_OBJECT", indexes: [4, 5, 6] })]
    });
    expect(model.requests).toHaveLength(1);
  });
});

describe("whole-book map path stays outside the strict generated-response seam", () => {
  it("invents generic assignments for blank whole-book fields instead of failing the job", async () => {
    const pageMapInput = { ...input, targetPages: 3 };
    const briefs = await generateWholeBookPageMap({
      input: pageMapInput,
      plan: makeFallbackPlan(pageMapInput),
      textModel: jsonParseModel({
        pages: [1, 2, 3].map((pageIndex) => ({
          pageIndex,
          chapterIndex: 1,
          purpose: "   ",
          beat: "   ",
          requiredContinuity: [],
          endingPressure: "   "
        }))
      })
    });

    expect(briefs.flatMap((brief) => brief.pages.map((page) => page.pageIndex))).toEqual([1, 2, 3]);
    const secondPage = briefs.flatMap((brief) => brief.pages).find((page) => page.pageIndex === 2);
    expect(secondPage).toMatchObject({
      purpose: "Advance the chapter on page 2.",
      beat: "Advance the chapter with a concrete, non-repetitive beat on page 2.",
      endingPressure: "Leave a concrete reason for the next page to continue."
    });
  });
});

describe("pageMapResponseViolationCodesFromError", () => {
  it("translates AdapterJsonValidationError issues into the typed page-map error", () => {
    const issues = [
      {
        code: "custom",
        params: { pageMapResponseViolation: { code: "PAGE_NOT_OBJECT", indexes: [4, 5, 6] } }
      }
    ];
    const error = new AdapterJsonValidationError(
      "Test",
      "generate-chapter-brief",
      ["pages"],
      "PAGE_NOT_OBJECT",
      "{}",
      numericPageArrayResponse,
      issues
    );

    expect(pageMapResponseInvalidErrorFromSchemaError(error, mechanicsChapterBriefContract)).toMatchObject({
      code: "PAGE_MAP_RESPONSE_INVALID",
      chapterIndex: 2,
      expectedRange: { start: 4, end: 6 },
      violations: [expect.objectContaining({ code: "PAGE_NOT_OBJECT", indexes: [4, 5, 6] })]
    });
  });

  it("reads codes from adapter context and Zod-shaped issues", () => {
    const issues = [
      {
        code: "custom",
        params: { pageMapResponseViolation: { code: "PAGE_NOT_OBJECT", indexes: [4, 5, 6] } }
      },
      {
        code: "custom",
        params: { pageMapResponseViolation: { code: "PURPOSE_NOT_SUBSTANTIVE", indexes: [4] } }
      }
    ];

    expect(pageMapResponseViolationCodesFromError(new AdapterJsonValidationError(
      "Test",
      "generate-chapter-brief",
      ["pages"],
      "PAGE_NOT_OBJECT",
      "{}",
      numericPageArrayResponse,
      issues
    ))).toEqual(["PAGE_NOT_OBJECT", "PURPOSE_NOT_SUBSTANTIVE"]);
    expect(pageMapResponseViolationCodesFromError(Object.assign(new Error("zod"), {
      name: "ZodError",
      issues
    }))).toEqual(["PAGE_NOT_OBJECT", "PURPOSE_NOT_SUBSTANTIVE"]);
  });
});

function sequenceJsonModel(responses: unknown[], validation: "contextual" | "direct" = "contextual") {
  const requests: GenerateJsonOptions<unknown>[] = [];
  const providerErrors: unknown[] = [];
  let call = 0;
  const adapter: TextModelAdapter = {
    async generateText() {
      return { text: "", model: "test-model", provider: "test" };
    },
    async generateJson(options) {
      requests.push(options as GenerateJsonOptions<unknown>);
      const raw = responses[Math.min(call, responses.length - 1)];
      call += 1;
      const text = JSON.stringify(raw);
      try {
        return {
          data: validation === "contextual"
            ? parseSchemaWithContext("Test", options.schema, raw, options.purpose, text)
            : options.schema.parse(raw),
          text,
          model: "test-model",
          provider: "test"
        };
      } catch (error) {
        providerErrors.push(error);
        throw error;
      }
    },
    async *streamText() {
      yield "";
    },
    generateWithTools: unsupportedGenerateWithTools
  };
  return { adapter, requests, providerErrors };
}

function jsonParseModel(raw: unknown): TextModelAdapter {
  return {
    async generateText() {
      return { text: "", model: "test-model", provider: "test" };
    },
    async generateJson(options) {
      return {
        data: options.schema.parse(raw),
        text: JSON.stringify(raw),
        model: "test-model",
        provider: "test"
      };
    },
    async *streamText() {
      yield "";
    },
    generateWithTools: unsupportedGenerateWithTools
  };
}
