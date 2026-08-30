import { describe, expect, it, vi } from "vitest";

import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { reviewAppliedBookEdit } from "./editAdherence.js";
import {
  canonicalAdherencePageText,
  EDIT_ADHERENCE_EVIDENCE_CAPACITY,
  EDIT_ADHERENCE_MESSAGE_BUDGET_BYTES,
  reviewHierarchically,
  serializedAdherenceMessageBytes
} from "./editAdherenceHierarchy.js";

type Payload = Record<string, unknown>;
type ProtocolOptions = {
  malformedLeafCoverage?: boolean;
  malformedReducerCoverage?: boolean;
  evidenceComplete?: boolean;
  finalIndexes?: number[];
  finalNegativeIds?: "missing" | "duplicate" | "reordered";
  reducerFactIds?: "missing" | "duplicate" | "reordered";
  duplicateLeafEvidence?: boolean;
  resolvePossibleOmissions?: boolean;
  negativeEvidencePadding?: number;
  observedChangeCount?: number;
  reducerOutputCount?: number;
  /** Prose the final call volunteers whatever it answered. */
  finalRemark?: string;
  /** Report complete evidence only for a group no larger than this. */
  completeAtOrBelow?: number;
};

function protocolModel(options: ProtocolOptions = {}) {
  let leafCount = 0;
  let reducerCount = 0;
  const generateJson = vi.fn(async (request: GenerateJsonOptions<unknown>) => {
    const payload = userPayload(request);
    const phase = payload.reviewPhase;
    let data: unknown;
    if (phase === "collect-evidence") {
      leafCount += 1;
      const segments = records(payload.segments);
      const text = segments.map((segment) => String(segment.content ?? "")).join("");
      const requirementEvidence = ["Alpha", "Omega"].filter((term) => text.includes(term));
      const possibleOmissions = markerEvidence(text, "OMISSION", options.negativeEvidencePadding);
      const contradictions = markerEvidence(text, "CONTRADICTION", options.negativeEvidencePadding);
      data = {
        acceptedInputIds: inputIds(segments, Boolean(options.malformedLeafCoverage && leafCount === 1)),
        evidenceComplete:
          options.completeAtOrBelow === undefined
            ? options.evidenceComplete ?? true
            : segments.length <= options.completeAtOrBelow,
        observedChanges: duplicated(observedChanges(text, options.observedChangeCount), options.duplicateLeafEvidence),
        requirementEvidence,
        possibleOmissions: duplicated(possibleOmissions, options.duplicateLeafEvidence),
        contradictions: [
          ...(text.includes("blue key") ? ["The candidate introduces a blue key contradiction."] : []),
          ...contradictions
        ],
        pageIndexes: uniqueNumbers(segments.map((segment) => segment.pageIndex))
      };
    } else if (phase === "reduce-evidence") {
      reducerCount += 1;
      const nodes = records(payload.evidenceNodes);
      data = {
        acceptedInputIds: inputIds(nodes, Boolean(options.malformedReducerCoverage && reducerCount === 1)),
        evidenceComplete: options.evidenceComplete ?? true,
        observedChanges: malformedSummaries(
          options.reducerOutputCount === undefined
            ? summarizedEvidence(nodes, "observedChanges")
            : splitSummaries(nodes, "observedChanges", options.reducerOutputCount),
          options.reducerFactIds
        ),
        requirementEvidence: summarizedEvidence(nodes, "requirementEvidence")
      };
    } else if (phase === "global-verdict") {
      const coverage = record(payload.completeCoverage);
      const evidence = record(payload.evidence);
      const negativeEvidence = record(payload.negativeEvidence);
      const requirementEvidence = factTexts(evidence?.requirementEvidence);
      const possibleOmissions = factRecords(negativeEvidence?.possibleOmissions);
      const contradictionFacts = factRecords(negativeEvidence?.contradictions);
      const contradictions = contradictionFacts.map((fact) => String(fact.text));
      const negativeIds = [...possibleOmissions, ...contradictionFacts].map((fact) => String(fact.id));
      const distributedRequirementSatisfied = ["Alpha", "Omega"].every((term) =>
        requirementEvidence.some((fact) => fact.includes(term))
      );
      const satisfied = contradictions.length === 0 &&
        (!String(payload.approvedInstruction).includes("Alpha and Omega") || distributedRequirementSatisfied);
      const acceptedNegativeFactIds = malformedNegativeIds(negativeIds, options.finalNegativeIds);
      data = {
        satisfied,
        confidence: 0.95,
        missingRequirements: [
          ...(satisfied || contradictions.length > 0 ? [] : ["Alpha and Omega were not both evidenced."]),
          ...(options.finalRemark ? [options.finalRemark] : [])
        ],
        contradictions,
        pageIndexesToRevise: options.finalIndexes ?? (satisfied ? [] : [1]),
        acceptedEvidenceId: coverage?.evidenceId,
        coverageDigest: coverage?.digest,
        evidenceDigest: coverage?.evidenceDigest,
        acceptedNegativeFactIds,
        resolvedPossibleOmissionIds: options.resolvePossibleOmissions
          ? possibleOmissions.map((fact) => String(fact.id))
          : []
      };
    } else {
      data = {
        satisfied: true,
        confidence: 1,
        missingRequirements: [],
        contradictions: [],
        pageIndexesToRevise: []
      };
    }
    return { data, model: "bounded-reviewer", provider: "test" };
  });
  return { model: { generateJson } as unknown as TextModelAdapter, generateJson };
}

