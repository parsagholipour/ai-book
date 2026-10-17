import { describe, expect, it } from "vitest";
import { groupFeatureRows, shelvedRowState } from "./GenerationQualityGateGroups.js";
import { featureRows, readQualityHead } from "./GenerationQualityScreen.js";
import { generationQualityResponse } from "./generationQualityTestFixtures.js";

describe("shelved gates", () => {
  const response = () => {
    const base = generationQualityResponse();
    return {
      ...base,
      features: [
        { id: "writerTools", label: "Writer tools", summary: "One cheap call per book.", pipelines: ["planning"] },
        { id: "chapterFocus", shelved: true, label: "Chapter focus", summary: "Shelved arm.", pipelines: ["composed"] },
        { id: "figures", label: "Figures", summary: "Charts.", pipelines: ["composed"] }
      ]
    };
  };

  it("keeps the flag the server sends, so the row is never offered per tier", () => {
    const head = readQualityHead(JSON.parse(JSON.stringify(response())) as unknown);
    expect(head?.features.find((feature) => feature.id === "chapterFocus")).toMatchObject({ shelved: true });
    expect(head?.features.find((feature) => feature.id === "figures")).not.toHaveProperty("shelved");
  });

  it("lists shelved rows last, in a group of their own, and nowhere else", () => {
    const groups = groupFeatureRows(featureRows(response()));
    expect(groups.at(-1)).toMatchObject({ pipeline: "shelved", title: "Shelved" });
    expect(groups.at(-1)!.rows.map((row) => row.id)).toEqual(["chapterFocus"]);
    const composed = groups.find((group) => group.pipeline === "composed")!;
    expect(composed.rows.map((row) => row.id)).toContain("figures");
    expect(composed.rows.map((row) => row.id)).not.toContain("chapterFocus");
  });

  it("says where a stored revision still runs a shelved gate", () => {
    expect(shelvedRowState([])).toBe("Off on every tier.");
    expect(shelvedRowState(["balanced"])).toBe("Still on in the stored revision for: balanced.");
  });
});

describe("removed gates", () => {
  const response = () => {
    const base = generationQualityResponse();
    return {
      ...base,
      settings: { ...base.settings, chapterEditorPass: ["ultra", "premium", "balanced", "fast"] },
      features: [
        { id: "writerTools", label: "Writer tools", summary: "One cheap call per book.", pipelines: ["planning"] },
        { id: "chapterEditorPass", retired: true, label: "Chapter line edit (removed)", summary: "Removed 2026-10-16: blind readers preferred the draft.", pipelines: [] }
      ]
    };
  };

  it("lists a removed gate last, with its reason, even when a stored revision still names tiers for it", () => {
    const groups = groupFeatureRows(featureRows(response()));
    expect(groups.at(-1)).toMatchObject({ pipeline: "removed", title: "Removed" });
    expect(groups.at(-1)!.rows).toEqual([expect.objectContaining({ id: "chapterEditorPass", retired: true, summary: expect.stringContaining("Removed 2026-10-16") })]);
    expect(groups.slice(0, -1).flatMap((group) => group.rows.map((row) => row.id))).not.toContain("chapterEditorPass");
  });
});
