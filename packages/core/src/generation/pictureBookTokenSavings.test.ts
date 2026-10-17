import { expect, it } from "vitest";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { generateWholeBookDraft } from "./pages.js";

const input = createProjectSchema.parse({ prompt: "Rabbit finds a lantern and helps Turtle carry it home.", category: "KIDS", targetPages: 5,
  mediaSettings: { fullIllustrations: false, includeCover: false, coverArtSource: "none" } });
const plan = makeFallbackPlan(input);
const pages = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, title: `Page ${i + 1}`,
  markdown: `Rabbit carried lantern ${i + 1} across the bridge to Turtle.`, summary: "Redundant scene summary." }));

it.each(["none", "design", "ai"] as const)("omits unused artwork context for %s covers while retaining character canon", async (coverArtSource) => {
  const { model, calls } = scriptedDevelopmentModel([{ pages: pages.map((page) => ({ ...page, continuityNotes: [] })) }]);
  await generateWholeBookDraft({ input: { ...input, mediaSettings: { ...input.mediaSettings, coverArtSource } }, plan, researchNotes: [], textModel: model });
  const payload = JSON.parse(calls[0]!.messages.find((message) => message.role === "user")!.content);
  expect(payload.characters).toEqual(plan.characters);
  expect("illustrationPlan" in payload).toBe(coverArtSource === "ai");
});

it("retains artwork context when interior slots are enabled", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ pages: pages.map((page) => ({ ...page, continuityNotes: [] })) }]);
  await generateWholeBookDraft({ input: { ...input, mediaSettings: { ...input.mediaSettings, fullIllustrations: true, illustrationCadence: "every-page" } }, plan, researchNotes: [], textModel: model });
  expect(JSON.parse(calls[0]!.messages[1]!.content).illustrationPlan).toEqual(plan.illustrationPlan);
});
