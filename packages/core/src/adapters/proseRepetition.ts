const MAX_PARAGRAPH_CHARACTERS = 4096;
const MAX_CYCLE_PARAGRAPHS = 4;
const REPEATS = 4;
const MIN_CYCLE_CHARACTERS = 160;

export class ProseOutputRepetitionError extends Error {
  constructor() {
    super("Chapter output repeated the same prose passage four times consecutively.");
    this.name = "ProseOutputRepetitionError";
  }
}

/** Exact consecutive paragraph cycles, not a style or sentence-opening score.
 * Four copies of a substantial passage caught the Bolsonaro chapter's dialogue
 * loop. Short refrains, changing examples, code and worksheet rows are allowed.
 * Storage stays bounded even if a provider never ends a paragraph. */
export class ProseRepetitionGuard {
  private line = "";
  private lineOversized = false;
  private paragraph = "";
  private paragraphOversized = false;
  private paragraphLiteral = false;
  private paragraphs: string[] = [];
  private fence: string | undefined;

  append(chunk: string): void {
    for (const char of chunk) {
      if (char === "\n") this.endLine();
      else if (this.line.length < MAX_PARAGRAPH_CHARACTERS) this.line += char;
      else this.lineOversized = true;
    }
  }

  finish(): void {
    if (this.line || this.lineOversized) this.endLine();
    this.endParagraph();
  }

  private endLine(): void {
    // Track fences even when a literal paragraph exceeds the retained size.
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(this.line)?.[1];
    this.paragraphLiteral ||= this.fence !== undefined || marker !== undefined;
    if (marker) {
      if (!this.fence) this.fence = marker;
      else if (marker[0] === this.fence[0] && marker.length >= this.fence.length) this.fence = undefined;
    }
    if (!this.lineOversized && !this.line.trim()) this.endParagraph();
    else if (!this.paragraphOversized) {
      this.paragraphOversized = this.lineOversized || this.paragraph.length + this.line.length + 1 > MAX_PARAGRAPH_CHARACTERS;
      this.paragraph = this.paragraphOversized ? "" : this.paragraph + "\n" + this.line;
    }
    this.line = "";
    this.lineOversized = false;
  }

  private endParagraph(): void {
    if (this.paragraphOversized || this.paragraphLiteral) this.paragraphs = [];
    else this.accept(this.paragraph);
    this.paragraph = "";
    this.paragraphOversized = false;
    this.paragraphLiteral = this.fence !== undefined;
  }

  private accept(paragraph: string): void {
    if (/(^|\n)[ \t]*(?:\||>|#{1,6}\s|[-*+]\s|\d+[.)]\s)/u.test(paragraph)) {
      this.paragraphs = [];
      return;
    }
    const normalized = paragraph.replace(/\s+/gu, " ").trim();
    if (!normalized) return;
    this.paragraphs.push(normalized);
    this.paragraphs = this.paragraphs.slice(-MAX_CYCLE_PARAGRAPHS * REPEATS);
    for (let period = 1; period <= MAX_CYCLE_PARAGRAPHS; period++) {
      const start = this.paragraphs.length - period * REPEATS;
      if (start < 0) continue;
      const cycle = this.paragraphs.slice(-period);
      if (cycle.join(" ").length < MIN_CYCLE_CHARACTERS) continue;
      if (this.paragraphs.slice(start).every((value, index) => value === cycle[index % period])) {
        throw new ProseOutputRepetitionError();
      }
    }
  }
}
