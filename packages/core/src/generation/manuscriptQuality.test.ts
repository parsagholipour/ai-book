import { describe, expect, it } from "vitest";
import {
  appendQualityIssue,
  buildManuscriptQualityReport,
  runDeterministicManuscriptChecks,
  type ManuscriptQualityIssue
} from "./manuscriptQuality.js";

describe("persistent manuscript quality gate", () => {
  it("blocks publication for deterministic integrity failures", () => {
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Opening", markdown: "TODO: insert the finished chapter here." }
      ]
    });
    const report = buildManuscriptQualityReport(issues, [], { finalReviewRan: true });

    expect(report.state).toBe("blocked");
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["PAGE_COUNT_MISMATCH", "PLACEHOLDER_TEXT"])
    );
    expect(report.affectedPageIndexes).toContain(1);
  });

  it("surfaces an unpaid-promise warning as a review recommendation, never a block", () => {
    const report = buildManuscriptQualityReport([unpaidPromise()], [], { finalReviewRan: true });

    // A deterministic warning used to leave the state "passed", which hid the
    // issue from every reader of the state field; it now recommends review
    // exactly like a model warning does, and still never blocks.
    expect(report.state).toBe("review_recommended");
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.code).toBe("UNPAID_PROMISE");
  });

  it("records a deterministic warning without recommending review when no final review ran", () => {
    // The retroactive downgrade: an undo, an exact replacement and a chat
    // edit's apply all recompile with `skipFinalReview`, all own the quality
    // verdict, and all re-run these whole-book checks over prose the edit never
    // touched — so a book that passed came back "review recommended" for a
    // repeated phrase its own first compile had already accepted, forever.
    const report = buildManuscriptQualityReport([unpaidPromise()], [], { finalReviewRan: false });

    expect(report.state).toBe("passed");
    // Still recorded: the compile saw it, and the job row is where an operator
    // reads what it saw. Only the state is the claim the app acts on.
    expect(report.issues.map((issue) => issue.code)).toEqual(["UNPAID_PROMISE"]);
    expect(report.affectedPageIndexes).toEqual([12]);
  });

  it("blocks an integrity error whether or not the final review ran", () => {
    for (const finalReviewRan of [true, false]) {
      const report = buildManuscriptQualityReport(
        runDeterministicManuscriptChecks({
          expectedPageCount: 1,
          pages: [{ index: 1, title: "Opening", markdown: "TODO: insert the finished chapter here." }]
        }),
        [],
        { finalReviewRan }
      );

      expect(report.state, `finalReviewRan=${finalReviewRan}`).toBe("blocked");
    }
  });

  it("keeps model-only concerns non-blocking", () => {
    const report = buildManuscriptQualityReport([], [
      {
        code: "CHAPTER_TRANSITION",
        severity: "warning",
        source: "model",
        message: "The transition is abrupt.",
        guidance: "Smooth the handoff between chapters.",
        affectedPageIndexes: [4, 5]
      }
    ], { finalReviewRan: true });

    expect(report.state).toBe("review_recommended");
    expect(report.affectedPageIndexes).toEqual([4, 5]);
  });

  it("passes a complete clean manuscript", () => {
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Opening", markdown: "# Opening\n\nA complete and useful opening section." },
        { index: 2, title: "Next step", markdown: "# Next step\n\nA distinct conclusion with a concrete next step." }
      ]
    });

    expect(buildManuscriptQualityReport(issues, [], { finalReviewRan: true })).toMatchObject({
      state: "passed",
      score: 100,
      issues: []
    });
  });

  it("flags two nearly identical pages", () => {
    const body = words(120);
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Opening", markdown: `${body} alpha.` },
        { index: 2, title: "Repeat", markdown: `${body} beta.` }
      ]
    });

    expect(issues.map((issue) => issue.code)).toContain("NEAR_DUPLICATE_PAGES");
    expect(issues.find((issue) => issue.code === "NEAR_DUPLICATE_PAGES")?.affectedPageIndexes).toEqual([1, 2]);
  });

  it("does not flag two distinct pages of the same length", () => {
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Opening", markdown: words(120, "left") },
        { index: 2, title: "Closing", markdown: words(120, "right") }
      ]
    });

    expect(issues.map((issue) => issue.code)).not.toContain("NEAR_DUPLICATE_PAGES");
  });

  it("ignores pages under the 80-word floor even when identical", () => {
    const body = words(40);
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Opening", markdown: body },
        { index: 2, title: "Repeat", markdown: body }
      ]
    });

    expect(issues.map((issue) => issue.code)).not.toContain("NEAR_DUPLICATE_PAGES");
  });

  it("does not flag a short page whose words are all reused by a much longer one", () => {
    // The Jaccard size bound rejects this in O(1). It has to agree with the
    // full computation: 100 shared words over a 300-word union is 0.33.
    const shared = words(100);
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        { index: 1, title: "Short", markdown: shared },
        { index: 2, title: "Long", markdown: `${shared} ${words(200, "extra")}` }
      ]
    });

    expect(issues.map((issue) => issue.code)).not.toContain("NEAR_DUPLICATE_PAGES");
  });

  it("appends a post-hoc warning without erasing the original checks", () => {
    const report = buildManuscriptQualityReport([], [], { finalReviewRan: true });

    const degraded = appendQualityIssue(report, {
      code: "EPUB_EXPORT_FAILED",
      severity: "warning",
      source: "deterministic",
      message: "EPUB export failed; PDF and markdown are available.",
      guidance: "Download the PDF, or re-run the export to retry the EPUB.",
      affectedPageIndexes: []
    });

    expect(degraded.state).toBe("review_recommended");
    expect(degraded.score).toBe(95);
    expect(degraded.issues.map((issue) => issue.code)).toContain("EPUB_EXPORT_FAILED");
    // The original report is not mutated.
    expect(report.state).toBe("passed");
    expect(report.issues).toHaveLength(0);
  });

  it("never improves the state when appending to a blocked report", () => {
    const blocked = buildManuscriptQualityReport(
      runDeterministicManuscriptChecks({ expectedPageCount: 1, pages: [] }),
      [],
      { finalReviewRan: true }
    );

    const appended = appendQualityIssue(blocked, {
      code: "EPUB_EXPORT_FAILED",
      severity: "warning",
      source: "deterministic",
      message: "EPUB export failed.",
      guidance: "Retry the export.",
      affectedPageIndexes: []
    });

    expect(appended.state).toBe("blocked");
  });
});

