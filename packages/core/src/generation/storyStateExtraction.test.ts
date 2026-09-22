import { describe, expect, it } from "vitest";
import { parseSchemaWithContext } from "../adapters/json.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import {
  applyStoryDelta,
  extractStoryState,
  parseStoryDelta,
  seedStoryStateFromPromises,
  storyExtractResultSchema
} from "./storyState.js";

describe("story extraction response contract", () => {
  it("rejects repeated malformed model replies while keeping stored-delta reads compatible", async () => {
    const reply = { storyDelta: { facts: ["AES input is a 128-bit block."] }, contradictions: [] };
    const model = new FakeTextModelAdapter();
    let attempts = 0;
    model.generateJson = async <T>(options: GenerateJsonOptions<T>) => {
      attempts += 1;
      return {
        text: JSON.stringify(reply),
        data: parseSchemaWithContext("Alibaba Qwen", options.schema, reply, options.purpose, JSON.stringify(reply)),
        model: "test-model",
        provider: "test"
      };
    };
    await expect(extractStoryState({
      textModel: model,
      pageIndex: 1,
      title: "AES",
      markdown: "AES input is a 128-bit block.",
      summary: "AES block size.",
      currentState: seedStoryStateFromPromises([])
    })).rejects.toThrow(/Unrecognized key/);
    expect(attempts).toBe(2);
    expect(parseStoryDelta({ factsAdded: ["AES input is a 128-bit block."], legacyMetadata: true })?.factsAdded)
      .toEqual(["AES input is a 128-bit block."]);
  });

  it.each([
    { storyDelta: { facts: ["AES input is a 128-bit block."] }, contradictions: [] },
    { storyDelta: { entities: { Alice: { state: "Shares a key with Bob" } } }, contradictions: [] },
    { storyDelta: { payPromises: ["plan-1"] }, contradictions: [] }
  ])("repairs trace-shaped noncanonical updates instead of accepting an empty delta: %j", async (reply) => {
    // The audit's Qwen/OpenAI replies used state-shaped or invented delta keys.
    // Run the same schema validation boundary as those provider adapters.
    const model = new FakeTextModelAdapter();
    const requests: GenerateJsonOptions<unknown>[] = [];
    model.generateJson = async <T>(options: GenerateJsonOptions<T>) => {
      requests.push(options);
      const text = JSON.stringify(requests.length === 1 ? reply : {
        storyDelta: {
          factsAdded: ["AES input is a 128-bit block."],
          entities: { Alice: { status: "Shares a key with Bob" } },
          promisesPaid: ["plan-1"]
        },
        contradictions: []
      });
      return {
        text,
        data: parseSchemaWithContext("Alibaba Qwen", options.schema, JSON.parse(text), options.purpose, text),
        model: "test-model",
        provider: "test"
      };
    };
    const currentState = seedStoryStateFromPromises(["Explain the AES block size."]);
    const result = await extractStoryState({
      textModel: model,
      pageIndex: 1,
      title: "AES",
      markdown: "AES input is a 128-bit block. Alice shares a key with Bob.",
      summary: "AES block size and shared keys.",
      currentState
    });
    const state = applyStoryDelta(currentState, result.storyDelta, 1);

    expect(state.facts).toEqual([{ text: "AES input is a 128-bit block.", pageIndex: 1 }]);
    expect(state.entities.Alice?.status).toBe("Shares a key with Bob");
    expect(state.promises[0]?.status).toBe("paid");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages[0]?.content).toContain("Validation issues:");
  });

  it("sends the complete output schema on the initial call to providers without native schema enforcement", async () => {
    const model = new FakeTextModelAdapter();
    const generateJson = model.generateJson.bind(model);
    let system = "";
    model.generateJson = async <T>(options: GenerateJsonOptions<T>) => {
      system = options.messages[0]?.content ?? "";
      return generateJson(options);
    };
    await extractStoryState({
      textModel: model,
      pageIndex: 1,
      title: "AES",
      markdown: "AES input is a 128-bit block.",
      summary: "AES block size.",
      currentState: seedStoryStateFromPromises([])
    });
    const marker = "Required JSON schema: ";
    expect(system).toContain(marker);
    const schema = JSON.parse(system.slice(system.indexOf(marker) + marker.length));
    expect(schema).not.toHaveProperty("$schema");
    expect(Object.keys(schema.properties.storyDelta.properties).sort()).toEqual(
      Object.keys(storyExtractResultSchema.shape.storyDelta.shape).sort()
    );
    expect(schema.properties.storyDelta.properties.factsAdded.items.type).toBe("string");
    expect(schema.properties.storyDelta.properties.entities.additionalProperties.type).toBe("object");
    expect(schema.properties.storyDelta.additionalProperties).toBe(false);
    expect(schema.properties.storyDelta.properties.entities.additionalProperties.additionalProperties).toBe(false);
  });
});
