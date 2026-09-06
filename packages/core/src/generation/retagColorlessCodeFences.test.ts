import { describe, expect, it } from "vitest";
import { retagColorlessCodeFences } from "./retagColorlessCodeFences.js";

describe("retagColorlessCodeFences", () => {
  it("retags a text fence that is python-like, and leaves a letter alone", () => {
    const listing = ["```text", "while left < right:", "    middle = left + (right - left) // 2", "```"].join("\n");
    expect(retagColorlessCodeFences(listing)).toContain("```python");
    expect(retagColorlessCodeFences(listing)).toContain("while left < right:");
    const letter = ["```text", "Dear committee,", "Thank you for your letter of 12 June.", "```"].join("\n");
    expect(retagColorlessCodeFences(letter)).toContain("```text");
    expect(retagColorlessCodeFences(letter)).not.toContain("```python");
  });

  it("keeps a language tag and a figure fence", () => {
    expect(retagColorlessCodeFences("```js\nconst a = 1;\n```")).toContain("```js");
    expect(retagColorlessCodeFences('```figure\n{"kind":"bar"}\n```')).toContain("```figure");
  });

  it("retags an untagged listing that is code", () => {
    expect(retagColorlessCodeFences("```\nconst answer = 42;\n```")).toContain("```javascript");
  });

  it("leaves a text fence that looks like code but matches no language", () => {
    const listing = ["```text", "if count == limit", "    return result", "```"].join("\n");
    expect(retagColorlessCodeFences(listing)).toContain("```text");
    expect(retagColorlessCodeFences(listing)).not.toContain("```python");
  });

  it("leaves a text letter that starts with If and return uncoloured", () => {
    const letter = ["```text", "If you can attend on Tuesday,", "return the signed copy by Friday.", "```"].join("\n");
    const retagged = retagColorlessCodeFences(letter);
    expect(retagged).toContain("```text");
    expect(retagged).not.toMatch(/```(?:python|javascript|typescript|java|cpp|go|rust|sql|bash)\b/);
  });

  it("keeps an explicit pseudocode or pseudo tag even when the body is python-like", () => {
    const pythonLike = ["while left < right:", "    middle = left + (right - left) // 2"].join("\n");
    const pseudocode = ["```pseudocode", pythonLike, "```"].join("\n");
    expect(retagColorlessCodeFences(pseudocode)).toContain("```pseudocode");
    expect(retagColorlessCodeFences(pseudocode)).not.toContain("```python");
    const pseudo = ["```pseudo", pythonLike, "```"].join("\n");
    expect(retagColorlessCodeFences(pseudo)).toContain("```pseudo");
    expect(retagColorlessCodeFences(pseudo)).not.toContain("```python");
  });

  it("keeps output, console, and plaintext tags even when the body is python-like", () => {
    const pythonLike = ["while left < right:", "    middle = left + (right - left) // 2"].join("\n");
    const output = ["```output", pythonLike, "```"].join("\n");
    expect(retagColorlessCodeFences(output)).toContain("```output");
    expect(retagColorlessCodeFences(output)).not.toContain("```python");
    const consoleFence = ["```console", pythonLike, "```"].join("\n");
    expect(retagColorlessCodeFences(consoleFence)).toContain("```console");
    expect(retagColorlessCodeFences(consoleFence)).not.toContain("```python");
    const plaintext = ["```plaintext", pythonLike, "```"].join("\n");
    expect(retagColorlessCodeFences(plaintext)).toContain("```plaintext");
    expect(retagColorlessCodeFences(plaintext)).not.toContain("```python");
  });
});