describe("book-level repetition warnings", () => {
  it("flags a distinctive phrase recurring across the book as a warning, not a block", () => {
    const phrase = "the clockwork lighthouse blinked twice";
    const pages = Array.from({ length: 40 }, (_, offset) => {
      const index = offset + 1;
      const filler = words(90, `p${index}w`);
      const carriesPhrase = [3, 9, 15, 21, 27, 33].includes(index);
      return {
        index,
        title: `Page ${index}`,
        markdown: carriesPhrase ? `${filler} ${phrase} ${words(20, `p${index}x`)}` : filler
      };
    });

    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 40 });
    const repeated = issues.filter((issue) => issue.code === "REPEATED_PHRASE");
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.severity).toBe("warning");
    expect(repeated[0]?.affectedPageIndexes).toEqual([3, 9, 15, 21, 27, 33]);
    expect(buildManuscriptQualityReport(issues, [], { finalReviewRan: true }).state).toBe("review_recommended");
  });

  it("leaves a phrase on too few pages alone", () => {
    const phrase = "the clockwork lighthouse blinked twice";
    const pages = Array.from({ length: 40 }, (_, offset) => {
      const index = offset + 1;
      const filler = words(90, `p${index}w`);
      return {
        index,
        title: `Page ${index}`,
        markdown: [3, 21].includes(index) ? `${filler} ${phrase}` : filler
      };
    });

    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 40 });
    expect(issues.filter((issue) => issue.code === "REPEATED_PHRASE")).toHaveLength(0);
  });

  it("flags pages that keep opening with the same move", () => {
    const pages = Array.from({ length: 10 }, (_, offset) => {
      const index = offset + 1;
      const opensSame = [2, 5, 8].includes(index);
      const opening = opensSame
        ? `As the sun set over ridge${index}, the valley cooled.`
        : `Morning${index} began with its own errand.`;
      return {
        index,
        title: `Page ${index}`,
        markdown: `${opening} ${words(90, `p${index}w`)}`
      };
    });

    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 10 });
    const openings = issues.filter((issue) => issue.code === "REPEATED_OPENING");
    expect(openings).toHaveLength(1);
    expect(openings[0]?.severity).toBe("warning");
    expect(openings[0]?.affectedPageIndexes).toEqual([2, 5, 8]);
    expect(buildManuscriptQualityReport(issues, [], { finalReviewRan: true }).state).toBe("review_recommended");
  });

  it("passes an ordinary story book whose repetitions stay incidental", () => {
    // One phrase on 4 of 30 pages and one opening on 3 of 30 — the incidental
    // rate the scaled thresholds exist to tolerate. Every page clears the
    // picture-book word floor, so the thresholds are what keep this clean.
    const pages = Array.from({ length: 30 }, (_, offset) => {
      const index = offset + 1;
      const opening = [4, 12, 25].includes(index)
        ? "The next morning the village stirred awake."
        : `Errand${index} waited${index} beyond${index} daybreak${index}.`;
      const phrase = [2, 9, 17, 28].includes(index) ? " They walked in the quiet mountain air." : "";
      return { index, title: `Page ${index}`, markdown: `${opening}${phrase} ${words(90, `p${index}w`)}` };
    });

    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 30 });
    expect(issues.map((issue) => issue.code)).not.toContain("REPEATED_PHRASE");
    expect(issues.map((issue) => issue.code)).not.toContain("REPEATED_OPENING");
    expect(buildManuscriptQualityReport(issues, [], { finalReviewRan: true })).toMatchObject({
      state: "passed",
      score: 100,
      issues: []
    });
  });

  it("leaves a refrain-built picture book alone, even with the refrain on every page", () => {
    // Short pages built on a deliberate refrain are craft, not slop: under
    // the picture-book word floor neither repetition check reads the page.
    const pages = Array.from({ length: 12 }, (_, offset) => {
      const index = offset + 1;
      return {
        index,
        title: `Page ${index}`,
        markdown: `The little red boat sailed on and on. ${words(15, `p${index}k`)}`
      };
    });

    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 12 });
    expect(issues.map((issue) => issue.code)).not.toContain("REPEATED_PHRASE");
    expect(issues.map((issue) => issue.code)).not.toContain("REPEATED_OPENING");
    expect(buildManuscriptQualityReport(issues, [], { finalReviewRan: true }).state).toBe("passed");
  });

  it("catches the Persian model apology as a prompt leak", () => {
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 1,
      pages: [
        {
          index: 1,
          title: "روباه و باغ",
          markdown: `به عنوان یک مدل زبانی، نمی‌توانم ادامه دهم. ${words(90)}`
        }
      ]
    });

    expect(issues.some((issue) => issue.code === "PROMPT_LEAKAGE")).toBe(true);
  });

  it("catches the Persian apology written with the ZWNJ Persian actually uses", () => {
    // «به‌عنوان» is one word joined by U+200C, and `\s` does not match it, so
    // the standard spelling of the very phrase this check was added for went
    // straight into the published book.
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 1,
      pages: [
        {
          index: 1,
          title: "روباه و باغ",
          markdown: `به‌عنوان یک مدل زبانی، نمی‌توانم ادامه دهم. ${words(90)}`
        }
      ]
    });

    expect(issues.some((issue) => issue.code === "PROMPT_LEAKAGE")).toBe(true);
  });

  it("catches the Arabic apology however the tanween is encoded", () => {
    const spellings = ["بصفتي نموذجًا لغويًا", "بصفتي نموذجاً لغوياً", "بصفتي نموذجا لغوي", "كنموذج لغوي"];
    for (const spelling of spellings) {
      const issues = runDeterministicManuscriptChecks({
        expectedPageCount: 1,
        pages: [{ index: 1, title: "الثعلب والحديقة", markdown: `${spelling}، لا أستطيع المتابعة. ${words(90)}` }]
      });

      expect(issues.some((issue) => issue.code === "PROMPT_LEAKAGE"), spelling).toBe(true);
    }
  });

  it("leaves ordinary Persian and Arabic prose alone", () => {
    // «به عنوان» ("as") and «نموذج» ("model") are ordinary words; only the
    // full self-reference is a leak.
    const issues = runDeterministicManuscriptChecks({
      expectedPageCount: 2,
      pages: [
        {
          index: 1,
          title: "نویسنده",
          markdown: `او به‌عنوان یک نویسنده شناخته می‌شد و به عنوان مثال هر روز می‌نوشت. ${words(90, "fa")}`
        },
        {
          index: 2,
          title: "الحديقة",
          markdown: `هذا نموذج جيد للعمل الجماعي، وقدم الباحث نموذجا لغويا جديدا. ${words(90, "ar")}`
        }
      ]
    });

    expect(issues.some((issue) => issue.code === "PROMPT_LEAKAGE")).toBe(false);
  });
});

