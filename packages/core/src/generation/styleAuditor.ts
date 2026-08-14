import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

export const pageStyleAuditSchema = z.object({
  styleOk: z.boolean().default(true),
  styleIssues: z.array(z.string()).default([])
});

export type PageStyleAudit = z.infer<typeof pageStyleAuditSchema>;

export function withStyleAudit<T extends {
  approved: boolean;
  issues: string[];
  requiredRevisions: string[];
  checks: { styleNatural: boolean };
}>(report: T, audit: PageStyleAudit): T {
  if (audit.styleOk && audit.styleIssues.length === 0) {
    return report;
  }
  return {
    ...report,
    approved: false,
    issues: uniqueStrings([...report.issues, ...audit.styleIssues]),
    requiredRevisions: uniqueStrings([
      ...report.requiredRevisions,
      ...audit.styleIssues.map((issue) => `Revise style: ${issue}`)
    ]),
    checks: { ...report.checks, styleNatural: false }
  };
}

export async function auditPageStyle(options: {
  textModel: TextModelAdapter;
  markdown: string;
  voiceGuide: string[];
  styleExcerpts: string[];
}): Promise<PageStyleAudit> {
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "audit-page-style",
    temperature: 0,
    maxTokens: 800,
    schema: pageStyleAuditSchema,
    messages: [
      {
        role: "system",
        content: [
          "You compare one page to pinned style excerpts and the book's voiceGuide.",
          "Return styleOk and styleIssues.",
          "Reject generic scaffold prose, sudden register shifts, and pages that ignore the excerpts' rhythm."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            markdown: options.markdown,
            voiceGuide: options.voiceGuide,
            styleExcerpts: options.styleExcerpts
          },
          null,
          2
        )
      }
    ]
  });
  const parsed = pageStyleAuditSchema.parse(result.data);
  return {
    styleOk: parsed.styleOk && parsed.styleIssues.length === 0,
    styleIssues: parsed.styleIssues
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
