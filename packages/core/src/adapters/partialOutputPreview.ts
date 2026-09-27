const EDGE_CHARACTERS = 2_048;

/** Diagnostic text only: fixed memory, never a second copy of a runaway reply. */
export class PartialOutputPreview {
  private characters = 0;
  private head = "";
  private tail = "";

  append(text: string): void {
    this.characters += text.length;
    this.head += text.slice(0, Math.max(0, EDGE_CHARACTERS - this.head.length));
    this.tail = (this.tail + text.slice(-EDGE_CHARACTERS)).slice(-EDGE_CHARACTERS);
  }

  snapshot() {
    const tail = this.characters > EDGE_CHARACTERS
      ? this.tail.slice(-Math.min(EDGE_CHARACTERS, this.characters - EDGE_CHARACTERS)) : "";
    return { characters: this.characters, head: this.head, tail,
      truncated: this.characters > this.head.length + tail.length };
  }
}
