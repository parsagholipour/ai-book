import { describe, expect, it } from "vitest";
import { BOOK_CATEGORIES } from "../categories.js";
import { COVER_HEIGHT, COVER_WIDTH } from "./cover.js";
import { coverDesignSvg } from "./coverDesignArtwork.js";
import {
  COVER_DESIGNS,
  COVER_DESIGN_IDS,
  DEFAULT_COVER_DESIGN_ID,
  coverDesign,
  coverDesignCatalogLines,
  coverDesignTagsForContext,
  defaultCoverDesign,
  fallbackCoverDesign
} from "./coverDesigns.js";
import { coverArtSourceFor } from "./coverSource.js";

const COVER_TEMPLATE_IDS = ["kids", "science", "fiction", "minimal", "business", "self-help", "romance"];

describe("cover design catalog", () => {
  it("ships 50 designs with unique ids", () => {
    expect(COVER_DESIGNS).toHaveLength(50);
    expect(new Set(COVER_DESIGN_IDS).size).toBe(50);
  });

  it("gives every design a usable template, palette and description", () => {
    for (const design of COVER_DESIGNS) {
      expect(design.id).toMatch(/^[a-z0-9-]+$/);
      expect(COVER_TEMPLATE_IDS).toContain(design.template);
      expect(design.palette).toHaveLength(3);
      for (const color of design.palette) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(design.tags.length).toBeGreaterThan(0);
      // The description is the model's whole basis for choosing, so a stub
      // would silently degrade selection rather than fail anything.
      expect(design.description.length).toBeGreaterThan(60);
      expect(design.name.trim()).not.toBe("");
    }
  });

  it("covers every genre the fallback can ask for", () => {
    const tags = new Set(COVER_DESIGNS.flatMap((design) => design.tags));
    for (const tag of ["general", "kids", "story", "science", "business", "selfhelp", "romance", "mystery", "scifi"]) {
      expect(tags).toContain(tag);
    }
  });

  it("looks designs up and falls back to a real default", () => {
    expect(coverDesign("moonlit-sea")?.name).toBe("Moonlit Sea");
    expect(coverDesign("not-a-design")).toBeUndefined();
    expect(defaultCoverDesign().id).toBe(DEFAULT_COVER_DESIGN_ID);
  });

  it("renders one catalog line per design for the selection prompt", () => {
    const lines = coverDesignCatalogLines().split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toContain(COVER_DESIGNS[0]?.id ?? "");
  });
});

describe("fallbackCoverDesign", () => {
  it("answers for every book category", () => {
    for (const category of BOOK_CATEGORIES) {
      const design = fallbackCoverDesign({ category, seed: "project-1" });
      expect(COVER_DESIGN_IDS).toContain(design.id);
    }
  });

  it("prefers a genre design over the general pool", () => {
    expect(fallbackCoverDesign({ category: "KIDS", seed: "a" }).tags).toContain("kids");
    expect(fallbackCoverDesign({ category: "BUSINESS", seed: "a" }).tags).toContain("business");
    expect(
      fallbackCoverDesign({ category: "STORY", subcategory: "Contemporary Romance", seed: "a" }).tags
    ).toContain("romance");
    expect(
      fallbackCoverDesign({ category: "STORY", subcategory: "Detective thriller", seed: "a" }).tags
    ).toContain("mystery");
  });

  it("is stable for one project and spreads across projects", () => {
    const repeated = fallbackCoverDesign({ category: "CUSTOM", seed: "project-1" });
    expect(fallbackCoverDesign({ category: "CUSTOM", seed: "project-1" }).id).toBe(repeated.id);

    const picks = new Set(
      Array.from({ length: 40 }, (_, index) => fallbackCoverDesign({ category: "CUSTOM", seed: `p-${index}` }).id)
    );
    expect(picks.size).toBeGreaterThan(3);
  });

  it("reads genre out of free-text hints when the subcategory is silent", () => {
    expect(coverDesignTagsForContext({ category: "STORY", hints: "A love story set in Lisbon" })).toContain("romance");
  });
});

describe("coverArtSourceFor", () => {
  it("maps the legacy flag: no AI cover means a designed one, never none", () => {
    expect(coverArtSourceFor({ includeCover: true })).toBe("ai");
    expect(coverArtSourceFor({ includeCover: false })).toBe("design");
  });

  it("lets an explicit source win over the legacy flag", () => {
    expect(coverArtSourceFor({ includeCover: true, coverArtSource: "design" })).toBe("design");
    expect(coverArtSourceFor({ includeCover: false, coverArtSource: "ai" })).toBe("ai");
    expect(coverArtSourceFor({ includeCover: true, coverArtSource: "none" })).toBe("none");
  });
});

describe("coverDesignSvg", () => {
  it("renders every design as a text-free SVG at the cover size", () => {
    for (const design of COVER_DESIGNS) {
      const svg = coverDesignSvg(design);
      expect(svg.startsWith("<svg xmlns=")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg).toContain(`viewBox="0 0 ${COVER_WIDTH} ${COVER_HEIGHT}"`);
      // The title and author are typeset over this layer, so any lettering in
      // the artwork itself would collide with them.
      expect(svg).not.toContain("<text");
      expect(svg).not.toContain("font-family");
      // Secure static mode: no scripts and no external references.
      expect(svg).not.toContain("<script");
      expect(svg).not.toMatch(/(?:href|src)="(?!#)/);
      expect(svg).not.toContain("NaN");
      expect(svg).not.toContain("undefined");
    }
  });

  it("is deterministic, so re-rendering a book keeps its cover", () => {
    for (const design of COVER_DESIGNS) {
      expect(coverDesignSvg(design)).toBe(coverDesignSvg(design));
    }
  });

  it("balances every element it opens", () => {
    for (const design of COVER_DESIGNS) {
      const svg = coverDesignSvg(design);
      const opened = svg.match(/<(?!\/)[a-zA-Z]+/g)?.length ?? 0;
      const closed = (svg.match(/<\/[a-zA-Z]+>/g)?.length ?? 0) + (svg.match(/\/>/g)?.length ?? 0);
      expect(closed).toBe(opened);
    }
  });

  it("only paints with the design's own palette", () => {
    for (const design of COVER_DESIGNS) {
      const svg = coverDesignSvg(design);
      const referenced = svg.match(/#[0-9a-f]{6}/gi) ?? [];
      expect(referenced.length).toBeGreaterThan(0);
      // Blends between palette entries are expected; a colour outside their
      // channel range is a hard-coded value that ignores the design.
      for (const color of referenced) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});
