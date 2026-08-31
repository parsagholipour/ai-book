import { describe, expect, it } from "vitest";
import {
  buildManuscriptQualityReport,
  runDeterministicManuscriptChecks,
  type ManuscriptIntegrityPage
} from "./manuscriptQuality.js";

describe("whole-book structural slop warnings", () => {
  it("flags a repeated analytical grid", () => {
    const pages = manuscript(20, (index) =>
      [2, 7, 12, 17].includes(index)
        ? "Compare actors, setting, goals, resources, institutions, norms, technology, and evidence before drawing a conclusion."
        : "This page develops a separate historical claim with named evidence."
    );

    expect(codes(pages)).toContain("REPEATED_ANALYTICAL_GRID");
  });

  it("leaves a one-off analytical inventory alone", () => {
    const pages = manuscript(20, (index) =>
      index === 2
        ? "Compare actors, setting, goals, resources, institutions, norms, technology, and evidence before drawing a conclusion."
        : "This page develops a separate historical claim with named evidence."
    );

    expect(codes(pages)).not.toContain("REPEATED_ANALYTICAL_GRID");
  });

  it("flags checklist saturation across the manuscript", () => {
    const pages = manuscript(20, (index) =>
      [2, 4, 7, 9, 12, 14, 17, 19].includes(index)
        ? [
            "Use the comparison framework for this case.",
            "Ask whether institutions constrained the actors.",
            "The decisive question is whether resources changed the outcome.",
            "Apply the diagnostic checklist before continuing."
          ].join(" ")
        : "A named episode is reconstructed from a dated archival record."
    );

    expect(codes(pages)).toContain("FRAMEWORK_SATURATION");
  });

  it("protects occasional framework language", () => {
    const pages = manuscript(20, (index) =>
      index === 4
        ? "This chapter introduces a framework and explains why the comparison is limited."
        : "A named episode is reconstructed from a dated archival record."
    );

    expect(codes(pages)).not.toContain("FRAMEWORK_SATURATION");
  });

  it("flags symmetrical hedging used as a recurring cadence", () => {
    const pages = manuscript(20, (index) =>
      [3, 8, 13, 18].includes(index)
        ? `The outcome was neither purely institutional nor simply cultural; case ${index} combined both pressures.`
        : "The argument commits to a bounded claim supported by the episode."
    );

    expect(codes(pages)).toContain("SYMMETRICAL_HEDGING");
  });

  it("protects an isolated contrast that carries a real distinction", () => {
    const pages = manuscript(20, (index) =>
      index === 8
        ? "The treaty was neither a surrender nor an alliance; its third clause created a temporary armistice."
        : "The argument commits to a bounded claim supported by the episode."
    );

    expect(codes(pages)).not.toContain("SYMMETRICAL_HEDGING");
  });

  it("flags repeated generic historical placeholders without anchors", () => {
    const pages = manuscript(20, (index) =>
      [3, 9, 15].includes(index)
        ? [
            "Consider a ruler who might seek greater control.",
            "In one society, institutions could restrain that ruler.",
            "Some communities may instead reward aggression.",
            "One polity might mobilize its resources differently."
          ].join(" ")
        : "The Athenian assembly debated the Sicilian expedition in 415 BCE."
    );

    expect(codes(pages)).toContain("GENERIC_HISTORICAL_PLACEHOLDERS");
  });

  it("protects historical examples anchored by names or dates", () => {
    const pages = manuscript(20, (index) =>
      [3, 9, 15].includes(index)
        ? [
            "Consider the Athenian assembly in 415 BCE, when Alcibiades argued for the Sicilian expedition.",
            "In the Mali Empire, Mansa Musa used court institutions to govern provincial rulers.",
            "Some communities around Tenochtitlan resisted Mexica tribute demands in 1519."
          ].join(" ")
        : "The page examines a dated archival record."
    );

    expect(codes(pages)).not.toContain("GENERIC_HISTORICAL_PLACEHOLDERS");
  });

  it("flags repeated references to the supplied research", () => {
    const pages = manuscript(20, (index) =>
      [2, 8, 14].includes(index)
        ? `The supplied research suggests that the institution changed during episode ${index}.`
        : "The cited archive records a concrete institutional change."
    );

    expect(codes(pages)).toContain("RESEARCH_META_FRAMING");
  });

  it("protects a methodology page that describes supplied materials once", () => {
    const pages = manuscript(20, (index) =>
      index === 1
        ? "This methodology note distinguishes supplied research from newly retrieved archival sources."
        : "The cited archive records a concrete institutional change."
    );

    expect(codes(pages)).not.toContain("RESEARCH_META_FRAMING");
  });

  it("flags a conceptually repeated module across chapters", () => {
    const repeatedModule = [
      "Scarce material resources narrowed the ruler's available choices.",
      "Institutional constraints then redirected elite incentives toward public violence.",
      "Cultural norms legitimized coercion while military technology increased its reach.",
      "The surviving records therefore show how capacity, rules, and incentives combined."
    ].join(" ");
    const paraphrasedModule = [
      "Material scarcity limited the leader's possible choices.",
      "Organizational rules redirected aristocratic incentives toward open violence.",
      "Social customs legitimized coercion while military tools expanded its reach.",
      "The documentary evidence thus shows how resources, institutions, and motives interacted."
    ].join(" ");
    const pages = manuscript(16, (index) => {
      if (index === 3) return repeatedModule;
      if (index === 11) return paraphrasedModule;
      return `Named event ${index} establishes a distinct causal claim about diplomacy and taxation.`;
    });

    expect(codes(pages)).toContain("CROSS_CHAPTER_CONCEPT_REPETITION");
  });

  it("protects chapters that share a topic but make different claims", () => {
    const pages = manuscript(16, (index) => {
      if (index === 3) {
        return "Material shortages delayed the Roman grain fleet, raising prices in Ostia while merchants sought replacement cargoes.";
      }
      if (index === 11) {
        return "Roman legal institutions assigned inheritance shares through written wills, guardianship rules, and appeals to the praetor.";
      }
      return `Named event ${index} establishes a distinct causal claim about diplomacy and taxation.`;
    });

    expect(codes(pages)).not.toContain("CROSS_CHAPTER_CONCEPT_REPETITION");
  });

  it("requires review when three independent structural signals corroborate each other", () => {
    const pages = manuscript(20, (index) => {
      if (![3, 7, 11, 15].includes(index)) {
        return "The archive names the event, date, participants, and disputed interpretation.";
      }
      return [
        "The supplied research describes this generic example.",
        "Consider a ruler who might seek control.",
        "In one society, institutions could restrain that ruler.",
        "Some communities may instead reward aggression.",
        "The result was neither purely institutional nor simply cultural."
      ].join(" ");
    });
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: pages.length });

    expect(issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "SYMMETRICAL_HEDGING",
        "GENERIC_HISTORICAL_PLACEHOLDERS",
        "RESEARCH_META_FRAMING",
        "STRUCTURAL_SLOP_SATURATION"
      ])
    );
    expect(buildManuscriptQualityReport(issues, [], { finalReviewRan: false }).state).toBe("blocked");
  });

  it("keeps one recurring structural signal advisory", () => {
    const pages = manuscript(20, (index) =>
      [3, 7, 11, 15].includes(index)
        ? "The supplied research describes a named archival disagreement."
        : "The archive names the event, date, participants, and disputed interpretation."
    );
    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: pages.length });

    expect(issues.map(({ code }) => code)).toContain("RESEARCH_META_FRAMING");
    expect(issues.map(({ code }) => code)).not.toContain("STRUCTURAL_SLOP_SATURATION");
  });
});

function manuscript(pageCount: number, body: (index: number) => string): ManuscriptIntegrityPage[] {
  return Array.from({ length: pageCount }, (_, offset) => {
    const index = offset + 1;
    return {
      index,
      chapterIndex: Math.ceil(index / 4),
      title: `Page ${index}`,
      markdown: `${body(index)} ${words(90, `p${index}w`)}`
    };
  });
}

function codes(pages: ManuscriptIntegrityPage[]): string[] {
  return runDeterministicManuscriptChecks({ pages, expectedPageCount: pages.length }).map((issue) => issue.code);
}

function words(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
}
