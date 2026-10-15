import { describe, expect, it } from "vitest";
import { epubMatterBlocks } from "./epubMatterBlocks.js";
import { LINEAR_TIME_CEILING_MS } from "./testing/linearTime.js";

function readMs(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let read = 0; read < 2; read += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("EPUB matter blocks", () => {
  // What the lazy regexes answered for each of these, before the scan replaced them.
  it.each([
    [`<html><head><title>T</title></head><body><!-- note --><p>Text</p><script>var x = "</p>";</script></body></html>`, [{ html: " <p>Text</p> " }]],
    [`<html><HEAD><title>T</title></HEAD><p>No body element</p>`, [{ html: "<html> <p>No body element</p>" }]],
    [`<body class="x"><p>One</p></body><p>Between</p></BODY>`, [{ html: "<p>One</p></body><p>Between</p>" }]],
    [`<body epub:type="dedication"><p>For you</p></body>`, [{ html: "<p>For you</p>", hint: "dedication" }]],
    [
      `<body><section epub:type="dedication"><p>For you</p></section><p>Prose</p></body>`,
      [{ html: `<section epub:type="dedication"><p>For you</p></section>`, hint: "dedication" }, { html: "<p>Prose</p>" }]
    ],
    [
      `<body><section class="book-title-page"><h1>T</h1><p class="book-title-page__imprint">Made with Tomeza</p><p class='book-title-page__imprint'>unclosed</section></body>`,
      [{ html: `<section class="book-title-page"><h1>T</h1> <p class='book-title-page__imprint'>unclosed</section>`, hint: "title" }]
    ],
    [
      `<body><h2>Sources</h2><p>a</p><h2>About</h2> <div class="book-about-author"> </div><p>Bio</p></body>`,
      [{ html: "<h2>Sources</h2><p>a</p>" }, { html: `<h2>About</h2> <div class="book-about-author"> </div><p>Bio</p>` }]
    ],
    [`<body><!-- unclosed comment <p>x</p></body>`, [{ html: "<!-- unclosed comment <p>x</p>" }]],
    [`<body><h2 <h2 <h2>x</h2><div class="book-about-author"></div></body>`, [{ html: `<h2 <h2 <h2>x</h2><div class="book-about-author"></div>` }]],
    [`<body><script>never closed <p>x</p></body>`, [{ html: "<script>never closed <p>x</p>" }]]
  ])("splits %s as before", (html, blocks) => {
    expect(JSON.parse(JSON.stringify(epubMatterBlocks(html)))).toEqual(blocks);
  });

  it("stays linear on comments, scripts and body tags that never close", () => {
    // 1 to 2.1 s at the full size before, each.
    const adversarial: Array<[string, number]> = [
      ["<!--", 64_000],
      ["<script>", 32_000],
      ["<body>", 32_000],
      ["<head ", 32_000],
      ["<h2 ", 32_000]
    ];
    for (const [unit, count] of adversarial) {
      for (const repeats of [count / 10, count]) {
        const html = unit.repeat(repeats);
        const ms = readMs(() => epubMatterBlocks(html));
        expect(ms, `${unit} × ${repeats}: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
      }
    }
  });
});
