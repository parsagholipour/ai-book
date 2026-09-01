import { describe, expect, it, vi } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { reviewPageDraftLocally } from "./pagesLocalQa.js";
import {
  sameChapterTreatmentMatch,
  treatmentGuidanceForDraft,
  treatmentRepetitionIssue,
  type SameChapterTreatmentMatch
} from "./pagesTreatmentQa.js";
import {
  fourParaphrasedIndusWeightPages,
  indusSubjectDistinctEvidencePages
} from "./testing/manuscriptStructuralAuditFixtures.js";

/**
 * The page-time half of the treatment rule the manuscript audit pins in
 * `manuscriptStructuralAudit.test.ts`: the same fixtures, scored the same way,
 * so a draft this gate passes is one the compile audit will pass.
 */

const tokenizations = vi.hoisted(() => ({ count: 0 }));

vi.mock("./manuscriptPageCache.js", async () => {
  const actual = await vi.importActual<typeof import("./manuscriptPageCache.js")>("./manuscriptPageCache.js");
  return {
    ...actual,
    tokenizePage: (plain: string) => {
      tokenizations.count += 1;
      return actual.tokenizePage(plain);
    }
  };
});

const TREATMENT_ISSUE = /re-treats .*\(from page (\d+)\)/;
const PAGE_REFERENCE = /\bpages?\s+\d+/gi;
const EDGE_COMPLAINT = /\b(conclusion|ending|resolution|opening|final page|first page)\b/i;

function historyInput(): CreateProjectInput {
  return {
    prompt: "A history of Indus trade and administration.",
    category: "HISTORY",
    targetPages: 12,
    complexity: 6,
    temperature: 0.7,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral"
    }
  };
}

type FixturePage = { index: number; title: string; markdown: string };

function priorPages(pages: FixturePage[]) {
  return pages.map((page) => ({ index: page.index, title: page.title, markdown: page.markdown, summary: "" }));
}

function review(
  previousPages: ReturnType<typeof priorPages>,
  draft: FixturePage,
  range: { chapterPageStart?: number; chapterPageEnd?: number } = {}
) {
  const input = historyInput();
  return reviewPageDraftLocally({
    input,
    plan: makeFallbackPlan(input),
    pageIndex: draft.index,
    draft: { title: draft.title, markdown: draft.markdown, summary: "", continuityNotes: [] },
    previousPages,
    continuityNotes: [],
    ...(range.chapterPageStart !== undefined ? { chapterPageStart: range.chapterPageStart } : {}),
    ...(range.chapterPageEnd !== undefined ? { chapterPageEnd: range.chapterPageEnd } : {})
  });
}

