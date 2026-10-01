/**
 * Newlines in one unbroken run of whitespace at which a streamed reply is
 * over. A Quick Draft length-retry compose at effort none (2026-09-30) wrote
 * its chapter and then streamed " \n" until its 10,608-token fuse — 63 s, the
 * 28,942-character reply's tail all blank lines — and the incomplete reply
 * failed the book. No prose, Markdown or JSON reply holds forty blank lines in
 * a row, and the fuse itself was sane: three times the longest chapter allowed.
 */
export const WHITESPACE_RUNAWAY_NEWLINES = 40;

/** Reads a streamed reply; once it has run into nothing but whitespace, the rest is empty. */
export class WhitespaceRunawayGuard {
  private newlines = 0;

  /** True when this chunk completes the runaway; nothing from this chunk on is the reply. */
  append(chunk: string): boolean {
    for (const char of chunk) {
      if (char === "\n") {
        this.newlines += 1;
        if (this.newlines >= WHITESPACE_RUNAWAY_NEWLINES) return true;
      } else if (!/\s/u.test(char)) {
        this.newlines = 0;
      }
    }
    return false;
  }
}
