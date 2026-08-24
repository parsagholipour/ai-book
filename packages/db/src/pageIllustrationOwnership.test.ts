import { describe, expect, it, vi } from "vitest";

/** The dedicated subpath must remain real when either package barrel is replaced. */
vi.mock("@book-maker/core", () => ({}));
vi.mock("@book-maker/db", () => ({}));

import {
  LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY,
  legacyGeneratedIllustrationPageId,
  mayRetireLegacyGeneratedIllustration
} from "@book-maker/db/pageIllustrationOwnership";

describe("page illustration ownership subpath", () => {
  it("loads independently of the mocked DB and core barrels", () => {
    expect(
      legacyGeneratedIllustrationPageId({
        [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "page-stable-id"
      })
    ).toBe("page-stable-id");
    expect(legacyGeneratedIllustrationPageId(null)).toBeNull();
    expect(legacyGeneratedIllustrationPageId([])).toBeNull();
    expect(mayRetireLegacyGeneratedIllustration({}, "page-stable-id")).toBe(true);
    expect(
      mayRetireLegacyGeneratedIllustration(
        { [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: "another-page" },
        "page-stable-id"
      )
    ).toBe(false);
  });
});