describe("same-chapter treatment gate", () => {
  it("fails a draft that re-treats an earlier page's subject, evidence and claim in new words", () => {
    const [first, second, third, fourth] = fourParaphrasedIndusWeightPages();
    const report = review(priorPages([first!, second!, third!]), fourth!);

    expect(report.checks.repetitionOk).toBe(false);
    const issue = report.issues.find((entry) => TREATMENT_ISSUE.test(entry));
    expect(issue).toBeDefined();
    expect(issue).toMatch(/harappa|mohenjo/);
    // The final-QA repair harvests every `page N` in a message as a page to
    // redraft, except one that follows "from": the page that established the
    // treatment must not be redrafted beside the page that repeated it.
    const references = [...issue!.matchAll(PAGE_REFERENCE)];
    expect(references).toHaveLength(1);
    expect(issue!.slice(references[0]!.index - 5, references[0]!.index)).toBe("from ");
    expect(issue).not.toMatch(EDGE_COMPLAINT);
  });

  it("leaves a shared subject argued from distinct evidence alone", () => {
    const [first, second, third, fourth] = indusSubjectDistinctEvidencePages();
    const report = review(priorPages([first!, second!, third!]), fourth!);

    expect(report.issues.join(" ")).not.toMatch(TREATMENT_ISSUE);
    expect(report.checks.repetitionOk).toBe(true);
  });

  it("reads the chapter range it was handed rather than the recency window", () => {
    const [first, second] = fourParaphrasedIndusWeightPages();
    const earlierChapter = priorPages([{ ...first!, index: 3 }]);
    const draft = { ...second!, index: 4 };

    expect(review(earlierChapter, draft).issues.join(" ")).toMatch(TREATMENT_ISSUE);
    expect(review(earlierChapter, draft, { chapterPageStart: 4, chapterPageEnd: 8 }).issues.join(" ")).not.toMatch(
      TREATMENT_ISSUE
    );
  });

  it("falls back to the audit's own chapter distance when no range is known", () => {
    const [first, second] = fourParaphrasedIndusWeightPages();
    const farBack = priorPages([{ ...first!, index: 1 }]);

    expect(review(farBack, { ...second!, index: 6 }).issues.join(" ")).not.toMatch(TREATMENT_ISSUE);
    expect(review(farBack, { ...second!, index: 5 }).issues.join(" ")).toMatch(TREATMENT_ISSUE);
  });

  it("never flags a draft too short to carry a treatment", () => {
    const [first, second] = fourParaphrasedIndusWeightPages();
    const short = { ...second!, markdown: second!.markdown.split(". ")[0]! };

    expect(review(priorPages([first!]), short).issues.join(" ")).not.toMatch(TREATMENT_ISSUE);
  });

  it("tokenizes a finished page once, however many drafts are scored against it", () => {
    const [first, second, third, fourth] = fourParaphrasedIndusWeightPages();
    const previousPages = priorPages([first!, second!, third!]);
    const source = {
      pageIndex: fourth!.index,
      draft: { title: fourth!.title, markdown: fourth!.markdown },
      previousPages
    };

    tokenizations.count = 0;
    expect(sameChapterTreatmentMatch(source)?.page.index).toBeDefined();
    const firstPass = tokenizations.count;
    expect(sameChapterTreatmentMatch(source)?.page.index).toBeDefined();

    // Three predecessors plus the draft on the first pass; the draft alone on
    // the second, because the predecessors are memoized by identity.
    expect(firstPass).toBe(4);
    expect(tokenizations.count - firstPass).toBe(1);
  });

  it("drops edge words from the listed terms and names only what repeated", () => {
    const found: SameChapterTreatmentMatch = {
      page: { index: 7, title: "Weights", markdown: "" },
      match: {
        score: 1,
        evidenceRepeat: true,
        causalRepeat: false,
        conclusionRepeat: true,
        sharedEntities: ["harappa", "page"],
        sharedEvidence: ["chert", "conclusion", "granary"],
        sharedCausal: ["therefore"],
        sharedConclusion: ["conclusion"]
      }
    };

    expect(treatmentRepetitionIssue(found)).toBe(
      "Page re-treats harappa with the same evidence (chert, granary) and the same closing claim as an earlier " +
        "page of this chapter (from page 7); advance, challenge, or apply that treatment with different evidence."
    );
  });
});

describe("treatmentGuidanceForDraft", () => {
  it("hands every later page of a chapter a line about the page it re-treats", () => {
    const pages = fourParaphrasedIndusWeightPages();
    const guidance = treatmentGuidanceForDraft(pages, [{ startPage: 1, endPage: 4 }]);

    expect([...guidance.keys()]).toEqual([2, 3, 4]);
    expect(guidance.get(2)).toEqual([expect.stringMatching(/^An earlier page of this chapter \(page 1\) already re-treats/)]);
    for (const lines of guidance.values()) {
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/different evidence/);
    }
  });

  it("scores within a chapter range, never across one", () => {
    const pages = fourParaphrasedIndusWeightPages();
    const guidance = treatmentGuidanceForDraft(pages, [
      { startPage: 1, endPage: 2 },
      { startPage: 3, endPage: 4 }
    ]);

    expect([...guidance.keys()]).toEqual([2, 4]);
    expect(guidance.get(4)?.[0]).toMatch(/\(page 3\)/);
  });

  it("says nothing about pages that argue from distinct evidence", () => {
    expect(treatmentGuidanceForDraft(indusSubjectDistinctEvidencePages(), [{ startPage: 1, endPage: 4 }]).size).toBe(0);
  });
});
