import { describe, expect, it } from "vitest";
import { firstMarkupElement, markupElements, replaceMarkupElements, replaceTags, throughLastTag, type MarkupElementKind } from "./markupScan.js";
import { LINEAR_TIME_CEILING_MS } from "./testing/linearTime.js";

/** Best of two reads, so one slow read under load is not a failure. */
function readMs(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let read = 0; read < 2; read += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

// Small inputs where every way a lazy element or a tag can end, or fail to, shows.
const CORPUS = [
  "",
  "plain text",
  "<p>a</p><script>x</script><p>b</p>",
  "<SCRIPT type='a'>x</script>tail",
  "<script>never closed",
  "<!-- a --><!-->b-->",
  "<!-- unclosed <script>x</script>",
  "<script>a<!--</script>-->",
  "<style>a</STYLE><style>b",
  "<scripts>x</scripts>",
  "<p a='>'>x</p>",
  "<<p>>",
  "<p <p <p>",
  "<a/><a>x</a><a>y",
  "<a x/><a><a/></a>",
  "tail <p no end",
  "<script <script <script>",
  "<a\n/>"
];

const HIDDEN: readonly MarkupElementKind[] = [
  { open: /<!--/g, close: "-->" },
  { open: /<script\b[^>]*>/gi, close: "</script>" },
  { open: /<style\b[^>]*>/gi, close: "</style>" }
];

describe("markup elements", () => {
  it("replaces what the lazy alternation replaced", () => {
    const pattern = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
    for (const html of CORPUS) {
      expect(replaceMarkupElements(html, HIDDEN, () => " "), html).toBe(html.replace(pattern, " "));
    }
  });

  it("lets the first kind win where two open at the same place, and a declined tag yield to the next", () => {
    const pattern = /<a\b[^>]*\/>|<a\b[^>]*>[\s\S]*?<\/a>/g;
    const kinds: MarkupElementKind[] = [
      { open: /<a\b[^>]*>/g, accepts: (tag) => tag[0].endsWith("/>") },
      { open: /<a\b[^>]*>/g, close: "</a>" }
    ];
    for (const text of CORPUS) {
      expect(Array.from(markupElements(text, kinds), (element) => text.slice(element.start, element.end)), text).toEqual(
        text.match(pattern) ?? []
      );
    }
  });

  it("reads the first element as a non-global match does, body included", () => {
    const kinds: MarkupElementKind[] = [{ open: /<p\b[^>]*>/gi, close: "</p>" }];
    for (const text of CORPUS) {
      const element = firstMarkupElement(text, kinds);
      const match = text.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
      expect(element && [text.slice(element.start, element.end), text.slice(element.bodyStart, element.bodyEnd)], text).toEqual(
        match ? [match[0], match[1]] : undefined
      );
    }
  });

  it("replaces tags as the global pattern did, and keeps the tail after the last >", () => {
    for (const text of CORPUS) {
      expect(replaceTags(text, /<[^>]+>/g, " "), text).toBe(text.replace(/<[^>]+>/g, " "));
      expect(replaceTags(text, /<p\b[^>]*>/g, (tag) => tag.toUpperCase()), text).toBe(text.replace(/<p\b[^>]*>/g, (tag) => tag.toUpperCase()));
    }
    expect(throughLastTag("a>b<c")).toBe("a>");
    expect(throughLastTag("no tags")).toBe("");
  });

  it("stays linear on openings that never close and tags that never end", () => {
    const adversarial: Array<[string, (length: number) => string, () => readonly MarkupElementKind[]]> = [
      ["unclosed <script>", (length) => "<script>".repeat(length / 8), () => HIDDEN],
      ["unclosed <!--", (length) => "<!--".repeat(length / 4), () => HIDDEN],
      ["a tag that never ends", (length) => "<script ".repeat(length / 8), () => HIDDEN],
      ["openings sharing one tag", (length) => `${"<script ".repeat(length / 8)}>`, () => HIDDEN]
    ];
    for (const [label, build, kinds] of adversarial) {
      for (const length of [25_600, 256_000]) {
        const text = build(length);
        const ms = readMs(() => replaceMarkupElements(text, kinds(), () => " "));
        expect(ms, `${label} at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
      }
    }
    for (const length of [12_800, 128_000]) {
      const text = `<div "`.repeat(length / 6);
      const ms = readMs(() => replaceTags(text, /<[^>]+>/g, " "));
      expect(ms, `unclosed tags at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
    }
  });
});
