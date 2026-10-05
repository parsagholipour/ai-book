import { describe, expect, it } from "vitest";
import { toolkitBookKind, type CreateProjectInput } from "@book-maker/core";
import {
  briefForMobilePayload,
  composeMobileProjectPrompt,
  creationTurnMessages,
  deterministicAdvisor,
  deterministicCreationTurn,
  mobileBriefMetadata,
  mobileCreationDraftPayloadSchema,
  runCreationTurn,
  type CreationTurnPatch,
  type MobileBookRecipe,
  type MobileCreationTurnRequest
} from "./mobileCreation.js";

// A book left on Auto used to stay "auto" all the way into the project, so
// "A practical guide for renters…" built as flowing essay prose: nothing
// recorded that the chat had settled on a guide, and the toolkit path and the
// KIDS routing both read the lane back off the stored recipe.

const autoPresets = {
  bookType: "lead_magnet",
  bookTypeChoice: "auto",
  lengthPreset: "short",
  qualityPreset: "balanced",
  imagesEnabled: false,
  coverEnabled: false,
  illustrationsEnabled: false
} as const;

const guideMessage = { role: "user" as const, content: "A practical guide for renters who want to grow vegetables on a small balcony" };

function turnWith(patch: CreationTurnPatch, request: MobileCreationTurnRequest) {
  return runCreationTurn(request, {
    enrich: async () => ({ assistantMessage: "Sounds good.", question: null, ...patch })
  });
}

function storedRecipe(turnBrief: MobileBookRecipe): MobileBookRecipe {
  // What the creation-session routes persist as `recipe: turn.brief`.
  return turnBrief;
}

