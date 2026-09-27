const MAX_KEY_CHARACTERS = 128;
const REPEATED_KEY_LIMIT = 8;

export class JsonOutputRepetitionError extends Error {
  constructor() {
    super("Invalid JSON: repeated property names without values.");
    this.name = "JsonOutputRepetitionError";
  }
}

/** Detect the observed runaway `"key", "key", ...` INSIDE an object.
 * This cannot be valid JSON: object keys require a colon and value. Repeated
 * strings in arrays/prose and identical keys in different objects are valid.
 * A bounded lexer, not a replacement JSON parser or a prose repetition judge. */
export class JsonOutputRepetitionGuard {
  private containers: string[] = [];
  private quoted = false;
  private escaped = false;
  private token: string | undefined;
  private previous: string | undefined;
  private comma = false;
  private repeats = 0;
  private disabled = false;

  append(chunk: string): void {
    if (this.disabled) return;
    for (const char of chunk) {
      if (this.quoted) {
        if (!this.escaped && char === '"') {
          this.quoted = false;
          if (this.containers.at(-1) === "{" && this.token !== undefined) {
            this.repeats = this.comma && this.previous === this.token ? this.repeats + 1 : 1;
            this.previous = this.token;
            this.comma = false;
            if (this.repeats >= REPEATED_KEY_LIMIT) throw new JsonOutputRepetitionError();
          } else this.resetRun();
        } else {
          if (this.token !== undefined) this.token = this.token.length < MAX_KEY_CHARACTERS ? this.token + char : undefined;
          this.escaped = !this.escaped && char === "\\";
        }
        continue;
      }
      if (/\s/u.test(char)) continue;
      if (char === '"') { this.quoted = true; this.escaped = false; this.token = ""; continue; }
      if (char === ",") { this.comma = true; continue; }
      this.resetRun();
      if (char === "{" || char === "[") {
        // Never turn excessive nesting into a false repetition verdict.
        if (this.containers.length === 128) { this.disabled = true; this.containers = []; return; }
        this.containers.push(char);
      } else if (char === "}" || char === "]") this.containers.pop();
    }
  }

  private resetRun(): void { this.previous = undefined; this.repeats = 0; this.comma = false; }
}
