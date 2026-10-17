import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QualitySection } from "./QualitySection.js";

const finding = (code: string, severity: "error" | "warning", extra: Record<string, unknown> = {}) => ({
  code, severity, source: "deterministic" as const, message: `${code} message`, guidance: "Fix it.", affectedPageIndexes: [3], ...extra
});

describe("QualitySection", () => {
  it("draws the reader's findings and the console's diagnostics apart", () => {
    const markup = renderToStaticMarkup(
      <QualitySection quality={{ state: "review_recommended", score: 95, affectedPageIndexes: [3], readerPolicy: "reader-findings-v1",
        issues: [finding("PROMPT_LEAKAGE", "warning", { evidence: [{ pageIndex: 3, excerpt: "system prompt" }] })],
        diagnosticIssues: [finding("CHAPTER_LENGTH_SHORTFALL", "error")] }} />
    );
    expect(markup).toContain("Shown to the reader");
    expect(markup).toContain("Diagnostics (console only)");
    expect(markup.indexOf("PROMPT_LEAKAGE")).toBeLessThan(markup.indexOf("Diagnostics (console only)"));
    expect(markup.indexOf("CHAPTER_LENGTH_SHORTFALL")).toBeGreaterThan(markup.indexOf("Diagnostics (console only)"));
    expect(markup).toContain("“system prompt”");
  });

  it("says when a report predates the split, and draws nothing before a verdict", () => {
    const legacy = renderToStaticMarkup(
      <QualitySection quality={{ state: "blocked", score: 82, affectedPageIndexes: [3], issues: [finding("PLACEHOLDER_TEXT", "error")] }} />
    );
    expect(legacy).toContain("graded before the reader/diagnostics split");
    expect(legacy).not.toContain("Diagnostics (console only)");
    expect(renderToStaticMarkup(<QualitySection quality={undefined} />)).toBe("");
  });
});
