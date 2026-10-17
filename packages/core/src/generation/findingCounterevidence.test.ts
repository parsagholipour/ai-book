import { expect, it } from "vitest";
import type { ManuscriptQualityIssue } from "./manuscriptQualityIssue.js";
import { hasAttributedSpeech, withoutRefutedFindings } from "./findingCounterevidence.js";

// The acceptance book of the 2026-10-15 labels (acceptance-caac09ef…): pages 4 and 13 speak,
// page 18 does not.
const pages = [
  { index: 4, markdown: "The stump stood bare. So did the fallen log and the bridge post. “Every light is gone,” Rabbit said. He leaned forward, ready to dash into the dripping woods." },
  { index: 13, markdown: "Rabbit looked toward the stump. “Amber was on the east side of it,” he said. Then he pointed to the fallen log. “Blue was east of that, too.”" },
  { index: 18, markdown: "Rabbit crossed the bridge first and waited on the east bank. Wise Turtle lifted Amber from the bridge post and followed, holding it close." },
  { index: 20, markdown: "A sign on the gate read “KEEP OUT”. The lane beyond it was dark." }
];
const finding = (code: string, pageIndex: number, message: string): ManuscriptQualityIssue => ({
  code, severity: "warning", source: "model", message, guidance: "Add natural dialogue.", affectedPageIndexes: [pageIndex]
});

it("drops a claim of absent dialogue about a page that prints attributed speech, the false labelled pair", () => {
  const refuted = [
    finding("WHOLE_BOOK_REVIEW", 4, "Page 4: This page has no dialogue, despite the explicit natural-dialogue requirement for each page. Evidence on page 4: ““Every light is gone,” Rabbit said.” Requested requirement: “natural dialogue”"),
    finding("MANUSCRIPT_FINDING_UNVERIFIED", 13, "Unverified editorial concern on page 13: Page 13 has no dialogue, despite the requirement for natural dialogue on each page.")
  ];
  expect(withoutRefutedFindings(refuted, pages)).toEqual([]);
});

it("keeps the claim where the page really is silent, and where its only quotation is not speech", () => {
  const kept = [
    finding("WHOLE_BOOK_REVIEW", 18, "Page 18: This page has no dialogue, despite the explicit natural-dialogue requirement for each page."),
    finding("PAGE_QA_UNRESOLVED", 20, "Page QA did not approve the saved draft: This page has no spoken dialogue.")
  ];
  expect(withoutRefutedFindings(kept, pages)).toEqual(kept);
});

it("never drops a different complaint, a complaint among several, or a deterministic finding", () => {
  const kept = [
    finding("WHOLE_BOOK_REVIEW", 4, "Page 4: The dialogue is stiff and over-explains the plan."),
    finding("PAGE_QA_UNRESOLVED", 4, "Page QA did not approve the saved draft: The pacing sags.\nThis page has no dialogue."),
    finding("WHOLE_BOOK_REVIEW", 4, "Page 4: No dialogue tags make it clear who speaks."),
    { ...finding("REPEATED_PHRASE", 4, "This page has no dialogue."), source: "deterministic" as const }
  ];
  expect(withoutRefutedFindings(kept, pages)).toEqual(kept);
});

it("reads speech attributed before or after the quotation", () => {
  expect(hasAttributedSpeech("Turtle asked, “Where did they go?”")).toBe(true);
  expect(hasAttributedSpeech("\"Look there,\" whispered Rabbit.")).toBe(true);
  expect(hasAttributedSpeech("The book was called “Lanterns of the East”.")).toBe(false);
});
