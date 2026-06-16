import { describe, expect, it } from "vitest";
import {
  deterministicAdvisor,
  deterministicCreationTurn,
  greetingCreationTurn,
  mobileCreationDraftPayloadSchema,
  runCreationTurn,
  titleForMobilePayload,
  type MobileCreationTurnRequest
} from "./mobileCreation.js";

describe("runCreationTurn", () => {
  const childRequest: MobileCreationTurnRequest = {
    messages: [{ role: "user", content: "Bedtime story for 5 year olds" }]
  };

  it("greeting turn invites the user without allowing a build yet", () => {
    const turn = greetingCreationTurn();

    expect(turn.readiness.canBuild).toBe(false);
    expect(turn.quickReplies.length).toBeGreaterThan(0);
    expect(turn.question).toBeNull();
    expect(turn.assistantMessage.length).toBeGreaterThan(0);
  });

  it("returns a deterministic, schema-valid turn without enrichment", async () => {
    const turn = await runCreationTurn(childRequest);

    expect(turn.detectedLane).toBe("children_story");
    expect(turn.brief.lane).toBe("children_story");
    expect(turn.readiness.canBuild).toBe(true);
    expect(deterministicCreationTurn(childRequest).detectedLane).toBe("children_story");
  });

  it("falls back to the deterministic turn when enrichment throws", async () => {
    const turn = await runCreationTurn(childRequest, {
      enrich: async () => {
        throw new Error("model unavailable");
      }
    });

    expect(turn.detectedLane).toBe("children_story");
    expect(turn.assistantMessage.length).toBeGreaterThan(0);
  });

  it("falls back to the deterministic turn when enrichment times out", async () => {
    const turn = await runCreationTurn(childRequest, {
      enrich: () => new Promise<never>(() => undefined),
      timeoutMs: 5
    });

    expect(turn.detectedLane).toBe("children_story");
    expect(turn.readiness.canBuild).toBe(true);
  });

  it("applies a valid enrichment patch on top of the deterministic base", async () => {
    const turn = await runCreationTurn(childRequest, {
      enrich: async (_request, base) => ({
        assistantMessage: "Lovely - a cozy bedtime tale it is.",
        quickReplies: ["Add a friendly moon"],
        readiness: base.readiness
      })
    });

    expect(turn.assistantMessage).toContain("cozy bedtime");
    expect(turn.quickReplies).toContain("Add a friendly moon");
    expect(turn.detectedLane).toBe("children_story");
  });
});

describe("mobile creation title selection", () => {
  it("does not promote rough ideas, recipe titles, or advisor suggestions into project titles", () => {
    const payload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: "I want to create a similar story to the Rabit and Turtle race",
      messages: [{ role: "user", content: "I want to create a similar story to the Rabit and Turtle race" }]
    });
    const advisor = deterministicAdvisor(payload);

    expect(
      titleForMobilePayload(payload, {
        ...advisor,
        recipe: { ...advisor.recipe, title: "I Want To Create A Similar" },
        titleSuggestions: ["I Want To Create A Similar"]
      })
    ).toBeUndefined();
  });

  it("uses only explicit mobile title declarations", () => {
    const optionalTitlePayload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: "Story about a careful race.",
      optionalDetails: { title: "The Meadow Finish" },
      messages: [{ role: "user", content: "Story about a careful race." }]
    });
    const chatTitlePayload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: "I want a short story.\nTitle: Slow Steps Home",
      messages: [{ role: "user", content: "I want a short story.\nTitle: Slow Steps Home" }]
    });

    expect(titleForMobilePayload(optionalTitlePayload, deterministicAdvisor(optionalTitlePayload))).toBe("The Meadow Finish");
    expect(titleForMobilePayload(chatTitlePayload, deterministicAdvisor(chatTitlePayload))).toBe("Slow Steps Home");
  });
});
