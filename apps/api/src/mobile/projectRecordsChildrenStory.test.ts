import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { createProjectSchema, estimateInteriorImageCount } from "@book-maker/core";
import { buildMobileCreateProjectInput, deterministicPageCountRecommendations } from "./projectRecords.js";
import { deterministicAdvisor, mobileCreationDraftPayloadSchema } from "../mobileCreation.js";

// A children's story used to be filed STORY and composed as adult chapters: a
// 12-page story for a six-year-old printed 5,337 words.
describe("children's stories are KIDS books", () => {
  const prompt = "A bedtime story for 6 year olds about a shy tortoise named Tiko who wants to see the sea";

  it("files an explicit Children's story choice under KIDS and the picture-book template", () => {
    const input = buildMobileCreateProjectInput({
      bookType: "short_story",
      bookTypeChoice: "children_story",
      prompt,
      qualityPreset: "balanced",
      lengthPreset: "short",
      pageCountMode: "custom",
      targetPages: 12,
      coverEnabled: true,
      illustrationsEnabled: true
    });
    expect(input).toMatchObject({ category: "KIDS", templateSlug: "kids-picture-book", targetPages: 12 });
    expect(input.mediaSettings).toMatchObject({ coverTemplate: "kids", mobile: expect.objectContaining({ bookType: "short_story" }) });
    // The quote stays what the app promised: a picture book draws two pictures
    // for every five pages, five for twelve (generation draws exactly the
    // quoted slots — illustrationSlots.test.ts; the app's
    // `estimatedInteriorImageCount`).
    expect(estimateInteriorImageCount(createProjectSchema.parse(input))).toBe(5);
  });

  it("files an Auto book the chat resolved to a children's story under KIDS", () => {
    const input = buildMobileCreateProjectInput({
      bookType: "lead_magnet",
      bookTypeChoice: "auto",
      prompt,
      qualityPreset: "balanced",
      lengthPreset: "short",
      pageCountMode: "custom",
      targetPages: 12,
      illustrationsEnabled: true,
      creationPayload: {
        payloadVersion: 3,
        rawIdea: prompt,
        detectedLane: "children_story",
        selectedPresets: { bookType: "lead_magnet", bookTypeChoice: "auto", lengthPreset: "short", qualityPreset: "balanced" }
      }
    } as never);
    expect(input).toMatchObject({ category: "KIDS", templateSlug: "kids-picture-book" });
    // Auto is quoted as `custom` in the app: ceil(12 / 8) interiors, the same here.
    expect(estimateInteriorImageCount(createProjectSchema.parse(input))).toBe(2);
  });

  it("leaves an adult short story and an unresolved Auto book where they were", () => {
    const story = buildMobileCreateProjectInput({ bookType: "short_story", bookTypeChoice: "short_story", prompt, qualityPreset: "balanced", lengthPreset: "short" });
    const auto = buildMobileCreateProjectInput({ bookType: "lead_magnet", bookTypeChoice: "auto", prompt, qualityPreset: "balanced", lengthPreset: "short" });
    expect(story.category).toBe("STORY");
    expect(auto.category).toBe("CUSTOM");
  });
});

// An Auto book settles on a lane in the chat; filed CUSTOM, a practical guide
// was written as cue-word prose and never reached the toolkit path.
describe("an Auto book is filed under the lane the chat resolved", () => {
  const autoWith = (lane: string) =>
    buildMobileCreateProjectInput({
      bookType: "lead_magnet",
      bookTypeChoice: "auto",
      prompt: "A practical guide for renters who want to grow vegetables on a small balcony",
      qualityPreset: "fast",
      lengthPreset: "short",
      pageCountMode: "custom",
      targetPages: 12,
      creationPayload: {
        payloadVersion: 3,
        rawIdea: "A practical guide",
        detectedLane: "auto",
        recipe: { lane, artifact: "Book", audience: "Readers", promise: "Help", tone: "clear" },
        selectedPresets: { bookType: "lead_magnet", bookTypeChoice: "auto", lengthPreset: "short", qualityPreset: "fast" }
      }
    } as never);

  it.each([
    ["practical_guide", "BUSINESS"],
    ["lead_magnet", "BUSINESS"],
    ["offer_guide", "BUSINESS"],
    ["workbook", "EDUCATION"],
    ["client_tool", "EDUCATION"],
    ["adult_story", "STORY"],
    ["children_story", "KIDS"]
  ])("files a resolved %s as %s and keeps the stored choice Auto", (lane, category) => {
    const input = autoWith(lane);
    expect(input.category).toBe(category);
    expect(input.mediaSettings).toMatchObject({ mobile: expect.objectContaining({ bookType: "custom", bookTypeChoice: "auto" }) });
  });

  it("offers the resolved lane's lengths for an Auto chat", () => {
    const payload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: "A bedtime story about a shy tortoise",
      messages: [{ role: "user", content: "A bedtime story about a shy tortoise" }],
      selectedPresets: { bookType: "lead_magnet", bookTypeChoice: "auto", lengthPreset: "short", qualityPreset: "balanced" }
    });
    const advisor = deterministicAdvisor(payload);
    const resolved = { ...advisor, recipe: { ...advisor.recipe, lane: "children_story" as const } };
    expect(deterministicPageCountRecommendations(payload, resolved).map((option) => option.targetPages)).toEqual([4, 8, 12]);
    expect(deterministicPageCountRecommendations(payload, advisor).map((option) => option.targetPages)).toEqual([8, 12, 24]);
  });
});

