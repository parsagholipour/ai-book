import { describe, expect, it, vi } from "vitest";
import type { TextModelAdapter } from "../adapters/types.js";
import { COVER_DESIGN_SELECTION_PURPOSE, coverDesign } from "./coverDesigns.js";
import { selectCoverDesign } from "./coverDesignSelection.js";
import { createProjectSchema, type BookPlan, type CreateProjectInput } from "../schemas/book.js";

const input: CreateProjectInput = createProjectSchema.parse({
  prompt: "A cosy detective story set on a rainy island.",
  category: "STORY",
  subcategory: "Mystery"
});

const plan = {
  title: "The Lighthouse Ledger",
  subtitle: "A Marlow Investigation",
  premise: "A bookkeeper's ledger exposes a decade of quiet fraud.",
  audience: "Adult mystery readers."
} as unknown as BookPlan;

function textModel(generateJson: TextModelAdapter["generateJson"]): TextModelAdapter {
  return { generateJson } as TextModelAdapter;
}

function jsonResult(data: unknown) {
  return { data, text: JSON.stringify(data), model: "test", provider: "test", usage: { promptTokens: 1, outputTokens: 1 } };
}

describe("selectCoverDesign", () => {
  it("uses the design the model names", async () => {
    const generateJson = vi.fn(async (options: { schema: { parse: (value: unknown) => unknown } }) =>
      jsonResult(options.schema.parse({ designId: "fog-street", reason: "Rainy island detective story." }))
    );
    const choice = await selectCoverDesign({
      textModel: textModel(generateJson as unknown as TextModelAdapter["generateJson"]),
      input,
      plan,
      seed: "project-1"
    });

    expect(choice.design.id).toBe("fog-street");
    expect(choice.selectedBy).toBe("model");
    expect(choice.reason).toBe("Rainy island detective story.");
  });

  it("sends the whole catalog and tags the call so the mock adapter can answer it", async () => {
    const generateJson = vi.fn(async (options: { schema: { parse: (value: unknown) => unknown } }) =>
      jsonResult(options.schema.parse({ designId: "fog-street" }))
    );
    await selectCoverDesign({
      textModel: textModel(generateJson as unknown as TextModelAdapter["generateJson"]),
      input,
      plan,
      seed: "project-1"
    });

    const call = generateJson.mock.calls[0]?.[0] as unknown as {
      purpose: string;
      messages: Array<{ content: string }>;
    };
    expect(call.purpose).toBe(COVER_DESIGN_SELECTION_PURPOSE);
    expect(call.messages[0]?.content).toContain("moonlit-sea");
    expect(call.messages[1]?.content).toContain("The Lighthouse Ledger");
  });

  it("falls back deterministically when the model invents an id", async () => {
    const generateJson = vi.fn(async () => jsonResult({ designId: "not-a-real-design" }));
    const choice = await selectCoverDesign({
      textModel: textModel(generateJson as unknown as TextModelAdapter["generateJson"]),
      input,
      plan,
      seed: "project-1"
    });

    expect(choice.selectedBy).toBe("fallback");
    expect(coverDesign(choice.design.id)).toBeDefined();
    expect(choice.design.tags).toContain("mystery");
  });

  it("never throws — a book that reached its cover is already written and paid for", async () => {
    const generateJson = vi.fn(async () => {
      throw new Error("model timed out");
    });
    const choice = await selectCoverDesign({
      textModel: textModel(generateJson as unknown as TextModelAdapter["generateJson"]),
      input,
      plan,
      seed: "project-1"
    });

    expect(choice.selectedBy).toBe("fallback");
    expect(coverDesign(choice.design.id)).toBeDefined();
  });

  it("re-throws errors the caller's bailOnError claims instead of falling back", async () => {
    // The worker passes its stop-signal predicate here: a swallowed stop used
    // to finish the cover and compile a user-stopped run to COMPLETE.
    const stop = new Error("Stop requested");
    const generateJson = vi.fn(async () => {
      throw stop;
    });

    await expect(
      selectCoverDesign({
        textModel: textModel(generateJson as unknown as TextModelAdapter["generateJson"]),
        input,
        plan,
        seed: "project-1",
        bailOnError: (error) => error === stop
      })
    ).rejects.toBe(stop);

    // An unclaimed error still falls back.
    const choice = await selectCoverDesign({
      textModel: textModel(generateJson as unknown as TextModelAdapter["generateJson"]),
      input,
      plan,
      seed: "project-1",
      bailOnError: () => false
    });
    expect(choice.selectedBy).toBe("fallback");
  });
});
