import { describe, expect, it } from "vitest";

import {
  imageAltFromSubject,
  markdownWithAppendedImage,
  markdownWithRemovedImage,
  markdownWithReplacedImage
} from "./imageMarkdown.js";

/**
 * The pure string half of the two image handlers, tested where it lives.
 *
 * These moved out of `handlers/applyImageInsertion.test.ts` — which re-exports
 * them and was at its size budget — rather than being written twice: the
 * callers own the reads, the writes and the snapshots, so everything here is a
 * function of its arguments and needs none of that suite's mock harness.
 */

describe("markdownWithReplacedImage", () => {
  const newLine = "![new](/assets/images/p/chat-image-op-new-bbbb.jpg)";

  it("swaps only the line carrying the marker and keeps everything around it", () => {
    const markdown = "Intro.\n\n![old](/assets/images/p/chat-image-op-old-aaaa.jpg)\n\nOutro.";
    expect(markdownWithReplacedImage(markdown, "chat-image-op-old", newLine)).toBe(
      `Intro.\n\n${newLine}\n\nOutro.`
    );
  });

  it("returns null when no line carries the marker — the caller's cue to append", () => {
    expect(markdownWithReplacedImage("Just prose.", "chat-image-op-old", newLine)).toBeNull();
  });
});

describe("markdownWithRemovedImage", () => {
  it("deletes the line carrying the marker and collapses the gap", () => {
    const markdown = "Intro.\n\n![old](/assets/images/p/chat-image-op-old-aaaa.jpg)\n\nOutro.";
    expect(markdownWithRemovedImage(markdown, "chat-image-op-old")).toBe("Intro.\n\nOutro.");
  });

  it("returns null when no line carries the marker", () => {
    expect(markdownWithRemovedImage("Just prose.", "chat-image-op-old")).toBeNull();
  });
});

describe("markdownWithAppendedImage", () => {
  it("separates prose and image with a blank line", () => {
    expect(markdownWithAppendedImage("Prose.", "![x](/a/b/c.jpg)")).toBe("Prose.\n\n![x](/a/b/c.jpg)");
  });

  it("unwraps a whole-page fence before appending", () => {
    expect(markdownWithAppendedImage("```md\nProse.\n```", "![x](/a.jpg)")).toBe("Prose.\n\n![x](/a.jpg)");
    expect(markdownWithAppendedImage("```\nProse.\n```", "![x](/a.jpg)")).toBe("Prose.\n\n![x](/a.jpg)");
  });

  it("leaves an interior fence alone", () => {
    const markdown = "Before.\n\n```js\ncode();\n```\n\nAfter.";
    expect(markdownWithAppendedImage(markdown, "![x](/a.jpg)")).toBe(`${markdown}\n\n![x](/a.jpg)`);
  });

  it("never unwraps a page that merely starts and ends with fences", () => {
    // The whole-page pattern spans the first opener to the LAST closer, so
    // unwrapping here would strip the outer markers and swap the prose between
    // the fences into code context — saved to Page.markdown permanently.
    const markdown = "```md\nformatted start\n```\n\nProse between the fences.\n\n```\ncode();\n```";
    expect(markdownWithAppendedImage(markdown, "![x](/a.jpg)")).toBe(`${markdown}\n\n![x](/a.jpg)`);
  });

  it("never unwraps a whole-page fence whose body holds an inner fence", () => {
    const markdown = "```md\nProse.\n\n```js\ncode();\n```\n\nMore prose.\n```";
    expect(markdownWithAppendedImage(markdown, "![x](/a.jpg)")).toBe(`${markdown}\n\n![x](/a.jpg)`);
  });

  it("yields just the image line for an empty page", () => {
    expect(markdownWithAppendedImage("", "![x](/a.jpg)")).toBe("![x](/a.jpg)");
  });
});

describe("imageAltFromSubject", () => {
  it("strips the characters that break the exporters' image regex", () => {
    expect(imageAltFromSubject("a [green] dragon (flying)\nover hills", "Illustration")).toBe(
      "a green dragon flying over hills"
    );
  });

  it("caps the alt at 120 characters", () => {
    const long = "d".repeat(200);
    expect(imageAltFromSubject(long, "Illustration")).toHaveLength(120);
  });

  it("falls back to the generic label when stripping empties the subject", () => {
    expect(imageAltFromSubject("()[]", "Illustration")).toBe("Illustration");
  });

  it("never emits the generation-artifact alt shape", () => {
    expect(imageAltFromSubject("Illustration for page 5", "Illustration")).toBe("Illustration");
  });
});