describe("book-level repetition in scripts that write no word spaces", () => {
  // A Chinese page has no spaces to count words at, so its ~1100 characters
  // tokenize to ~30 runs: under the 80-word picture-book floor, which skipped
  // every one of these checks, and four "words" of it is four whole clauses.
  // Both checks were structurally inert for zh/ja — a book could carry the same
  // sentence on twenty pages and pass.
  const repeatedSentence = "灯塔在夜色里闪了两次";

  it("flags a Chinese sentence repeated across the book", () => {
    const carriers = [3, 9, 15, 21, 27, 33];
    const pages = Array.from({ length: 40 }, (_, offset) => {
      const index = offset + 1;
      return {
        index,
        title: `第${index}页`,
        markdown: carriers.includes(index)
          ? `${hanFiller(200, index)}。${repeatedSentence}。`
          : `${hanFiller(200, index)}。`
      };
    });

    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 40 });
    const repeated = issues.filter((issue) => issue.code === "REPEATED_PHRASE");
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.severity).toBe("warning");
    expect(repeated[0]?.affectedPageIndexes).toEqual(carriers);
    // Quoted as real characters, from the page's own text.
    expect(repeated[0]?.message).toContain(repeatedSentence.slice(0, 8));
  });

  it("leaves a Chinese book that repeats nothing alone", () => {
    const pages = Array.from({ length: 40 }, (_, offset) => {
      const index = offset + 1;
      return { index, title: `第${index}页`, markdown: `${hanFiller(200, index)}。` };
    });

    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 40 });
    expect(issues.map((issue) => issue.code)).not.toContain("REPEATED_PHRASE");
    expect(issues.map((issue) => issue.code)).not.toContain("REPEATED_OPENING");
    expect(issues.map((issue) => issue.code)).not.toContain("NEAR_DUPLICATE_PAGES");
  });

  it("flags Chinese pages that keep opening with the same sentence", () => {
    // The opening used to be unreachable twice over: the page never cleared the
    // word floor, and `firstSentence` knew no full-width terminator, so the
    // whole page was one sentence and its first four "words" were four clauses.
    const opening = "夜色降临山谷渐渐凉了下来";
    const pages = Array.from({ length: 10 }, (_, offset) => {
      const index = offset + 1;
      const opensSame = [2, 5, 8].includes(index);
      return {
        index,
        title: `第${index}页`,
        markdown: `${opensSame ? opening : hanFiller(20, index)}。${hanFiller(200, index)}。`
      };
    });

    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 10 });
    const openings = issues.filter((issue) => issue.code === "REPEATED_OPENING");
    expect(openings).toHaveLength(1);
    expect(openings[0]?.affectedPageIndexes).toEqual([2, 5, 8]);
    expect(openings[0]?.message).toContain(opening.slice(0, 8));
  });

  it("flags a repeated Thai phrase and quotes it with its marks intact", () => {
    // Thai tone marks and vowel signs are combining marks, so the old tokenizer
    // broke every syllable apart: the phrase it would have quoted at the reader
    // was mark-stripped debris, and no fragment of it reached the length bar.
    const phrase = "แสงจันทร์เหนือทะเลสาบเงียบ";
    const carriers = [3, 9, 15, 21, 27, 33];
    const pages = Array.from({ length: 40 }, (_, offset) => {
      const index = offset + 1;
      return {
        index,
        title: `หน้า ${index}`,
        markdown: carriers.includes(index) ? `${thaiFiller(400, index)} ${phrase}` : thaiFiller(400, index)
      };
    });

    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 40 });
    const repeated = issues.filter((issue) => issue.code === "REPEATED_PHRASE");
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.affectedPageIndexes).toEqual(carriers);
    expect(repeated[0]?.message).toContain(phrase.slice(0, 16));
  });

  it("quotes a repeated Arabic phrase the way the page vowels it", () => {
    // Same mark problem in a spaced script: «الْكِتَابُ» came apart into four
    // bare letters, so a four-word shingle measured eight characters and was
    // dropped under the 18-character bar — the check was dead in vocalized
    // Arabic, and anything it had reported would have quoted the debris.
    const phrase = "الْقَمَرُ الْفِضِّيُّ فَوْقَ الْبُحَيْرَةِ";
    const carriers = [3, 9, 15, 21, 27, 33];
    const pages = Array.from({ length: 40 }, (_, offset) => {
      const index = offset + 1;
      const filler = words(90, `ص${index}ك`);
      return {
        index,
        title: `صفحة ${index}`,
        markdown: carriers.includes(index) ? `${filler} ${phrase}` : filler
      };
    });

    const issues = runDeterministicManuscriptChecks({ pages, expectedPageCount: 40 });
    const repeated = issues.filter((issue) => issue.code === "REPEATED_PHRASE");
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.affectedPageIndexes).toEqual(carriers);
    expect(repeated[0]?.message).toContain(phrase);
  });
});

