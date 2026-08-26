import { describe, expect, it } from "vitest";
import {
  isSourceIdentityOnlyIssue,
  shouldSkipUnsatisfiableCitationRepair
} from "./citationRepairPolicy.js";

const report = (...issues: string[]) => ({ approved: false, issues });

describe("shouldSkipUnsatisfiableCitationRepair", () => {
  it.each([
    [
      "the affected legacy requirement wording",
      "Despite the page brief explicitly requiring a named testimony or archive, the page provides no specific dispatch date."
    ],
    ["a missing dispatch and archive", "No specific dispatch date or archive is identified."],
    ["a missing civilian account", "The documented civilian account is not named."]
  ])("recognizes %s as source-identity-only", (_name, issue) => {
    expect(shouldSkipUnsatisfiableCitationRepair(report(issue), [])).toBe(true);
  });

  it("requires every issue to be source-identity-only", () => {
    expect(
      shouldSkipUnsatisfiableCitationRepair(
        report(
          "No specific dispatch date or archive is identified.",
          "The page repeats the explanation from page 1."
        ),
        []
      )
    ).toBe(false);
  });

  it.each([
    "No specific dispatch date is identified, and the account contradicts the supplied record.",
    "No archive is named, but the chronology is incorrect.",
    "The page invents a diary and fabricates its contents."
  ])("keeps a mixed or substantive single issue repairable: %s", (issue) => {
    expect(shouldSkipUnsatisfiableCitationRepair(report(issue), [])).toBe(false);
  });

  it("keeps the same legacy issue repairable when citeable research exists", () => {
    expect(
      shouldSkipUnsatisfiableCitationRepair(
        report("No specific dispatch date or archive is identified."),
        ["Boundary papers: Commission records."]
      )
    ).toBe(false);
  });

  it("does not classify an empty or unreadable report", () => {
    expect(shouldSkipUnsatisfiableCitationRepair(report(), [])).toBe(false);
    expect(shouldSkipUnsatisfiableCitationRepair(null, [])).toBe(false);
  });
});

