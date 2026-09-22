import JSZip from "jszip";
import { afterAll, expect, it } from "vitest";
import { closeSharedBrowser, withRenderPage } from "./browserPool.js";
import { generateBookEpub } from "./epub.js";

afterAll(closeSharedBrowser);

it("writes well-formed XHTML when bibliography URLs have query separators", async () => {
  const url = "https://www.open.edu/openlearn/mod/oucontent/view.php?id=48322&section=1.3";
  const zip = await JSZip.loadAsync(await generateBookEpub([
    "# Sources", `[Open University](${url})`,
    '<p>R&amp;D costs &#163;5&nbsp;&amp;&nbsp;&#x20AC;6. A & B.</p>'
  ].join("\n\n"), { title: "Sources", imageStorageDir: "/tmp", publicApiUrl: "http://localhost:4001" }));
  const xhtml = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
  await withRenderPage(async (page) => {
    const parsed = await page.evaluate((source) => {
      const document = new DOMParser().parseFromString(source, "application/xhtml+xml");
      return { error: document.querySelector("parsererror")?.textContent, href: document.querySelector("a")?.getAttribute("href"), text: document.documentElement.textContent };
    }, xhtml);
    expect(parsed.error).toBeUndefined();
    expect(parsed.href).toBe(url);
    expect(parsed.text).toContain("R&D costs £5\u00a0&\u00a0€6. A & B.");
  });
}, 30_000);
