import type { PictureBookRepairIssue } from "./pictureBookRepair.js";

/** Transport-only deduplication. Keep the first diagnostic verbatim and retain
 * the original ledger/target scopes for validation and publication decisions.
 * Only explicit page labels and singleton scopes establish equivalence;
 * similar wording, related pages and unscoped multi-page advice do not.
 */
export function compactPictureBookRepairIssues(issues: readonly PictureBookRepairIssue[]): PictureBookRepairIssue[] {
  const seen = new Set<string>();
  return issues.flatMap(issue => {
    const scope = [...new Set(issue.pageIndexes)].sort((a, b) => a - b);
    const messages = issue.messages.filter(message => {
      const label = /^Page (\d+): (.+)$/su.exec(message);
      const labeledPage = label ? Number(label[1]) : undefined;
      const labeled = labeledPage !== undefined && scope.includes(labeledPage);
      const pages = labeled ? [labeledPage] : scope;
      // A label outside the declared scope is ambiguous; retain it as written.
      const body = labeled ? label![2]! : !label && scope.length === 1 ? message : undefined;
      const key = JSON.stringify([pages, body === undefined ? message : body.replace(/^Fix: /u, "")]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return messages.length ? [{ pageIndexes: [...issue.pageIndexes], messages }] : [];
  });
}
