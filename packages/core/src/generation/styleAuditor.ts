import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { uniqueStrings } from "../collections.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

export const pageStyleAuditSchema = z.object({
  styleOk: z.boolean().default(true),
  styleIssues: z.array(z.string()).default([])
});

export type PageStyleAudit = z.infer<typeof pageStyleAuditSchema>;

/**
 * The score cost per style finding, carried beside `score` rather than
 * subtracted from it. Only the initial draft and reviewer-approved revisions
 * are ever audited, so a penalty folded into `score` made candidates
 * incomparable: `bestDraftCandidate` kept a rejected, never-audited rewrite
 * over an audited draft whose reviewer score was higher.
 */
const STYLE_ISSUE_SCORE_PENALTY = 15;

/** The score fields `styleAuditedScoreBeats` compares candidates on. */
export type StyleAuditedScore = {
  score: number;
  /** Present only on a report the style auditor has seen; 0 means it passed. */
  stylePenalty?: number | undefined;
};

/**
 * Whether `candidate` should replace `incumbent` as the kept draft.
 *
 * Scores are only comparable when the same critics produced them, and the
 * style audit sees the initial draft and reviewer-approved revisions only — a
 * rejected rewrite is never audited. So the penalty counts only when both
 * reports carry one; against an unaudited report the reviewer's own score is
 * the one shared scale, and the audit must never cost an audited draft its
 * seat to a candidate the auditor was not allowed to see.
 */
export function styleAuditedScoreBeats(candidate: StyleAuditedScore, incumbent: StyleAuditedScore): boolean {
  const bothAudited = candidate.stylePenalty !== undefined && incumbent.stylePenalty !== undefined;
  const effective = (report: StyleAuditedScore): number =>
    bothAudited ? report.score - (report.stylePenalty ?? 0) : report.score;
  return effective(candidate) > effective(incumbent);
}

export function withStyleAudit<T extends {
  approved: boolean;
  issues: string[];
  requiredRevisions: string[];
  checks: { styleNatural: boolean };
}>(report: T, audit: PageStyleAudit): T & { stylePenalty: number } {
  const styleIssues = uniqueStrings(audit.styleIssues);
  if (audit.styleOk && styleIssues.length === 0) {
    // Penalty zero, not absent: it marks the report as audited, which is what
    // lets a clean draft's score be compared penalty-for-penalty against a
    // candidate the audit failed.
    return { ...report, stylePenalty: 0 };
  }
  return {
    ...report,
    approved: false,
    stylePenalty: Math.max(1, styleIssues.length) * STYLE_ISSUE_SCORE_PENALTY,
    issues: uniqueStrings([...report.issues, ...styleIssues]),
    requiredRevisions: uniqueStrings([
      ...report.requiredRevisions,
      ...styleIssues.map((issue) => `Revise style: ${issue}`)
    ]),
    checks: { ...report.checks, styleNatural: false }
  };
}

/**
 * The second opinion on a page's voice: does it read like the same book as the
 * pinned excerpts?
 *
 * `userRequest` is what makes that question answerable on an edited page. The
 * excerpts are the book's *opening* pages, and a reader's edit is very often a
 * request to sound different there and only there — "make page 12 more
 * dramatic" is a register shift by construction. Judged by the plain rules the
 * audit rejected it, flipped the reviewer's approval, and the chat edit's small
 * revision budget was spent pulling the page back toward the voice the reader
 * had just asked it to leave, delivering the edit FAILED_QA. So a requested
 * shift is declared INTENDED, and the audit keeps everything it is actually for
 * — scaffold prose, `antiAiRules` violations, and drift the request did not ask
 * for.
 */
export async function auditPageStyle(options: {
  textModel: TextModelAdapter;
  markdown: string;
  voiceGuide: string[];
  /** The plan's book-specific "what generic AI prose looks like here" rules. */
  antiAiRules?: string[] | undefined;
  styleExcerpts: string[];
  /** The reader's own edit request, when this page is one they asked to change. */
  userRequest?: string | undefined;
}): Promise<PageStyleAudit> {
  const userRequest = options.userRequest?.trim();
  const system = [
    "You compare one page to pinned style excerpts and the book's voiceGuide.",
    "Return styleOk and styleIssues.",
    userRequest
      ? "Reject generic scaffold prose, pages that ignore the excerpts' rhythm, and prose that violates the book's antiAiRules."
      : "Reject generic scaffold prose, sudden register shifts, pages that ignore the excerpts' rhythm, and prose that violates the book's antiAiRules."
  ];
  if (userRequest) {
    system.push(
      "The reader explicitly requested this change (see userRequest), so every tone, register, pacing or mood shift the request asks for is INTENDED: never report one as an issue.",
      "The excerpts are the book's opening voice, and this page is allowed to differ from them exactly as far as the request asks.",
      "Report only drift the request did not ask for."
    );
  }
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "audit-page-style",
    temperature: 0,
    maxTokens: 800,
    schema: pageStyleAuditSchema,
    messages: [
      {
        role: "system",
        content: system.join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            markdown: options.markdown,
            voiceGuide: options.voiceGuide,
            ...(options.antiAiRules && options.antiAiRules.length > 0 ? { antiAiRules: options.antiAiRules } : {}),
            styleExcerpts: options.styleExcerpts,
            ...(userRequest ? { userRequest } : {})
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