describe("hierarchical edit adherence coverage", () => {
  it("covers a near-20MB 600-page manuscript without exceeding the serialized-message budget", async () => {
    const markdown = "0123456789abcdef".repeat(1032);
    const beforePages = Array.from({ length: 600 }, (_, position) => page(position + 1, `before-${position}-${markdown}`));
    const afterPages = Array.from({ length: 600 }, (_, position) => page(position + 1, `after-${position}-${markdown}`));
    const { model, generateJson } = protocolModel();

    const verdict = await reviewAppliedBookEdit({
      instruction: "Keep every page while changing the before marker to after.",
      beforePages,
      afterPages,
      textModel: model
    });

    expect(verdict.satisfied).toBe(true);
    expect(Buffer.byteLength(markdown, "utf8") * 1200).toBeGreaterThan(19_000_000);
    expect(generateJson.mock.calls.length).toBeGreaterThan(1200);
    assertEveryCallFits(generateJson.mock.calls);

    const reconstructed = reconstructSegments(generateJson.mock.calls);
    expect(reconstructed.size).toBe(1200);
    for (let position = 0; position < 600; position += 1) {
      expect(reconstructed.get(`before:${position}`)).toBe(canonicalAdherencePageText(beforePages[position]!));
      expect(reconstructed.get(`after:${position}`)).toBe(canonicalAdherencePageText(afterPages[position]!));
    }
  }, 60_000);

  it("segments one oversized Unicode page at stable contiguous offsets without dropping content", async () => {
    const huge = `start-${"🙂quoted \\\" text\n".repeat(4000)}-end`;
    const before = page(7, huge);
    const after = page(7, huge.replace("start", "changed"));
    const { model, generateJson } = protocolModel();

    await reviewAppliedBookEdit({ instruction: "Change start to changed.", beforePages: [before], afterPages: [after], textModel: model });

    assertEveryCallFits(generateJson.mock.calls);
    const reconstructed = reconstructSegments(generateJson.mock.calls);
    expect(reconstructed.get("before:0")).toBe(canonicalAdherencePageText(before));
    expect(reconstructed.get("after:0")).toBe(canonicalAdherencePageText(after));
    const leafSegments = collectSegments(generateJson.mock.calls);
    expect(leafSegments.filter((segment) => segment.side === "after").length).toBeGreaterThan(2);
    assertContiguousOffsets(leafSegments);
  });

  it("accepts a requirement whose evidence is distributed across separate chunks", async () => {
    const { model } = protocolModel();
    const verdict = await reviewAppliedBookEdit({
      instruction: "Add Alpha and Omega across the edited pages.",
      beforePages: [page(1, "old".repeat(6000)), page(2, "old".repeat(6000))],
      afterPages: [page(1, `Alpha ${"middle".repeat(5000)}`), page(2, `Omega ${"ending".repeat(5000)}`)],
      textModel: model
    });

    expect(verdict).toMatchObject({ satisfied: true, missingRequirements: [], contradictions: [] });
  });

  it("carries a contradiction from one chunk into the final false verdict", async () => {
    const { model } = protocolModel();
    const verdict = await reviewAppliedBookEdit({
      instruction: "Make the key red throughout.",
      beforePages: [page(1, "old".repeat(6000))],
      afterPages: [page(1, `${"changed ".repeat(4000)} blue key`)],
      textModel: model
    });

    expect(verdict.satisfied).toBe(false);
    expect(verdict.contradictions).toContain("The candidate introduces a blue key contradiction.");
  });

  it("preserves more than four distinct omissions found in one leaf", async () => {
    const { model } = protocolModel();
    const omissions = markerBlock("OMISSION", 6);
    const verdict = await reviewAppliedBookEdit({
      instruction: "Apply every requested change.",
      beforePages: [page(1, "before".repeat(5000))],
      afterPages: [page(1, `${omissions}${"after".repeat(5000)}`)],
      textModel: model
    });

    expect(verdict.satisfied).toBe(false);
    expect(verdict.missingRequirements).toEqual(Array.from({ length: 6 }, (_, index) => `omission-${index}`));
  });

  it("carries distinct omissions losslessly across reducer children", async () => {
    const { model, generateJson } = protocolModel();
    const afterPages = Array.from({ length: 6 }, (_, index) =>
      page(index + 1, `[OMISSION:${index}] changed ${"after".repeat(2200)}`)
    );
    const verdict = await reviewAppliedBookEdit({
      instruction: "Apply all six changes across the book.",
      beforePages: afterPages.map((entry) => ({ ...entry, markdown: entry.markdown.replace("changed", "before") })),
      afterPages,
      textModel: model
    });

    expect(phases(generateJson.mock.calls)).toContain("reduce-evidence");
    expect(verdict.missingRequirements).toEqual(Array.from({ length: 6 }, (_, index) => `omission-${index}`));
    // A refusal the protocol actually reached, told apart from one it did not.
    expect(verdict.basis).toBe("reviewed");
  });

  it("preserves many contradictions and forces the operation-level verdict false", async () => {
    const { model } = protocolModel();
    const verdict = await reviewAppliedBookEdit({
      instruction: "Keep the facts consistent.",
      beforePages: [page(1, "before".repeat(5000))],
      afterPages: [page(1, `${markerBlock("CONTRADICTION", 7)}${"after".repeat(5000)}`)],
      textModel: model
    });

    expect(verdict.satisfied).toBe(false);
    expect(verdict.contradictions).toEqual(
      Array.from({ length: 7 }, (_, index) => `contradiction-${index}`)
    );
  });

  it("keeps a negative evidence list that exactly fills the advertised capacity", async () => {
    const { model, generateJson } = protocolModel();
    const verdict = await reviewAppliedBookEdit({
      instruction: "Apply every requested change.",
      beforePages: [page(1, "before".repeat(5000))],
      afterPages: [
        page(1, `${markerBlock("OMISSION", EDIT_ADHERENCE_EVIDENCE_CAPACITY)}${"after".repeat(5000)}`)
      ],
      textModel: model
    });

    expect(phases(generateJson.mock.calls)).toContain("global-verdict");
    expect(verdict.missingRequirements).toEqual(
      Array.from({ length: EDIT_ADHERENCE_EVIDENCE_CAPACITY }, (_, index) => `omission-${index}`)
    );
  });

  it("verifies an applied edit whose leaf evidence fills the advertised capacity", async () => {
    const { model, generateJson } = protocolModel({
      observedChangeCount: EDIT_ADHERENCE_EVIDENCE_CAPACITY
    });
    const verdict = await reviewAppliedBookEdit({
      instruction: "Change the complete manuscript.",
      beforePages: [page(1, "before".repeat(5000))],
      afterPages: [page(1, "after".repeat(5000))],
      textModel: model
    });

    expect(phases(generateJson.mock.calls)).toContain("global-verdict");
    expect(verdict).toMatchObject({ satisfied: true, missingRequirements: [], contradictions: [] });
  });

  it("verifies an applied edit whose reduced evidence fills the advertised capacity", async () => {
    const { model, generateJson } = protocolModel({
      observedChangeCount: EDIT_ADHERENCE_EVIDENCE_CAPACITY / 2,
      reducerOutputCount: EDIT_ADHERENCE_EVIDENCE_CAPACITY
    });
    const verdict = await reviewAppliedBookEdit({
      instruction: "Change the complete manuscript.",
      beforePages: [page(1, "before".repeat(5000)), page(2, "before".repeat(5000))],
      afterPages: [page(1, "after".repeat(5000)), page(2, "after".repeat(5000))],
      textModel: model
    });

    expect(phases(generateJson.mock.calls)).toContain("reduce-evidence");
    expect(verdict).toMatchObject({ satisfied: true, missingRequirements: [], contradictions: [] });
  });

  it.each([
    { name: "the unadvertised overflow slot", count: EDIT_ADHERENCE_EVIDENCE_CAPACITY + 1 },
    { name: "the response schema", count: EDIT_ADHERENCE_EVIDENCE_CAPACITY + 2 }
  ])("fails closed on leaf evidence that overflows $name", async ({ count }) => {
    const { model, generateJson } = protocolModel();
    const verdict = await reviewAppliedBookEdit({
      instruction: "Apply every requested change.",
      beforePages: [page(1, "before".repeat(5000))],
      afterPages: [page(1, `${markerBlock("OMISSION", count)}${"after".repeat(5000)}`)],
      textModel: model
    });

    expect(verdict).toMatchObject({
      satisfied: false,
      confidence: 0,
      missingRequirements: ["The complete edit could not be verified against the approved instruction."]
    });
    expect(phases(generateJson.mock.calls)).not.toContain("global-verdict");
  });

  it("reports a negative set far past the old final-review capacity instead of refunding the edit", async () => {
    const { model, generateJson } = protocolModel();
    const afterPages = Array.from({ length: 49 }, (_, index) =>
      page(index + 1, `[OMISSION:${index}]${"after".repeat(700)}`)
    );
    const verdict = await reviewAppliedBookEdit({
      instruction: "Apply every requested change across the full book.",
      beforePages: afterPages.map((entry) => page(entry.index, "before".repeat(700))),
      afterPages,
      textModel: model
    });

    expect(phases(generateJson.mock.calls)).toContain("global-verdict");
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missingRequirements).toEqual(
      Array.from({ length: 49 }, (_, index) => `omission-${index}`)
    );
  }, 20_000);

  it("fails closed before the final model call when lossless negative evidence exceeds final capacity", async () => {
    const { model, generateJson } = protocolModel();
    const afterPages = Array.from({ length: 97 }, (_, index) =>
      page(index + 1, `[OMISSION:${index}]${"after".repeat(700)}`)
    );
    const verdict = await reviewAppliedBookEdit({
      instruction: "Apply every requested change across the full book.",
      beforePages: afterPages.map((entry) => page(entry.index, "before".repeat(700))),
      afterPages,
      textModel: model
    });

    expect(verdict).toMatchObject({ satisfied: false, confidence: 0 });
    expect(phases(generateJson.mock.calls)).not.toContain("global-verdict");
  }, 20_000);

  it("fails closed before the final model call when complete negative evidence makes that request oversized", async () => {
    const { model, generateJson } = protocolModel({ negativeEvidencePadding: 150 });
    const afterPages = Array.from({ length: 90 }, (_, index) =>
      page(index + 1, `[OMISSION:${index}]${"after".repeat(1200)}`)
    );
    const verdict = await reviewAppliedBookEdit({
      instruction: `Apply every detail. ${"instruction ".repeat(450)}`,
      beforePages: afterPages.map((entry) => page(entry.index, "before".repeat(1200))),
      afterPages,
      textModel: model
    });

    expect(verdict).toMatchObject({ satisfied: false, confidence: 0 });
    expect(phases(generateJson.mock.calls)).toContain("reduce-evidence");
    expect(phases(generateJson.mock.calls)).not.toContain("global-verdict");
  }, 20_000);

  it("fails closed when a provider explicitly reports incomplete evidence", async () => {
    const { model, generateJson } = protocolModel({ evidenceComplete: false });
    const verdict = await reviewAppliedBookEdit({
      instruction: "Change the complete manuscript.",
      beforePages: [page(1, "before".repeat(5000))],
      afterPages: [page(1, "after".repeat(5000))],
      textModel: model
    });

    expect(verdict.satisfied).toBe(false);
    expect(verdict.confidence).toBe(0);
    expect(phases(generateJson.mock.calls)).not.toContain("global-verdict");
  });

  it("fails closed when a hierarchical provider response is truncated or malformed", async () => {
    const generateJson = vi.fn(async (_request: GenerateJsonOptions<unknown>) =>
      Promise.reject(new Error("Provider response ended mid-JSON"))
    );
    const model = { generateJson } as unknown as TextModelAdapter;
    const verdict = await reviewAppliedBookEdit({
      instruction: "Change the complete manuscript.",
      beforePages: [page(1, "before".repeat(5000))],
      afterPages: [page(1, "after".repeat(5000))],
      textModel: model
    });

    expect(verdict).toMatchObject({
      satisfied: false,
      confidence: 0,
      // A caller that answers a refusal by deleting the pages it drafted needs
      // one field to tell "the reviewer refused" from "no reviewer ran".
      basis: "unverified",
      missingRequirements: ["The complete edit could not be verified against the approved instruction."]
    });
    expect(generateJson).toHaveBeenCalled();
    expect(new Set(phases(generateJson.mock.calls))).toEqual(new Set(["collect-evidence"]));
  });

  it("collapses a repeated leaf fact instead of discarding the evidence", async () => {
    const { model } = protocolModel({ duplicateLeafEvidence: true });
    const verdict = await reviewAppliedBookEdit({
      instruction: "Apply every requested change.",
      beforePages: [page(1, "before".repeat(5000))],
      afterPages: [page(1, `[OMISSION:1]${"after".repeat(5000)}`)],
      textModel: model
    });

    expect(verdict).toMatchObject({
      satisfied: false,
      confidence: 0.95,
      missingRequirements: ["omission-1"]
    });
  });

  it("verifies an applied edit whose leaf repeated one observation", async () => {
    const { model } = protocolModel({ duplicateLeafEvidence: true });
    const verdict = await reviewAppliedBookEdit({
      instruction: "Change the complete manuscript.",
      beforePages: [page(1, "before".repeat(5000))],
      afterPages: [page(1, `changed ${"after".repeat(5000)}`)],
      textModel: model
    });

    expect(verdict).toMatchObject({ satisfied: true, confidence: 0.95, missingRequirements: [] });
  });

  it.each(["missing", "duplicate", "reordered"] as const)(
    "fails closed on %s reducer fact lineage",
    async (reducerFactIds) => {
      const { model, generateJson } = protocolModel({ reducerFactIds });
      const verdict = await reviewAppliedBookEdit({
        instruction: "Preserve changed markers throughout.",
        beforePages: [page(1, "before".repeat(5000)), page(2, "before".repeat(5000))],
        afterPages: [page(1, `changed ${"after".repeat(5000)}`), page(2, `changed ${"after".repeat(5000)}`)],
        textModel: model
      });

      expect(verdict).toMatchObject({ satisfied: false, confidence: 0 });
      expect(phases(generateJson.mock.calls)).not.toContain("global-verdict");
    }
  );

  it.each(["missing", "duplicate", "reordered"] as const)(
    "fails closed on %s final negative fact acceptance",
    async (finalNegativeIds) => {
      const { model } = protocolModel({ finalNegativeIds });
      const verdict = await reviewAppliedBookEdit({
        instruction: "Keep the facts consistent.",
        beforePages: [page(1, "before".repeat(5000))],
        afterPages: [page(1, `${markerBlock("CONTRADICTION", 2)}${"after".repeat(5000)}`)],
        textModel: model
      });

      expect(verdict).toMatchObject({
        satisfied: false,
        confidence: 0,
        missingRequirements: ["The complete edit could not be verified against the approved instruction."]
      });
    }
  );

  it.each([
    { name: "leaf", protocol: { malformedLeafCoverage: true } },
    { name: "reducer", protocol: { malformedReducerCoverage: true } }
  ])("fails closed when $name coverage is missing or malformed", async ({ protocol }) => {
    const { model, generateJson } = protocolModel(protocol);
    const verdict = await reviewAppliedBookEdit({
      instruction: "Change the complete manuscript.",
      beforePages: [page(1, "before".repeat(6000)), page(2, "before".repeat(6000))],
      afterPages: [page(1, "after".repeat(6000)), page(2, "after".repeat(6000))],
      textModel: model
    });

    expect(verdict).toEqual({
      basis: "unverified",
      satisfied: false,
      confidence: 0,
      missingRequirements: ["The complete edit could not be verified against the approved instruction."],
      contradictions: [],
      pageIndexesToRevise: [1, 2]
    });
    expect(phases(generateJson.mock.calls)).not.toContain("global-verdict");
  });

  it("recursively reduces large evidence sets while keeping every reduction call bounded", async () => {
    const pages = Array.from({ length: 180 }, (_, position) => page(position + 1, `changed-${position}-${"x".repeat(2200)}`));
    const { model, generateJson } = protocolModel();

    const verdict = await reviewAppliedBookEdit({
      instruction: "Preserve all pages and add a changed marker.",
      beforePages: pages.map((entry) => ({ ...entry, markdown: entry.markdown.replace("changed", "before") })),
      afterPages: pages,
      textModel: model
    });

    expect(verdict.satisfied).toBe(true);
    assertEveryCallFits(generateJson.mock.calls);
    const reducerLevels = generateJson.mock.calls
      .map(([request]) => userPayload(request))
      .filter((payload) => payload.reviewPhase === "reduce-evidence")
      .flatMap((payload) => records(payload.evidenceNodes).map((node) => Number(node.level)));
    expect(Math.max(...reducerLevels)).toBeGreaterThanOrEqual(1);
  });

  it("does not clamp schema-calculated leaf or final response budgets", async () => {
    const afterPages = Array.from({ length: 8 }, (_, index) => page(index + 1, `changed page ${index}`));
    const { model, generateJson } = protocolModel();

    const verdict = await reviewHierarchically({
      instruction: "Change every page.",
      beforePages: afterPages.map((entry) => ({ ...entry, markdown: `before page ${entry.index}` })),
      afterPages,
      textModel: model
    });

    expect(verdict.satisfied).toBe(true);
    const callsByPhase = new Map(
      generateJson.mock.calls.map(([request]) => [userPayload(request).reviewPhase, request])
    );
    expect(callsByPhase.get("collect-evidence")?.maxTokens).toBe(10_108);
    expect(callsByPhase.get("global-verdict")?.maxTokens).toBe(31_380);
  });

  it("verifies an edit whose final verdict must echo two leaves of negative fact ids", async () => {
    const { model, generateJson } = cappedProtocolModel({ resolvePossibleOmissions: true });
    const markers = markerBlock("OMISSION", EDIT_ADHERENCE_EVIDENCE_CAPACITY);
    const afterPages = [1, 2].map((index) => page(index, `${markers}${"after".repeat(5000)}`));
    const verdict = await reviewAppliedBookEdit({
      instruction: "Apply every requested change.",
      beforePages: afterPages.map((entry) => page(entry.index, "before".repeat(5000))),
      afterPages,
      textModel: model
    });

    expect(phases(generateJson.mock.calls)).toContain("global-verdict");
    expect(verdict).toMatchObject({ satisfied: true, confidence: 0.95, missingRequirements: [] });
  });

  it("halves a leaf group that reports incomplete evidence instead of failing the edit closed", async () => {
    const { model, generateJson } = protocolModel({ completeAtOrBelow: 4 });
    const afterPages = Array.from({ length: 8 }, (_, index) => page(index + 1, `changed page ${index}`));
    const verdict = await reviewHierarchically({
      instruction: "Change every page.",
      beforePages: afterPages.map((entry) => ({ ...entry, markdown: `before page ${entry.index}` })),
      afterPages,
      textModel: model
    });

    expect(verdict.satisfied).toBe(true);
    expect(phases(generateJson.mock.calls)).toContain("global-verdict");
    // One saturated call over sixteen segments, two over eight, four over four.
    expect(phases(generateJson.mock.calls).filter((phase) => phase === "collect-evidence")).toHaveLength(7);
  });

  it("fails closed once a halved leaf group is still saturated at the split bound", async () => {
    const { model, generateJson } = protocolModel({ completeAtOrBelow: 1 });
    const afterPages = Array.from({ length: 8 }, (_, index) => page(index + 1, `changed page ${index}`));

    await expect(
      reviewHierarchically({
        instruction: "Change every page.",
        beforePages: afterPages.map((entry) => ({ ...entry, markdown: `before page ${entry.index}` })),
        afterPages,
        textModel: model
      })
    ).rejects.toThrow(/incomplete/);
    expect(phases(generateJson.mock.calls)).not.toContain("global-verdict");
  });

  it("normalizes hierarchical revision indexes to indexes present in afterPages", async () => {
    const { model } = protocolModel({ finalIndexes: [2, 999] });
    const verdict = await reviewAppliedBookEdit({
      instruction: "Add Alpha and Omega across both pages.",
      beforePages: [page(1, "before".repeat(5000)), page(2, "before".repeat(5000))],
      afterPages: [page(1, "after".repeat(5000)), page(2, "after".repeat(5000))],
      textModel: model
    });

    expect(verdict.satisfied).toBe(false);
    expect(verdict.pageIndexesToRevise).toEqual([2]);
  });

  it("keeps a satisfied final verdict that also volunteered a remark", async () => {
    const remark = "The second page could echo the first more closely.";
    const { model } = protocolModel({ finalRemark: remark, finalIndexes: [2] });
    const verdict = await reviewAppliedBookEdit({
      instruction: "Change the complete manuscript.",
      beforePages: [page(1, "before".repeat(5000)), page(2, "before".repeat(5000))],
      afterPages: [page(1, "after".repeat(5000)), page(2, "after".repeat(5000))],
      textModel: model
    });

    // Only evidence code carries — an unresolved omission, a contradiction —
    // may outrank the boolean. The same call's own prose may not.
    expect(verdict).toMatchObject({ satisfied: true, missingRequirements: [], pageIndexesToRevise: [] });
  });

  it("halves a leaf group whose evidence overflowed the advertised capacity", async () => {
    const { model, generateJson } = protocolModel();
    const omissions = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => `[OMISSION:${from + index}]`).join(" ");
    const afterPages = [page(1, `${omissions(0, 5)} changed`), page(2, `${omissions(5, 4)} changed`)];
    const verdict = await reviewHierarchically({
      instruction: "Apply every requested change.",
      beforePages: afterPages.map((entry) => page(entry.index, "before")),
      afterPages,
      textModel: model
    });

    // Nine omissions over four segments, five and four over the halves: the
    // overflow slot is the same "give me less to read" the flag is, so the
    // group is re-asked rather than the whole review failing closed.
    expect(phases(generateJson.mock.calls).filter((phase) => phase === "collect-evidence")).toHaveLength(5);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missingRequirements).toEqual(
      Array.from({ length: 9 }, (_, index) => `omission-${index}`)
    );
  });
});

