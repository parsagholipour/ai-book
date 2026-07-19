export type ManuscriptQualityState = "passed" | "review_recommended" | "blocked";
export type ManuscriptQualitySeverity = "error" | "warning";
export type ManuscriptQualitySource = "deterministic" | "model";

export type ManuscriptQualityIssue = {
  code: string;
  severity: ManuscriptQualitySeverity;
  source: ManuscriptQualitySource;
  message: string;
  guidance: string;
  affectedPageIndexes: number[];
};

export type ManuscriptQualityReport = {
  state: ManuscriptQualityState;
  score: number;
  issues: ManuscriptQualityIssue[];
  affectedPageIndexes: number[];
  checkedAt: string;
};

export type ManuscriptIntegrityPage = {
  index: number;
  title: string;
  markdown: string;
};

export function runDeterministicManuscriptChecks(options: {
  pages: ManuscriptIntegrityPage[];
  expectedPageCount: number;
}): ManuscriptQualityIssue[] {
  const issues: ManuscriptQualityIssue[] = [];
  const pages = [...options.pages].sort((a, b) => a.index - b.index);
  if (pages.length === 0) {
    issues.push(issue("MISSING_PAGES", "No manuscript pages were generated.", "Regenerate the book before exporting.", []));
    return issues;
  }
  if (pages.length !== options.expectedPageCount) {
    issues.push(
      issue(
        "PAGE_COUNT_MISMATCH",
        `The manuscript has ${pages.length} pages but ${options.expectedPageCount} were expected.`,
        "Regenerate missing pages or correct the plan's page count.",
        pages.map((page) => page.index)
      )
    );
  }
  const indexes = pages.map((page) => page.index);
  const expectedIndexes = Array.from({ length: pages.length }, (_, index) => index + 1);
  if (new Set(indexes).size !== indexes.length || indexes.some((value, index) => value !== expectedIndexes[index])) {
    issues.push(
      issue(
        "PAGE_INDEX_INVALID",
        "Page indexes contain a duplicate, gap, or out-of-order value.",
        "Repair page ordering before publishing.",
        indexes
      )
    );
  }

  for (const page of pages) {
    const plain = plainMarkdown(page.markdown);
    if (!page.title.trim() || !plain) {
      issues.push(
        issue(
          "EMPTY_PAGE",
          `Page ${page.index} has an empty title or body.`,
          "Open Edit Mode or regenerate this page.",
          [page.index]
        )
      );
    }
    if (containsPromptLeak(page.markdown)) {
      issues.push(
        issue(
          "PROMPT_LEAKAGE",
          `Page ${page.index} appears to expose generation instructions or hidden prompt text.`,
          "Regenerate this page without internal instructions.",
          [page.index]
        )
      );
    }
    if (containsPlaceholder(page.markdown)) {
      issues.push(
        issue(
          "PLACEHOLDER_TEXT",
          `Page ${page.index} contains placeholder text.`,
          "Replace the placeholder in Edit Mode or regenerate the page.",
          [page.index]
        )
      );
    }
    if (hasMalformedMarkdown(page.markdown)) {
      issues.push(
        issue(
          "MALFORMED_MARKDOWN",
          `Page ${page.index} contains malformed Markdown.`,
          "Fix unmatched code fences, links, or footnotes in Edit Mode.",
          [page.index]
        )
      );
    }
    if (hasUnsupportedFootnote(page.markdown)) {
      issues.push(
        issue(
          "UNSUPPORTED_CITATION",
          `Page ${page.index} references a citation that has no matching definition.`,
          "Add the missing source definition or remove the citation reference.",
          [page.index]
        )
      );
    }
  }

  for (let left = 0; left < pages.length; left += 1) {
    for (let right = left + 1; right < pages.length; right += 1) {
      if (nearDuplicate(pages[left]!.markdown, pages[right]!.markdown)) {
        issues.push(
          issue(
            "NEAR_DUPLICATE_PAGES",
            `Pages ${pages[left]!.index} and ${pages[right]!.index} are nearly identical.`,
            "Regenerate one of these pages with its distinct page brief.",
            [pages[left]!.index, pages[right]!.index]
          )
        );
      }
    }
  }
  return issues;
}

