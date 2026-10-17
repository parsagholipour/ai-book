import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "@book-maker/core";
import { deterministicAdvisor, enrichAdvisorWithAi } from "./mobileCreationAdvisor.js";
import { mobileCreationDraftPayloadSchema } from "./mobileCreation.js";

describe("book advisor", () => {
  // The advisor rewrites the recipe the planner is shown, so it is told the
  // creation chat's rule too: a real person keeps their name.
  it("tells the model to keep a real person the user named", async () => {
    const idea = "10 page enemies-to-lovers book about Neymar and a waitress";
    const payload = mobileCreationDraftPayloadSchema.parse({
      payloadVersion: 3,
      rawIdea: idea,
      messages: [{ role: "user", content: idea }]
    });
    const model = new FakeTextModelAdapter();
    const generate = vi.spyOn(model, "generateJson");

    await enrichAdvisorWithAi(model, payload, deterministicAdvisor(payload));

    const system = generate.mock.calls[0]![0].messages[0]!.content;
    expect(system).toContain("Keep every real person the user named");
    expect(system).toContain("never turn one into an invented stand-in");
  });
});
