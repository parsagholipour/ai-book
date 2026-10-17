import { createHash } from "node:crypto";
import type { PriorPageContext } from "./pagesShared.js";

export function pictureBookChecklistSpans(page: Pick<PriorPageContext, "index" | "markdown">) {
  const version = createHash("sha256").update(`${page.index}\n${page.markdown}`).digest("hex").slice(0, 12);
  const spans: Record<string, string> = {};
  let index = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(page.markdown)) {
    // Long sentences are losslessly split to the stored evidence bound. No prose
    // is truncated, paraphrased, duplicated or borrowed from a neighboring page.
    let remaining = segment;
    while (remaining.length) {
      let end = Math.min(300, remaining.length);
      if (end < remaining.length && /[\uD800-\uDBFF]/u.test(remaining[end - 1]!)) end -= 1;
      spans[`${version}:${index++}`] = remaining.slice(0, end);
      remaining = remaining.slice(end);
    }
  }
  return spans;
}