export function buildManuscriptQualityReport(
  deterministicIssues: ManuscriptQualityIssue[],
  modelIssues: ManuscriptQualityIssue[] = []
): ManuscriptQualityReport {
  const issues = [...deterministicIssues, ...modelIssues];
  const blocked = deterministicIssues.some((entry) => entry.severity === "error");
  const state: ManuscriptQualityState = blocked ? "blocked" : modelIssues.length > 0 ? "review_recommended" : "passed";
  const score = Math.max(
    0,
    100 - deterministicIssues.filter((entry) => entry.severity === "error").length * 18 - modelIssues.length * 5
  );
  return {
    state,
    score,
    issues,
    affectedPageIndexes: [...new Set(issues.flatMap((entry) => entry.affectedPageIndexes))].sort((a, b) => a - b),
    checkedAt: new Date().toISOString()
  };
}

/**
 * Adds a post-hoc issue (e.g. an export artifact failure discovered after the
 * manuscript checks ran) to an existing report, recomputing state and score
 * with the same weights as buildManuscriptQualityReport. State never improves:
 * a warning bumps "passed" to "review_recommended"; a deterministic error
 * blocks.
 */
export function appendQualityIssue(
  report: ManuscriptQualityReport,
  issue: ManuscriptQualityIssue
): ManuscriptQualityReport {
  const blocked = report.state === "blocked" || (issue.severity === "error" && issue.source === "deterministic");
  return {
    ...report,
    state: blocked ? "blocked" : "review_recommended",
    score: Math.max(0, report.score - (issue.severity === "error" ? 18 : 5)),
    issues: [...report.issues, issue],
    affectedPageIndexes: [...new Set([...report.affectedPageIndexes, ...issue.affectedPageIndexes])].sort(
      (a, b) => a - b
    )
  };
}

function issue(
  code: string,
  message: string,
  guidance: string,
  affectedPageIndexes: number[]
): ManuscriptQualityIssue {
  return { code, severity: "error", source: "deterministic", message, guidance, affectedPageIndexes };
}

function plainMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!??\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#>*_`~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPromptLeak(value: string): boolean {
  return /(?:system\s+prompt|developer\s+message|ignore\s+(?:all\s+)?previous\s+instructions|chain[- ]of[- ]thought|as\s+an\s+ai\s+language\s+model|private\s+source\s+material\s+from\s+the\s+user)/i.test(
    value
  );
}

function containsPlaceholder(value: string): boolean {
  return /\b(?:TODO|TBD|FIXME|LOREM IPSUM|PLACEHOLDER)\b|\[(?:insert|add|write|placeholder|todo)[^\]]*\]/i.test(value);
}

function hasMalformedMarkdown(value: string): boolean {
  const fences = value.match(/```/g)?.length ?? 0;
  if (fences % 2 !== 0) return true;
  const links = value.match(/\[[^\]]*\]\([^)]*$/gm);
  return Boolean(links?.length);
}

function hasUnsupportedFootnote(value: string): boolean {
  const references = [...value.matchAll(/\[\^([^\]]+)\](?!:)/g)].map((match) => match[1]);
  if (references.length === 0) return false;
  const definitions = new Set([...value.matchAll(/^\[\^([^\]]+)\]:/gm)].map((match) => match[1]));
  return references.some((reference) => reference && !definitions.has(reference));
}

function nearDuplicate(left: string, right: string): boolean {
  const leftWords = normalizedWords(left);
  const rightWords = normalizedWords(right);
  if (leftWords.length < 80 || rightWords.length < 80) return false;
  const leftSet = new Set(leftWords);
  const rightSet = new Set(rightWords);
  let intersection = 0;
  for (const word of leftSet) {
    if (rightSet.has(word)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 && intersection / union >= 0.9;
}

function normalizedWords(value: string): string[] {
  return plainMarkdown(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