/**
 * A provider that honours its output cap at the worst density the review budget
 * claims to cover — one output token per response character — by failing the
 * way a body cut off mid-JSON does.
 */
function cappedProtocolModel(options: ProtocolOptions = {}) {
  const inner = protocolModel(options);
  const generateJson = vi.fn(async (request: GenerateJsonOptions<unknown>) => {
    const result = await inner.generateJson(request);
    if (JSON.stringify(result.data).length > (request.maxTokens ?? 0)) {
      throw new SyntaxError("Unexpected end of JSON input");
    }
    return result;
  });
  return { model: { generateJson } as unknown as TextModelAdapter, generateJson };
}

function page(index: number, markdown: string) {
  return { index, title: `Page ${index}`, markdown, summary: `Summary ${index}` };
}

function observedChanges(text: string, count: number | undefined): string[] {
  if (count !== undefined) {
    return Array.from({ length: count }, (_, index) => `observed-${index}`);
  }
  return text.includes("changed") ? ["Changed prose is present."] : [];
}

function duplicated(values: string[], duplicate: boolean | undefined): string[] {
  return duplicate && values.length > 0 ? [values[0]!, ...values] : values;
}

function markerBlock(kind: "OMISSION" | "CONTRADICTION", count: number): string {
  return Array.from({ length: count }, (_, index) => `[${kind}:${index}]`).join(" ");
}