describe("Auto book type resolved from the chat", () => {
  it("records the interviewer's settled shape beside an Auto choice it never changes", async () => {
    const turn = await turnWith(
      { autoLane: "practical_guide" },
      { messages: [guideMessage], presets: autoPresets }
    );

    expect(turn.presets.bookTypeChoice).toBe("auto");
    expect(turn.detectedLane).toBe("auto");
    expect(turn.brief.lane).toBe("auto");
    expect(turn.brief.autoLane).toBe("practical_guide");
  });

  it("keeps the settled shape across a turn that says nothing, and clears it on 'auto'", async () => {
    const first = await turnWith({ autoLane: "practical_guide" }, { messages: [guideMessage], presets: autoPresets });
    const next: MobileCreationTurnRequest = {
      messages: [guideMessage, { role: "user", content: "Hot desert climate like Dubai" }],
      presets: autoPresets,
      brief: storedRecipe(first.brief)
    };

    expect((await turnWith({}, next)).brief.autoLane).toBe("practical_guide");
    // The deterministic fallback (an outage) keeps it too.
    expect(deterministicCreationTurn(next).brief.autoLane).toBe("practical_guide");
    expect((await turnWith({ autoLane: "auto" }, next)).brief.autoLane).toBeUndefined();
  });

  it("drops the settled shape once the reader picks a type, and ignores one the model writes into the brief", async () => {
    const settled = await turnWith({ autoLane: "children_story" }, { messages: [guideMessage], presets: autoPresets });
    const explicit = await turnWith(
      { autoLane: "children_story" },
      { messages: [guideMessage], presets: { ...autoPresets, bookType: "workbook", bookTypeChoice: "workbook" }, brief: settled.brief }
    );
    expect(explicit.brief.autoLane).toBeUndefined();

    const invented = await turnWith(
      { brief: { ...settled.brief, autoLane: "lead_magnet" } },
      { messages: [guideMessage], presets: autoPresets }
    );
    expect(invented.brief.autoLane).toBeUndefined();
  });

  it("tells the interviewer how to record the shape and what it recorded before", () => {
    const request: MobileCreationTurnRequest = {
      messages: [guideMessage],
      presets: autoPresets,
      brief: { ...deterministicCreationTurn({ messages: [guideMessage], presets: autoPresets }).brief, autoLane: "practical_guide" }
    };
    const messages = creationTurnMessages(request, deterministicCreationTurn(request));

    expect(messages[0]!.content).toContain("autoLane");
    expect(JSON.parse(messages[1]!.content).currentAutoLane).toBe("practical_guide");
  });

  it("builds a settled Auto book as that shape, down to the toolkit path", () => {
    const base = deterministicCreationTurn({ messages: [guideMessage], presets: autoPresets });
    const payload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: guideMessage.content,
      messages: [guideMessage],
      detectedLane: "auto",
      recipe: { ...base.brief, autoLane: "practical_guide" },
      selectedPresets: autoPresets
    });
    const advisor = deterministicAdvisor(payload);

    // The type stays Auto, so the build's stale-lane recompute is not taken.
    expect(advisor.detectedLane).toBe("auto");
    expect(advisor.recommendation.bookTypeChoice).toBe("auto");
    expect(advisor.recipe.lane).toBe("practical_guide");
    expect(advisor.rationale).toContain("settled on a practical guide");

    const finalPayload = mobileCreationDraftPayloadSchema.parse({ ...payload, recipe: advisor.recipe });
    const prompt = composeMobileProjectPrompt(finalPayload, advisor);
    expect(prompt).toContain("Create a practical guide.");
    expect(prompt).toContain("Book type choice: Auto - the creation chat settled on Practical guide");
    expect(prompt).not.toContain("decide during planning");

    const mobile = mobileBriefMetadata(finalPayload, advisor);
    expect(mobile.detectedLane).toBe("practical_guide");
    const input = { mediaSettings: { mobile: { ...mobile, bookTypeChoice: "auto" } } } as unknown as CreateProjectInput;
    expect(toolkitBookKind(input)).toBe("guide");
  });

  it("leaves an unsettled Auto book open, unlabelled, and immune to a stale explicit lane", () => {
    const payload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: guideMessage.content,
      messages: [guideMessage],
      // A lane left behind by a type the reader has since switched off.
      detectedLane: "workbook",
      recipe: { ...deterministicCreationTurn({ messages: [guideMessage], presets: autoPresets }).brief, lane: "workbook" },
      selectedPresets: autoPresets
    });
    const advisor = deterministicAdvisor(payload);

    expect(advisor.recipe.lane).toBe("auto");
    expect(composeMobileProjectPrompt(payload, advisor)).toContain("Auto - decide during planning");
    expect(briefForMobilePayload(mobileCreationDraftPayloadSchema.parse({ ...payload, recipe: advisor.recipe }), advisor).intent).toBe(
      "unspecified"
    );
  });

  it("preserves an analytical nonfiction brief through Auto without adding guide instructions", async () => {
    const messages = [{ role: "user" as const, content: "A book assessing Bolsonaro's personality and his government's performance" }];
    const base = deterministicCreationTurn({ messages, presets: autoPresets });
    const turn = await turnWith({
      autoLane: "auto",
      brief: { ...base.brief, artifact: "Political analysis", promise: "An evidence-based assessment of Bolsonaro's leadership and governing record" }
    }, { messages, presets: autoPresets });
    const payload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: messages[0]!.content,
      messages,
      recipe: turn.brief,
      selectedPresets: turn.presets
    });
    const advisor = deterministicAdvisor(payload);
    const prompt = composeMobileProjectPrompt(payload, advisor);
    expect(advisor.recipe.lane).toBe("auto");
    expect(advisor.recipe.artifact).toBe("Political analysis");
    expect(briefForMobilePayload(payload, advisor).intent).toBe("unspecified");
    expect(prompt).toContain("Artifact: Political analysis");
    expect(prompt).toContain("An evidence-based assessment of Bolsonaro's leadership and governing record");
    expect(prompt).not.toContain("Create a practical guide.");
    expect(prompt).not.toContain("Checklist and call-to-action");
  });
});
