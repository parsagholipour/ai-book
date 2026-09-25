import { pageQualityReportSchema, type ManuscriptQualityIssue } from "@book-maker/core";

/** Surface unresolved evidence in the final quality card without buying a prose repair. */
export function pageQualityAdvisoryIssues(pages: readonly { index: number; qualityReport?: unknown }[]): ManuscriptQualityIssue[] {
  const groups = new Map<string, ManuscriptQualityIssue>();
  for (const page of pages) {
    const parsed = pageQualityReportSchema.safeParse(page.qualityReport);
    if (!parsed.success) continue;
    for (const advisory of parsed.data.qualityAdvisories ?? []) {
      if (!advisory.message.trim()) continue;
      const key = `${advisory.check}\n${advisory.message.trim()}`;
      const existing = groups.get(key);
      if (existing) {
        if (!existing.affectedPageIndexes.includes(page.index)) existing.affectedPageIndexes.push(page.index);
      } else groups.set(key, {
        code: advisory.check === "style" ? "STYLE_REVIEW_UNVERIFIED" : "STORY_CONTINUITY_UNVERIFIED",
        severity: "warning", source: "model", message: `Unverified ${advisory.check === "style" ? "style" : "continuity"} finding: ${advisory.message.trim()}`,
        guidance: "This finding lacked supporting prose evidence. Inspect the named pages; no automatic rewrite was requested for it.",
        affectedPageIndexes: [page.index]
      });
    }
  }
  return [...groups.values()].map((issue) => ({ ...issue, affectedPageIndexes: issue.affectedPageIndexes.sort((a, b) => a - b) }));
}
