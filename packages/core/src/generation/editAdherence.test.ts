import { describe, expect, it, vi } from "vitest";

import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { reviewAppliedBookEdit } from "./editAdherence.js";
import {
  EDIT_ADHERENCE_MESSAGE_BUDGET_BYTES,
  serializedAdherenceMessageBytes
} from "./editAdherenceHierarchy.js";

function modelReturning(data: unknown) {
  const generateJson = vi.fn(async (_options: GenerateJsonOptions<unknown>) => ({
    data,
    model: "reviewer",
    provider: "test"
  }));
  const model = { generateJson } as unknown as TextModelAdapter;
  return { model, generateJson };
}

describe("reviewAppliedBookEdit", () => {
  it("reviews the complete changed page set under the dedicated purpose", async () => {
    const { model, generateJson } = modelReturning({
      satisfied: false,
      confidence: 0.92,
      missingRequirements: ["The second page never reveals the red key."],
      contradictions: [],
      pageIndexesToRevise: [2, 99]
    });

    const verdict = await reviewAppliedBookEdit({
      instruction: "Reveal a red key across pages 1 and 2.",
      beforePages: [
        { index: 1, title: "One", markdown: "Old one", summary: "Old one" },
        { index: 2, title: "Two", markdown: "Old two", summary: "Old two" }
      ],
      afterPages: [
        { index: 1, title: "One", markdown: "A red key glints.", summary: "A key appears" },
        { index: 2, title: "Two", markdown: "Nothing changes.", summary: "No reveal" }
      ],
      textModel: model
    });

    expect(verdict.pageIndexesToRevise).toEqual([2]);
    expect(generateJson).toHaveBeenCalledOnce();
    const options = generateJson.mock.calls[0]![0];
    expect(options.purpose).toBe("review-edit-adherence");
    expect(serializedAdherenceMessageBytes(options.messages)).toBeLessThanOrEqual(
      EDIT_ADHERENCE_MESSAGE_BUDGET_BYTES
    );
    const payload = JSON.parse(options.messages[1]!.content);
    expect(payload.afterPages.map((page: { index: number }) => page.index)).toEqual([1, 2]);
  });

  it.each([
    {
      field: "an optional improvement",
      verdict: {
        missingRequirements: ["Consider strengthening the callback on page 2."],
        contradictions: [],
        pageIndexesToRevise: [2]
      }
    },
    {
      field: "a remark filed as a contradiction",
      verdict: {
        missingRequirements: [],
        contradictions: ["The second page could echo the first more closely."],
        pageIndexesToRevise: []
      }
    },
    {
      field: "a revision index repairing nothing",
      verdict: { missingRequirements: [], contradictions: [], pageIndexesToRevise: [2] }
    }
  ])("keeps a satisfied verdict that also volunteers $field", async ({ verdict }) => {
    const { model } = modelReturning({ satisfied: true, confidence: 0.9, ...verdict });

    const result = await reviewAppliedBookEdit({
      instruction: "Reveal a red key across pages 1 and 2.",
      beforePages: [
        { index: 1, title: "One", markdown: "Old one", summary: "Old one" },
        { index: 2, title: "Two", markdown: "Old two", summary: "Old two" }
      ],
      afterPages: [
        { index: 1, title: "One", markdown: "New one", summary: "New one" },
        { index: 2, title: "Two", markdown: "New two", summary: "New two" }
      ],
      textModel: model
    });

    // A satisfied verdict carries no repair order, so the caller neither
    // redrafts every named page three times nor refunds a delivered edit.
    expect(result).toMatchObject({
      satisfied: true,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    });
  });

  it("budgets the whole-set review for a verbose verdict its own schema permits", async () => {
    // Both prose lists filled to their schema bounds in a script that tokenizes
    // near one character per token — the density this review budgets against.
    const prose = (index: number) => {
      const prefix = `${index} `;
      return `${prefix}${"न".repeat(500 - prefix.length)}`;
    };
    const verdict = {
      satisfied: false,
      confidence: 0.9,
      missingRequirements: Array.from({ length: 30 }, (_, index) => prose(index)),
      contradictions: Array.from({ length: 30 }, (_, index) => prose(index + 30)),
      pageIndexesToRevise: [1]
    };
    const generateJson = vi.fn(async (options: GenerateJsonOptions<unknown>) => {
      // A provider that honours its output cap fails the way the historical
      // 1,200-token response did when it was cut off mid-JSON.
      if (JSON.stringify(verdict).length > (options.maxTokens ?? 0)) {
        throw new SyntaxError("Unexpected end of JSON input");
      }
      return { data: verdict, model: "reviewer", provider: "test" };
    });

    const result = await reviewAppliedBookEdit({
      instruction: "Reveal a red key across page 1.",
      beforePages: [{ index: 1, title: "One", markdown: "Old one", summary: "Old one" }],
      afterPages: [{ index: 1, title: "One", markdown: "New one", summary: "New one" }],
      textModel: { generateJson } as unknown as TextModelAdapter
    });

    expect(result.missingRequirements).toEqual(verdict.missingRequirements);
    expect(result.contradictions).toEqual(verdict.contradictions);
    expect(JSON.stringify(verdict).length).toBeGreaterThan(8_000);
    expect(generateJson.mock.calls[0]![0].maxTokens).toBe(31_380);
    expect(generateJson.mock.calls[0]![0].maxTokens).toBeGreaterThanOrEqual(JSON.stringify(verdict).length);
  });

  it("repairs one truncated whole-set verdict before failing the review closed", async () => {
    const verdict = {
      satisfied: true,
      confidence: 0.97,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: []
    };
    const generateJson = vi
      .fn()
      .mockRejectedValueOnce(new SyntaxError("Unexpected end of JSON input"))
      .mockResolvedValueOnce({ data: verdict, model: "reviewer", provider: "test" });

    const result = await reviewAppliedBookEdit({
      instruction: "Reveal a red key across page 1.",
      beforePages: [{ index: 1, title: "One", markdown: "Old one", summary: "Old one" }],
      afterPages: [{ index: 1, title: "One", markdown: "A red key glints.", summary: "A key appears" }],
      textModel: { generateJson } as unknown as TextModelAdapter
    });

    expect(result).toMatchObject({ basis: "reviewed", satisfied: true });
    expect(generateJson).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      satisfied: true,
      missingRequirements: [],
      contradictions: [],
      pageIndexesToRevise: [],
      expectedIndexes: []
    },
    {
      satisfied: false,
      missingRequirements: ["The red key is missing."],
      contradictions: [],
      pageIndexesToRevise: [2],
      expectedIndexes: [2]
    }
  ])(
    "preserves an internally consistent satisfied=$satisfied verdict",
    async ({ expectedIndexes, ...verdict }) => {
      const { model } = modelReturning({ confidence: 0.9, ...verdict });

      const result = await reviewAppliedBookEdit({
        instruction: "Reveal a red key across pages 1 and 2.",
        beforePages: [
          { index: 1, title: "One", markdown: "Old one", summary: "Old one" },
          { index: 2, title: "Two", markdown: "Old two", summary: "Old two" }
        ],
        afterPages: [
          { index: 1, title: "One", markdown: "New one", summary: "New one" },
          { index: 2, title: "Two", markdown: "New two", summary: "New two" }
        ],
        textModel: model
      });

      expect(result.satisfied).toBe(verdict.satisfied);
      expect(result.pageIndexesToRevise).toEqual(expectedIndexes);
    }
  );

  // `MOCK_AI=true` is how this repo is worked on, so a dry run has to be able
  // to reach the half of this protocol that costs the reader money.
  it.each([
    { name: "an ordinary dry run", suffix: "", expected: { satisfied: true, missingRequirements: [], basis: "reviewed" } },
    {
      name: "a dry run that asks for a refusal",
      suffix: " [mock-adherence:unsatisfied]",
      expected: { satisfied: false, pageIndexesToRevise: [1], basis: "reviewed" }
    },
    {
      name: "a dry run that asks for a truncated response",
      suffix: " [mock-adherence:truncated]",
      expected: {
        satisfied: false,
        confidence: 0,
        basis: "unverified",
        missingRequirements: ["The complete edit could not be verified against the approved instruction."]
      }
    },
    {
      name: "a dry run whose adherence provider fails",
      suffix: " [mock-adherence:failed]",
      expected: {
        satisfied: false,
        confidence: 0,
        basis: "unverified",
        missingRequirements: ["The complete edit could not be verified against the approved instruction."]
      }
    }
  ])("reviews $name against the fake adapter", async ({ suffix, expected }) => {
    const verdict = await reviewAppliedBookEdit({
      instruction: `Reveal a red key.${suffix}`,
      beforePages: [{ index: 1, title: "One", markdown: "Old one", summary: "Old one" }],
      afterPages: [{ index: 1, title: "One", markdown: "New one", summary: "New one" }],
      textModel: new FakeTextModelAdapter()
    });

    expect(verdict).toMatchObject(expected);
  });

  it.each([
    { path: "a satisfied whole-set review", data: { satisfied: true, confidence: 1, missingRequirements: [], contradictions: [], pageIndexesToRevise: [] } },
    { path: "a refusing whole-set review", data: { satisfied: false, confidence: 0.9, missingRequirements: ["The red key is missing."], contradictions: [], pageIndexesToRevise: [1] } }
  ])("reports $path as reviewed", async ({ data }) => {
    const { model } = modelReturning(data);

    const verdict = await reviewAppliedBookEdit({
      instruction: "Reveal a red key.",
      beforePages: [{ index: 1, title: "One", markdown: "Old one", summary: "Old one" }],
      afterPages: [{ index: 1, title: "One", markdown: "New one", summary: "New one" }],
      textModel: model
    });

    expect(verdict.basis).toBe("reviewed");
  });

  it("reports a computed exact replacement as reviewed", async () => {
    const { model } = modelReturning({});
    const verdict = await reviewAppliedBookEdit({
      instruction: "Replace Rabbit with Fox.",
      beforePages: [{ index: 1, title: "Rabbit", markdown: "Rabbit ran.", summary: "Rabbit runs" }],
      afterPages: [{ index: 1, title: "Fox", markdown: "Fox ran.", summary: "Fox runs" }],
      exactReplacement: { from: "Rabbit", to: "Fox" },
      textModel: model
    });

    // The most certain verification here, not the absence of one.
    expect(verdict.basis).toBe("reviewed");
  });

  it("reports a review that never completed as unverified, durably", async () => {
    const generateJson = vi.fn(async () => Promise.reject(new Error("Provider returned 500")));

    const verdict = await reviewAppliedBookEdit({
      instruction: "Reveal a red key.",
      beforePages: [{ index: 1, title: "One", markdown: "Old one", summary: "Old one" }],
      afterPages: [{ index: 1, title: "One", markdown: "New one", summary: "New one" }],
      textModel: { generateJson } as unknown as TextModelAdapter
    });

    expect(verdict.basis).toBe("unverified");
    // A caller reads one field, never the shape of the other five — and the
    // audit rows that carry this verdict into `BookEditOperation.adherenceAudit`
    // store it as plain JSON, so the distinction outlives the process.
    expect(JSON.parse(JSON.stringify({ verdict, attempts: 1 })).verdict.basis).toBe("unverified");
  });

  it("checks exact replacements locally without calling the model", async () => {
    const { model, generateJson } = modelReturning({});
    const verdict = await reviewAppliedBookEdit({
      instruction: "Replace Rabbit with Fox.",
      beforePages: [{ index: 1, title: "Rabbit", markdown: "Rabbit ran.", summary: "Rabbit runs" }],
      afterPages: [{ index: 1, title: "Fox", markdown: "Fox ran.", summary: "Fox runs" }],
      exactReplacement: { from: "Rabbit", to: "Fox" },
      textModel: model
    });

    expect(verdict).toMatchObject({ satisfied: true, confidence: 1, pageIndexesToRevise: [] });
    expect(generateJson).not.toHaveBeenCalled();
  });

  it("does not turn provider cancellation into a repairable adherence failure", async () => {
    const cancellation = Object.assign(new Error("Stopped"), { name: "AbortError" });
    const generateJson = vi.fn(async () => Promise.reject(cancellation));
    const model = { generateJson } as unknown as TextModelAdapter;

    await expect(
      reviewAppliedBookEdit({
        instruction: "Change the page.",
        beforePages: [{ index: 1, title: "One", markdown: "Before", summary: "Before" }],
        afterPages: [{ index: 1, title: "One", markdown: "After", summary: "After" }],
        textModel: model
      })
    ).rejects.toBe(cancellation);
  });

  it.each([
    {
      name: "compound instruction",
      instruction: 'Replace "Rabbit" with "Fox" and make the tone darker.',
      replacement: { from: "Rabbit", to: "Fox" }
    },
    {
      name: "durable instruction mismatch",
      instruction: 'Replace "Rabbit" with "Hare".',
      replacement: { from: "Rabbit", to: "Fox" }
    },
    {
      name: "ambiguous unquoted noun phrase",
      instruction: "Rename the hero Rabbit to Fox everywhere.",
      replacement: { from: "hero Rabbit", to: "Fox" }
    }
  ])("uses the full model adherence review for a $name", async ({ instruction, replacement }) => {
    const { model, generateJson } = modelReturning({
      satisfied: false,
      confidence: 0.99,
      missingRequirements: ["The additional instruction is missing."],
      contradictions: [],
      pageIndexesToRevise: [1]
    });

    const verdict = await reviewAppliedBookEdit({
      instruction,
      beforePages: [{ index: 1, title: "Rabbit", markdown: "Rabbit ran.", summary: "Rabbit runs" }],
      afterPages: [{ index: 1, title: "Fox", markdown: "Fox ran.", summary: "Fox runs" }],
      exactReplacement: replacement,
      textModel: model
    });

    expect(verdict.satisfied).toBe(false);
    expect(generateJson).toHaveBeenCalledOnce();
    expect(generateJson.mock.calls[0]![0].purpose).toBe("review-edit-adherence");
  });
});