function userPayload(request: GenerateJsonOptions<unknown>): Payload {
  const user = request.messages.find((message) => message.role === "user");
  return JSON.parse(user?.content ?? "{}") as Payload;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function inputIds(inputs: Array<Record<string, unknown>>, malformed: boolean): string[] {
  const ids = inputs.flatMap((input) => (typeof input.id === "string" ? [input.id] : []));
  return malformed ? ids.slice(1) : ids;
}

function summarizedEvidence(nodes: Array<Record<string, unknown>>, field: string) {
  const facts = nodes.flatMap((node) => factRecords(record(node.evidence)?.[field]));
  return facts.length === 0
    ? []
    : [{
        text: [...new Set(facts.map((fact) => String(fact.text)))].join(" / "),
        sourceFactIds: facts.map((fact) => String(fact.id))
      }];
}

/** Splits every supplied fact id across `count` summaries in order, so the reduced list can fill its capacity without breaking lineage. */
function splitSummaries(nodes: Array<Record<string, unknown>>, field: string, count: number) {
  const ids = nodes.flatMap((node) => factRecords(record(node.evidence)?.[field])).map((fact) => String(fact.id));
  if (ids.length === 0) {
    return [];
  }
  const size = Math.ceil(ids.length / Math.min(count, ids.length));
  const groups: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    groups.push(ids.slice(start, start + size));
  }
  return groups.map((sourceFactIds, index) => ({ text: `summary-${index}`, sourceFactIds }));
}

