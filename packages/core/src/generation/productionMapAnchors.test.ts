import { describe, expect, it } from "vitest";
import type { ChapterBrief } from "../schemas/book.js";
import {
  anchorsMatch,
  evidenceAnchorCollisionFindings,
  evidenceAnchorsCollide,
  foldEvidenceAnchor,
  missingEvidenceAnchorFindings,
  parseEvidenceAnchor
} from "./productionMapAnchors.js";
import { beat } from "./testing/pageBeatDedupFixtures.js";

function chapter(pages: ChapterBrief["pages"], chapterIndex = 1): ChapterBrief {
  return { chapterIndex, title: `Chapter ${chapterIndex}`, summary: "Roots of conflict.", continuityFocus: [], pages };
}

function anchored(pageIndex: number, purpose: string, evidenceAnchors?: string[]) {
  return {
    ...beat(pageIndex, 1, purpose, `${purpose} through one concrete case.`),
    ...(evidenceAnchors ? { evidenceAnchors } : {})
  };
}

describe("evidence anchor matching", () => {
  it("folds case, diacritics, Arabic letter variants and punctuation before comparing", () => {
    expect(foldEvidenceAnchor("The Treaty of Versailles (1919)!")).toBe("the treaty of versailles 1919");
    expect(foldEvidenceAnchor("Café Müller")).toBe(foldEvidenceAnchor("cafe muller"));
    expect(foldEvidenceAnchor("كتاب علي")).toBe(foldEvidenceAnchor("کتاب علی"));
  });

  it("matches a whole phrase, or a re-spelling that keeps most of its tokens", () => {
    const match = (left: string, right: string) => anchorsMatch(parseEvidenceAnchor(left), parseEvidenceAnchor(right));

    expect(match("Treaty of Versailles", "the Versailles treaty")).toBe(true);
    expect(match("Rwanda 1994 radio broadcasts", "1994 Rwanda radio broadcasts")).toBe(true);
    expect(match("Treaty of Versailles", "Treaty of Trianon")).toBe(false);
  });

  it("never lets a one-token anchor match every sibling that names the same word", () => {
    expect(anchorsMatch(parseEvidenceAnchor("Indus"), parseEvidenceAnchor("Indus seals from Harappa"))).toBe(false);
    expect(anchorsMatch(parseEvidenceAnchor("Indus"), parseEvidenceAnchor("indus"))).toBe(true);
  });

  it("collides on two shared anchors, or on one when either page argues from two or fewer", () => {
    expect(evidenceAnchorsCollide(["Versailles", "Dawes Plan", "Ruhr"], ["Dawes Plan", "Locarno", "Ruhr"])).toMatchObject({
      collides: true,
      shared: ["Dawes Plan", "Ruhr"]
    });
    expect(evidenceAnchorsCollide(["Versailles", "Dawes Plan", "Ruhr"], ["Dawes Plan", "Locarno", "Rapallo"]).collides).toBe(
      false
    );
    expect(evidenceAnchorsCollide(["Dawes Plan", "Ruhr"], ["Dawes Plan", "Locarno", "Rapallo"]).collides).toBe(true);
  });
});

describe("evidenceAnchorCollisionFindings", () => {
  it("names the later page, briefed against the sibling it shares the most with", () => {
    const briefs = [
      chapter([
        anchored(1, "Open on scarcity", ["Rwanda 1994", "Kigali radio"]),
        anchored(2, "Show land pressure", ["Bugesera land plots", "coffee price collapse", "Habyarimana"]),
        anchored(3, "Explain the radio's role", ["Kigali radio", "Rwanda 1994", "RTLM broadcasts"]),
        anchored(4, "Trace a refugee family", ["Goma camps", "Kivu border"])
      ])
    ];

    const findings = evidenceAnchorCollisionFindings(briefs);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "SHARED_EVIDENCE_ANCHORS",
      chapterIndexes: [1],
      pageIndexes: [3],
      beatFinding: { pageIndex: 3, duplicateOfPageIndex: 1 }
    });
    expect(findings[0]?.evidence).toMatch(/Page 3 shares evidence anchors \(Kigali radio, Rwanda 1994\) with page 1/);
    expect(findings[0]?.beatFinding?.earlierText).toMatch(/^Open on scarcity/);
  });

  it("compares pages within one chapter only and ignores pages assigned no anchors", () => {
    const briefs = [
      chapter([anchored(1, "Open on scarcity", ["Rwanda 1994", "Kigali radio"]), anchored(2, "No ledger")]),
      chapter([anchored(3, "Reprise the radio", ["Kigali radio", "Rwanda 1994"])], 2)
    ];

    expect(evidenceAnchorCollisionFindings(briefs)).toEqual([]);
  });
});

describe("missingEvidenceAnchorFindings", () => {
  const briefs = [
    chapter([anchored(1, "Open on scarcity", ["Rwanda 1994", "Kigali radio"]), anchored(2, "No ledger"), anchored(3, "None either")])
  ];

  it("reports the ledger-mode pages assigned no anchors, once per chapter", () => {
    expect(missingEvidenceAnchorFindings(briefs, "analytical-history")).toEqual([
      {
        code: "MISSING_EVIDENCE_ANCHORS",
        chapterIndexes: [1],
        pageIndexes: [2, 3],
        evidence: "Chapter 1 assigned no evidence anchors to pages 2, 3."
      }
    ]);
  });

  it("asks nothing of a narrative book", () => {
    expect(missingEvidenceAnchorFindings(briefs, "narrative")).toEqual([]);
    expect(missingEvidenceAnchorFindings(briefs, undefined)).toEqual([]);
  });
});
