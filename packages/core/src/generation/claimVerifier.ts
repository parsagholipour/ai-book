import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { uniqueStrings } from "../collections.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

export const pageClaimVerificationSchema = z.object({
  groundedOk: z.boolean().default(true),
  unsupportedClaims: z.array(z.string()).default([])
});

export type PageClaimVerification = z.infer<typeof pageClaimVerificationSchema>;

export function withClaimVerification<T extends {
  approved: boolean;
  issues: string[];
  requiredRevisions: string[];
}>(
  report: T,
  verification: PageClaimVerification
): T & { groundedOk: boolean; groundingStatus: "verified" | "failed"; unsupportedClaims: string[] } {
  if (verification.groundedOk && verification.unsupportedClaims.length === 0) {
    return { ...report, groundedOk: true, groundingStatus: "verified", unsupportedClaims: [] };
  }
  const unsupportedClaims = verification.unsupportedClaims;
  const claimIssues = unsupportedClaims.map((claim) => `Unsupported claim: ${claim}`);
  return {
    ...report,
    approved: false,
    groundedOk: false,
    groundingStatus: "failed",
    unsupportedClaims,
    issues: uniqueStrings([...report.issues, ...claimIssues]),
    requiredRevisions: uniqueStrings([
      ...report.requiredRevisions,
      ...unsupportedClaims.map((claim) => `Ground or remove: ${claim}`)
    ])
  };
}

export async function verifyPageClaims(options: {
  textModel: TextModelAdapter;
  pageIndex: number;
  markdown: string;
  researchNotes: string[];
}): Promise<PageClaimVerification> {
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "verify-page-claims",
    temperature: 0,
    maxTokens: 800,
    schema: pageClaimVerificationSchema,
    messages: [
      {
        role: "system",
        content: [
          "You check whether factual claims on one page are supported by the supplied research notes.",
          "Return groundedOk and unsupportedClaims.",
          "Treat qualified uncertainty as acceptable. Invented studies, journals, statistics, or citations are unsupported."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            pageIndex: options.pageIndex,
            markdown: options.markdown,
            researchNotes: options.researchNotes
          },
          null,
          2
        )
      }
    ]
  });
  const parsed = pageClaimVerificationSchema.parse(result.data);
  const groundedOk = parsed.groundedOk && parsed.unsupportedClaims.length === 0;
  return { groundedOk, unsupportedClaims: parsed.unsupportedClaims };
}