function uniqueNumbers(values: unknown[]): number[] {
  return [...new Set(values.filter((value): value is number => typeof value === "number"))];
}

function factRecords(value: unknown): Array<Record<string, unknown>> {
  return records(value).filter((fact) => typeof fact.id === "string" && typeof fact.text === "string");
}

function factTexts(value: unknown): string[] {
  return factRecords(value).map((fact) => String(fact.text));
}

function malformedNegativeIds(ids: string[], mode: ProtocolOptions["finalNegativeIds"]): string[] {
  if (mode === "missing") {
    return ids.slice(1);
  }
  if (mode === "duplicate" && ids.length > 0) {
    return [ids[0]!, ...ids];
  }
  return mode === "reordered" ? [...ids].reverse() : ids;
}

function markerEvidence(
  text: string,
  kind: "OMISSION" | "CONTRADICTION",
  padding = 0
): string[] {
  return [...text.matchAll(new RegExp(`\\[${kind}:(\\d+)\\]`, "g"))].map(
    (match) => `${kind.toLowerCase()}-${match[1]}${"x".repeat(padding)}`
  );
}

function malformedSummaries(
  summaries: Array<{ text: string; sourceFactIds: string[] }>,
  mode: ProtocolOptions["reducerFactIds"]
) {
  if (summaries.length === 0 || !mode) {
    return summaries;
  }
  const ids = summaries[0]!.sourceFactIds;
  const sourceFactIds = mode === "missing"
    ? ids.slice(1)
    : mode === "duplicate" && ids.length > 0
      ? [ids[0]!, ...ids]
      : [...ids].reverse();
  return [{ ...summaries[0]!, sourceFactIds }, ...summaries.slice(1)];
}