describe("isSourceIdentityOnlyIssue", () => {
  it.each([
    [
      "page 1 opening",
      "The page does not fulfill the required civilian-facing opening moment. It begins with the assassination itself and then supplies generalized descriptions of what people might have encountered, rather than presenting a specific documented person, record, notice, newspaper report, diary entry, or public announcement."
    ],
    [
      "page 69 opening",
      "The opening scene is presented as documented, but no specific testimony, contemporary record, archive, or named source is identified, failing the pageBrief's explicit sourcing requirement."
    ],
    [
      "page 87 opening",
      "The page does not fulfill the required beat to begin with a documented civilian or soldier account. It opens with generalized, unsourced description of families, railway stations, roads, and belongings."
    ],
    [
      "page 87 identity list",
      "No individual is named, no precise location is supplied for a testimony, and no source is identified. The later discussion of testimony limits cannot substitute for an actual documented account."
    ],
    [
      "page 163 opening",
      "The opening is not actually grounded in a specific documented human-scale account. It refers vaguely to “contemporary reports” and “military accounts” without naming a report, witness, publication, unit, or source type beyond broad categories."
    ],
    [
      "page 172 opening",
      "The page does not use a documented civilian, diplomatic, or official account despite the pageBrief explicitly requiring one; it offers generalized descriptions of what residents, officials, and families experienced without identifying a source or testimony."
    ],
    [
      "page 180 opening",
      "The required documented civilian experience is not actually provided. The page refers vaguely to “one contemporary record” and “such accounts” without identifying the testimony, diary, interview, photograph caption, or contemporary record."
    ],
    [
      "page 69 revision",
      "Name the specific contemporary record or testimony supporting the opening scene, and distinguish that source's perspective from later interpretations."
    ],
    [
      "page 10 testimony",
      "The page contains no specific documented testimony, community example, or clearly identified source despite the book's sourcing requirements and the page's emphasis on human and political effects."
    ],
    [
      "page 43 civilian source",
      "The opening is not sufficiently anchored in a documented civilian source. Westerplatte is a documented military location, but the page provides no named testimony, diary, photograph, or official record centered on civilians, despite the page brief’s explicit requirement."
    ],
    [
      "page 114 perspectives",
      "The page is broadly coherent and advances to captivity, displacement, reeducation, and postwar flight, but it does not fulfill the required sourced-perspective structure. It mentions categories of people rather than presenting clearly identified, documented accounts from an American or allied soldier, a North Vietnamese or National Liberation Front participant, a South Vietnamese soldier or official, and civilians."
    ],
    [
      "page 136 account",
      "The page claims to begin with a contemporary account but provides no identifiable source, narrator, place, date, publication, archive, or quotation. The opening is therefore generic and does not satisfy the required documented human experience."
    ],
    [
      "page 167 testimony",
      "The page is generally coherent and advances the assigned beat, but it does not include a sourced civilian testimony from each side, despite that being an explicit page requirement. It refers generically to 'surviving testimony' without naming a person, document, interview, archive, or publication."
    ],
    [
      "page 159 revision",
      "Replace the generalized family example with a clearly attributed, sourced testimony or administrative record showing specific changes to family life, work, or community organization."
    ],
    [
      "page 159 acceptable omission",
      "The page is strong on specificity and avoids fabrication, but it could benefit from a concrete documented testimony or record as requested in the pageBrief. However, since researchNotes is empty, the omission is acceptable."
    ],
    [
      "page 159 acceptable requested testimony",
      "The page is strong on specificity and avoids fabrication, but it leans on generalized descriptions of refugee life without a concrete documented testimony or record, which the pageBrief requested. However, since researchNotes is empty, this is acceptable."
    ],
    [
      "page 167 non-rejecting testimony request",
      "The page does not include a sourced civilian testimony from each side as the pageBrief requested, but researchNotes is empty and the brief is sanitized, so this is not a rejection reason."
    ],
    [
      "page 180 revision",
      "Do not paraphrase an unnamed record. Either cite the source in reader-facing prose or identify it in a way that allows the account to be distinguished from reconstruction."
    ]
  ])("classifies the frozen %s complaint", (_name, issue) => {
    expect(isSourceIdentityOnlyIssue(issue)).toBe(true);
  });

  it.each([
    [
      "invented scene",
      "The opening presents a specific-sounding county magistrate experience but supplies no county, magistrate, document, date beyond the season, or source context. As written, it reads like an invented illustrative scene, conflicting with the requirement that opening scenes be documented and that invented scenes not be presented as fact."
    ],
    [
      "factual error",
      "The page contains a likely factual error: the Force Publique mutiny began at Camp Léopold in Thysville (now Mbanza-Ngungu), not Camp Hardy. This should be verified and corrected."
    ],
    [
      "reserved-beat restage",
      "The page substantially restages the chapter's reserved closing material about accountability, recognition, repatriation, competing memories, and the limits of a settled record, even though pageScope.isLastPageOfChapter is false and those beats belong to page 153."
    ],
    [
      "overpack",
      "The page covers too much chronology for an opening page, moving from the December shooting through the January 1945 Varkiza Agreement. This weakens the requested inside-the-moment opening and compresses later developments that belong on subsequent pages."
    ],
    [
      "repetition",
      "The final question repeats the page's central framing rather than adding a concrete consequence or sharper transition. It is acceptable as an ending pressure in principle, but here it feels formulaic and underdeveloped."
    ],
    [
      "mixed invented illustration",
      "The required sourced testimony or record is absent. The prose offers generalized examples such as a son joining a fighting group and a relative returning to inspect land, but these are not identified as documented testimony and read as invented illustrative scenarios."
    ],
    [
      "broad unsupported claims",
      "The prose repeatedly makes general claims about recruitment, coercion, treatment, political expectations, and postwar responses without identifying the relevant dates, policies, units, or sources. Claims such as laborers being recruited or compelled, unequal pay, and battlefield recognition leading to political claims require tighter attribution and qualification."
    ],
    [
      "abstract conclusion",
      "The final paragraph becomes abstract and repetitive: “return, memory, and absence” and “one document, grave, and damaged home” gesture toward consequences without identifying a specific documented case, person, family, return problem, memorial, or legal process."
    ],
    [
      "composite risk without a source demand",
      "The page opens with a generic description of displacement ('a train, a lorry, a crowded road') that risks feeling like a composite scene, though it quickly pivots to a documented account and qualifies its limits."
    ],
    [
      "generic family explicitly not treated as a scene",
      "The page uses a generic unnamed civilian perspective ('a family that remained in its home') which could be seen as an illustrative reconstruction, but it is presented as a general description rather than a specific witnessed scene, and the page does not attribute specific actions to a single anonymous individual."
    ],
    [
      "modal group description explicitly not treated as a witness",
      "The page uses 'could' and 'might' in several places to describe civilian experiences, which risks sounding like an unnamed composite reconstruction. However, the page explicitly acknowledges the limits of testimony and does not present a specific invented individual as a witness."
    ]
  ])("keeps the frozen %s defect", (_name, issue) => {
    expect(isSourceIdentityOnlyIssue(issue)).toBe(false);
  });
});
