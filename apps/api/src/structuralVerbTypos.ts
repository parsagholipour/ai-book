/**
 * The request with a misspelled leading verb read as the verb it misspells.
 *
 * "delte page 3" is a bare delete the grammar could not read, so the router's
 * restatement of it ("Delete the pages that carry printed page 3: the page
 * titled …") was kept as a content requirement and the free deletion was quoted
 * as a 540-credit rebuild (2026-10-02). The router has already decided the
 * action; this only lets the bare-request check read the reader's own words.
 * One edit apart (two for a verb of six letters or more), transpositions
 * included, and only for the opening word.
 */
export function withCorrectedActionVerb(request: string, action: "delete" | "move"): string {
  const verbs = action === "delete" ? ["delete", "remove", "erase"] : ["move", "relocate", "reorder"];
  const match = /^(\s*(?:please\s+)?)([a-z]+)\b/i.exec(request);
  const word = match?.[2]?.toLowerCase();
  if (!match || !word || verbs.includes(word)) {
    return request;
  }
  const corrected = verbs.find((verb) => editDistance(word, verb) <= (verb.length >= 6 ? 2 : 1));
  return corrected ? `${match[1]}${corrected}${request.slice(match[0].length)}` : request;
}

/** Optimal-string-alignment distance: insertions, deletions, substitutions and adjacent swaps. */
function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, i) =>
    Array.from({ length: right.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      }
      rows[i]![j] = best;
    }
  }
  return rows[left.length]![right.length]!;
}