function assertEveryCallFits(calls: Array<[GenerateJsonOptions<unknown>, ...unknown[]]>): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const [request] of calls) {
    expect(serializedAdherenceMessageBytes(request.messages)).toBeLessThanOrEqual(
      EDIT_ADHERENCE_MESSAGE_BUDGET_BYTES
    );
  }
}

function collectSegments(calls: Array<[GenerateJsonOptions<unknown>, ...unknown[]]>) {
  return calls
    .map(([request]) => userPayload(request))
    .filter((payload) => payload.reviewPhase === "collect-evidence")
    .flatMap((payload) => records(payload.segments));
}

function reconstructSegments(calls: Array<[GenerateJsonOptions<unknown>, ...unknown[]]>): Map<string, string> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const segment of collectSegments(calls)) {
    const key = `${String(segment.side)}:${String(segment.pagePosition)}`;
    groups.set(key, [...(groups.get(key) ?? []), segment]);
  }
  return new Map(
    [...groups].map(([key, segments]) => [
      key,
      segments
        .sort((left, right) => Number(left.part) - Number(right.part))
        .map((segment) => String(segment.content ?? ""))
        .join("")
    ])
  );
}

function assertContiguousOffsets(segments: Array<Record<string, unknown>>): void {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const segment of segments) {
    const key = `${String(segment.side)}:${String(segment.pagePosition)}`;
    groups.set(key, [...(groups.get(key) ?? []), segment]);
  }
  for (const pageSegments of groups.values()) {
    pageSegments.sort((left, right) => Number(left.part) - Number(right.part));
    expect(pageSegments[0]?.charStart).toBe(0);
    expect(pageSegments[0]?.byteStart).toBe(0);
    for (let index = 1; index < pageSegments.length; index += 1) {
      expect(pageSegments[index]?.charStart).toBe(pageSegments[index - 1]?.charEnd);
      expect(pageSegments[index]?.byteStart).toBe(pageSegments[index - 1]?.byteEnd);
    }
  }
}

function phases(calls: Array<[GenerateJsonOptions<unknown>, ...unknown[]]>): unknown[] {
  return calls.map(([request]) => userPayload(request).reviewPhase);
}