/** `count` distinct words, so a page's vocabulary size is exactly `count`. */
function words(count: number, prefix = "word"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
}

/**
 * `count` Chinese characters from a block of the CJK Unified Ideographs that
 * belongs to `page` alone, so nothing but a planted sentence can recur across
 * pages.
 */
function hanFiller(count: number, page: number): string {
  const base = 0x4e00 + (page - 1) * 300;
  return Array.from({ length: count }, (_, index) => String.fromCodePoint(base + (index % 300))).join("");
}

/**
 * `count` Thai characters whose repeating four-character unit spells the page
 * number in Thai digits, so no window of sixteen belongs to two pages.
 */
function thaiFiller(count: number, page: number): string {
  const digits = "๐๑๒๓๔๕๖๗๘๙";
  const unit = `กข${digits.charAt(Math.floor(page / 10) % 10)}${digits.charAt(page % 10)}`;
  return unit.repeat(Math.ceil(count / unit.length)).slice(0, count);
}

function unpaidPromise(): ManuscriptQualityIssue {
  return {
    code: "UNPAID_PROMISE",
    severity: "warning",
    source: "deterministic",
    message: "Unpaid promise on the final page: The lantern will be lit.",
    guidance: "Pay off or explicitly retire the promise on the last page.",
    affectedPageIndexes: [12]
  };
}
