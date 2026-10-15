import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SafetySettingsPanel,
  draftFromSettings,
  safetyDraftChanged,
  safetySettingsPatch,
  type SafetyDraft,
  type SafetySettings
} from "./SafetySettingsScreen.js";

function settings(overrides: Partial<SafetySettings> = {}): SafetySettings {
  return {
    version: 0,
    copyrightRestrictionsEnabled: false,
    sexualContentFilterEnabled: true,
    note: null,
    updatedBy: null,
    updatedAt: null,
    ...overrides
  };
}

function render(value: SafetySettings, draft: SafetyDraft = draftFromSettings(value)) {
  return renderToStaticMarkup(
    <SafetySettingsPanel
      settings={value}
      draft={draft}
      note=""
      busy={false}
      onDraftChange={() => undefined}
      onNoteChange={() => undefined}
      onSave={() => undefined}
    />
  );
}

describe("safety settings", () => {
  it("shows the sexual-content filter on by default, with what it does", () => {
    const html = render(settings());

    expect(html).toContain("Sexual-content filter");
    expect(html).toContain("Filter on");
    expect(html).toContain("anything sexual or romantic involving anyone under 18");
    expect(html).toContain("built-in default");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Save setting/s);
  });

  it("reads an API that predates the switch as filter on", () => {
    const legacy = settings();
    delete legacy.sexualContentFilterEnabled;
    expect(draftFromSettings(legacy).sexualContentFilterEnabled).toBe(true);
  });

  it("round-trips a change: the draft differs, the patch names both switches, the saved answer settles it", () => {
    const current = settings({ version: 2, copyrightRestrictionsEnabled: true });
    const draft = { ...draftFromSettings(current), sexualContentFilterEnabled: false };

    expect(safetyDraftChanged(current, draft)).toBe(true);
    expect(render(current, draft)).toContain("Filter off");
    expect(safetySettingsPatch(draft, "  adult fiction pilot ")).toEqual({
      copyrightRestrictionsEnabled: true,
      sexualContentFilterEnabled: false,
      note: "adult fiction pilot"
    });

    const saved = settings({ version: 3, copyrightRestrictionsEnabled: true, sexualContentFilterEnabled: false });
    expect(safetyDraftChanged(saved, draftFromSettings(saved))).toBe(false);
    expect(safetySettingsPatch(draftFromSettings(saved), "")).not.toHaveProperty("note");
  });
});
