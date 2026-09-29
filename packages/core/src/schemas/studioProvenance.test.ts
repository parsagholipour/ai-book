import { describe, expect, it } from "vitest";
import {
  isAuthorManuscript,
  isImportedManuscript,
  isStudioManuscript,
  studioLayoutFromMediaSettings,
  studioSettingsFromMediaSettings
} from "./mediaSettings.js";

describe("author manuscript provenance", () => {
  const studio = { mobile: { studio: { layout: "picture", kind: "picture", createdAt: "2026-09-29T00:00:00.000Z" } } };
  const imported = { mobile: { import: { importId: "i1", fileName: "a.docx" } } };

  it("tells a Studio book, an import and a generated book apart", () => {
    expect(isStudioManuscript(studio)).toBe(true);
    expect(isAuthorManuscript(studio)).toBe(true);
    expect(isImportedManuscript(studio)).toBe(false);
    expect(isAuthorManuscript(imported)).toBe(true);
    expect(isStudioManuscript(imported)).toBe(false);
    expect(isAuthorManuscript({ fullIllustrations: true })).toBe(false);
    expect(isAuthorManuscript(null)).toBe(false);
  });

  it("reads the layout only off a valid studio record", () => {
    expect(studioLayoutFromMediaSettings(studio)).toBe("picture");
    expect(studioLayoutFromMediaSettings({ mobile: { studio: { layout: "scroll" } } })).toBeNull();
    expect(studioLayoutFromMediaSettings(imported)).toBeNull();
  });

  it("keeps a taken-over book a Studio book, whatever its origin says", () => {
    const takeover = { mobile: { studio: { ...studio.mobile.studio, layout: "flow", origin: "takeover" } } };
    expect(studioSettingsFromMediaSettings(takeover)?.origin).toBe("takeover");
    expect(isAuthorManuscript(takeover)).toBe(true);
    // An origin this build does not know must not turn the book back into a generated one.
    const unknown = { mobile: { studio: { ...studio.mobile.studio, origin: "somewhere-else" } } };
    expect(isStudioManuscript(unknown)).toBe(true);
    expect(studioSettingsFromMediaSettings(unknown)?.origin).toBeUndefined();
  });
});
