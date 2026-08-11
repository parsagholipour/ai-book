/**
 * Renders the PDF fixture corpus, so a change to book typography can be looked
 * at before and after rather than argued about.
 *
 * Deliberately not a test. Nothing here asserts; it writes PDFs and prints how
 * long each took. The permanent guards are `pdf.test.ts`'s recorded page count
 * and `pdfDocument.test.ts`'s stylesheet digests — this is what you run when one
 * of those fires, or before touching `pdfCss.ts`, `pdfDocument.ts` or the
 * `md-to-pdf` pin, because a page count is one number and a book is a shape.
 *
 *   pnpm render:fixtures --baseline HEAD out/before
 *   pnpm render:fixtures out/after
 *   pnpm render:fixtures --compare out/before out/after
 *
 * `--baseline <ref>` checks that ref out into a throwaway git worktree, lends it
 * this checkout's installed dependencies, copies *this* file over the one the ref
 * carries and renders there — so both sides share the fixture corpus and only the
 * typography differs. It replaces a `git stash` recipe that could not work: the
 * change under test is routinely what adds the `render:fixtures` script and the
 * `packages/core` exports this file imports, so stashing it takes the harness's
 * own footing away, and `git stash -u` takes the harness with it.
 *
 * Add `--install` when the change moves a dependency — the `md-to-pdf` pin is the
 * one that matters — because borrowed `node_modules` are this tree's, so the
 * baseline would otherwise render against the very version being compared. It
 * runs `pnpm install --frozen-lockfile` against the ref's own lockfile instead,
 * which is slow and needs the network the first time.
 *
 * The comparison checks page counts first — the cheapest signal that margins or
 * the base stylesheet drifted — then rasterises every page at 100 dpi, reports
 * any page whose raster changed size, and counts differing pixels on the rest.
 * Byte-comparing PDFs proves nothing: `/CreationDate`, `/ID` and font-subset
 * ordering differ run to run.
 *
 * Needs poppler-utils (`pdfinfo`, `pdftoppm`) for `--compare`.
 */

import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(HARNESS_PATH));

/**
 * `packages/core` is imported dynamically and typed by hand because a baseline
 * render runs this file against an *older* checkout of it, where an export it
 * names may not exist yet — `closeSharedBrowser` did not, one commit ago. A
 * static named import of a missing export is a link error, thrown before a line
 * of this file runs, which is the failure mode the baseline mode exists to avoid.
 */
type FixtureCore = {
  generateBookPdf: (
    markdown: string,
    options: {
      imageStorageDir: string;
      publicApiUrl: string;
      outputPath: string;
      language: string;
      projectId: string;
    }
  ) => Promise<unknown>;
  closeSharedBrowser?: () => Promise<void>;
  installSharedBrowserSignalHandlers?: () => () => void;
};

async function loadCore(): Promise<FixtureCore> {
  return (await import("../packages/core/src/index.js")) as unknown as FixtureCore;
}

const PUBLIC_API_URL = "http://localhost:4001";
const FIXTURE_PROJECT = "fixture";

function paragraphs(count: number, prefix: string): string {
  const body =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(
      6
    );
  return Array.from(
    { length: count },
    (_, index) => `## ${prefix} ${index + 1}\n\nThis is the body of ${prefix.toLowerCase()} ${index + 1}. ${body}`
  ).join("\n\n");
}

function image(file: string): string {
  return `${PUBLIC_API_URL}/assets/images/${FIXTURE_PROJECT}/${file}`;
}

/**
 * One fixture per thing that has broken, or could. Between them they cover the
 * cascade (`markdown.css` → highlight theme → ours), both text directions, a
 * script with no Latin fallback, the illustration path, the cover page, and the
 * dense Contents variant.
 */
const FIXTURES: ReadonlyArray<{ name: string; language: string; markdown: string }> = [
  {
    name: "text-only-en",
    language: "en",
    markdown: `# The Quiet Engine\n\nAn opening note.\n\n${paragraphs(12, "Chapter")}`
  },
  {
    name: "illustrated-en",
    language: "en",
    markdown: `# The Painted Hours\n\nAn opening note.\n\n${Array.from(
      { length: 8 },
      (_, index) =>
        `## Chapter ${index + 1}\n\n![Illustration](${image("art.svg")})\n\nBody text for chapter ${index + 1}. ${"Some prose to fill the page. ".repeat(24)}`
    ).join("\n\n")}`
  },
  {
    name: "persian-rtl",
    language: "Farsi",
    markdown: `# کتاب ماه\n\nاین یک آزمایش است.\n\n${Array.from(
      { length: 10 },
      (_, index) =>
        `## فصل ${index + 1}\n\n${"این متن آزمایشی برای بررسی چیدمان راست‌به‌چپ است و باید در چند خط بشکند. ".repeat(12)}\n\n> نقل قول کوتاه.\n\n- مورد اول\n- مورد دوم`
    ).join("\n\n")}`
  },
  {
    name: "cjk",
    language: "zh",
    markdown: `# 静默的引擎\n\n开篇说明。\n\n${Array.from(
      { length: 8 },
      (_, index) => `## 第${index + 1}章\n\n${"这是用于测试排版的示例文本，需要跨越多行显示。".repeat(20)}`
    ).join("\n\n")}`
  },
  {
    name: "rich-blocks",
    language: "en",
    markdown: [
      "# Rich Blocks",
      "",
      "## Everything At Once",
      "",
      "A paragraph before the fence.",
      "",
      "```js",
      "const answer = 42;",
      "function compute(input) {",
      "  return input.map((value) => value * answer);",
      "}",
      "```",
      "",
      "| Column A | Column B | Column C |",
      "| --- | ---: | :---: |",
      "| one | 1 | x |",
      "| two | 22 | yy |",
      "| three | 333 | zzz |",
      "",
      "> A blockquote that runs on for a little while so it wraps onto a second line at least once.",
      "",
      "1. First item",
      "   - nested a",
      "   - nested b",
      "2. Second item",
      "   1. nested one",
      "   2. nested two",
      "",
      "Some `inline code` and a [link](https://example.com) and *emphasis* and **strong**.",
      "",
      "---",
      "",
      paragraphs(4, "Section")
    ].join("\n")
  },
  {
    name: "cover-first",
    language: "en",
    markdown: `![Book cover](${image("cover.svg")})\n\n# The Covered Book\n\nOpening.\n\n${paragraphs(6, "Chapter")}`
  },
  {
    name: "fifteen-chapters",
    language: "en",
    markdown: `# The Long Index\n\n<div class="book-contents book-contents--dense">\n<p class="book-contents__eyebrow">Contents</p>\n<h2>Contents</h2>\n<div class="book-contents__ornament"></div>\n<ul class="book-contents__list">\n${Array.from(
      { length: 15 },
      (_, index) =>
        `<li class="book-contents__item"><a class="book-contents__link" href="#c${index + 1}"><span class="book-contents__chapter">Chapter ${index + 1}</span><span class="book-contents__name">A Chapter Title Number ${index + 1}</span><span class="book-contents__leader"></span><span class="book-contents__page">${index * 2 + 3}</span></a></li>`
    ).join("\n")}\n</ul>\n</div>\n\n${paragraphs(15, "Chapter")}`
  }
];

/**
 * Flat SVGs rather than photographs: a pixel diff should report layout, not
 * codec noise. The explicit width and height matter — an illustration lays out
 * at its intrinsic aspect ratio, so the dimensions are part of what is being
 * pinned.
 */
async function writeFixtureImages(directory: string): Promise<void> {
  await mkdir(join(directory, FIXTURE_PROJECT), { recursive: true });
  const flat = (width: number, height: number, fill: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="${fill}"/></svg>`;
  await writeFile(join(directory, FIXTURE_PROJECT, "art.svg"), flat(600, 800, "#c8503c"), "utf8");
  await writeFile(join(directory, FIXTURE_PROJECT, "cover.svg"), flat(1800, 2400, "#1e3c8c"), "utf8");
}

async function renderAll(outputDir: string): Promise<void> {
  const core = await loadCore();
  const removeSignalHandlers = core.installSharedBrowserSignalHandlers?.() ?? (() => undefined);
  await mkdir(outputDir, { recursive: true });
  const imageStorageDir = await mkdtemp(join(tmpdir(), "book-fixture-images-"));
  try {
    await writeFixtureImages(imageStorageDir);
    for (const fixture of FIXTURES) {
      const startedAt = Date.now();
      await core.generateBookPdf(fixture.markdown, {
        imageStorageDir,
        publicApiUrl: PUBLIC_API_URL,
        outputPath: join(outputDir, `${fixture.name}.pdf`),
        language: fixture.language,
        projectId: FIXTURE_PROJECT
      });
      console.log(`${fixture.name.padEnd(18)} ${Date.now() - startedAt} ms`);
    }
    console.log(`\n${FIXTURES.length} fixtures → ${outputDir}`);
  } finally {
    try {
      await rm(imageStorageDir, { recursive: true, force: true });
    } finally {
      try {
        // Keep trapping signals until the pooled Chromium is actually gone.
        // Optional because an old baseline closed its own browser per render.
        await core.closeSharedBrowser?.();
      } finally {
        removeSignalHandlers();
      }
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
}

/**
 * pnpm keeps this workspace's dependencies isolated per package rather than
 * hoisted, so the fonts and puppeteer a render needs live in
 * `packages/core/node_modules`, not at the root. The worktree gets a symlink to
 * each one that exists: resolution walks up from the module's own path, and
 * these are read-only for the length of a render.
 *
 * Returns the links it made, because they point at the real install and are
 * unlinked before the worktree is torn down rather than trusted to a recursive
 * delete's treatment of symlinks.
 */
async function lendInstalledDependencies(worktree: string): Promise<string[]> {
  const candidates = ["."];
  for (const group of ["apps", "packages"]) {
    if (!(await exists(join(REPO_ROOT, group)))) continue;
    for (const entry of await readdir(join(REPO_ROOT, group))) candidates.push(join(group, entry));
  }
  const linked: string[] = [];
  for (const candidate of candidates) {
    const source = join(REPO_ROOT, candidate, "node_modules");
    if (!(await exists(source))) continue;
    const target = join(worktree, candidate, "node_modules");
    if (await exists(target)) continue;
    await mkdir(dirname(target), { recursive: true });
    await symlink(source, target, "junction");
    linked.push(target);
  }
  if (linked.length === 0) {
    throw new Error("nothing installed to lend the baseline — run `pnpm install`, or pass --install");
  }
  return linked;
}

/**
 * Renders the corpus from another commit, without disturbing this working tree.
 *
 * The harness is copied in rather than taken from the ref: the fixtures are the
 * control, so a ref whose corpus differs — or which has no corpus at all,
 * because the change under test is what added it — would report its own text as
 * layout drift.
 */
async function renderBaseline(ref: string, outputDir: string, install: boolean): Promise<void> {
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`);
  const tsx = join(REPO_ROOT, "node_modules", ".bin", "tsx");
  if (!(await exists(tsx))) throw new Error(`no ${tsx} to run the baseline with — run \`pnpm install\``);

  // git refuses to plant a worktree on a path that already exists, and mkdtemp
  // creates one, so the temporary directory is its parent.
  const scratch = await mkdtemp(join(tmpdir(), "book-fixture-baseline-"));
  const worktree = join(scratch, "checkout");
  let linked: string[] = [];
  try {
    git("worktree", "add", "--detach", worktree, commit);
    await mkdir(join(worktree, "scripts"), { recursive: true });
    await copyFile(HARNESS_PATH, join(worktree, "scripts", basename(HARNESS_PATH)));
    if (install) {
      execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, stdio: "inherit" });
    } else {
      linked = await lendInstalledDependencies(worktree);
    }
    console.log(
      `baseline ${ref} = ${commit.slice(0, 12)}` +
        `${install ? "  (installed from its own lockfile)" : "  (dependencies borrowed from this checkout)"}\n`
    );
    execFileSync(tsx, [join(worktree, "scripts", basename(HARNESS_PATH)), outputDir], {
      cwd: worktree,
      stdio: "inherit"
    });
  } finally {
    for (const link of linked) await unlink(link).catch(() => {});
    try {
      git("worktree", "remove", "--force", worktree);
    } catch {
      console.warn(`could not remove the baseline worktree; \`git worktree remove --force ${worktree}\``);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

function pageCount(pdf: string): number {
  const info = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
  return Number(/^Pages:\s+(\d+)$/m.exec(info)?.[1] ?? -1);
}

type Raster = { width: number; height: number; pixels: Buffer };

async function readPpm(path: string): Promise<Raster> {
  const bytes = await readFile(path);
  let offset = 0;
  const tokens: string[] = [];
  while (tokens.length < 4) {
    while (/\s/.test(String.fromCharCode(bytes[offset] ?? 0))) offset += 1;
    if (bytes[offset] === 35) {
      while (offset < bytes.length && bytes[offset] !== 10) offset += 1;
      continue;
    }
    const start = offset;
    while (offset < bytes.length && !/\s/.test(String.fromCharCode(bytes[offset] ?? 0))) offset += 1;
    tokens.push(bytes.subarray(start, offset).toString("ascii"));
  }
  return {
    width: Number(tokens[1]),
    height: Number(tokens[2]),
    pixels: bytes.subarray(offset + 1)
  };
}

/**
 * Differing pixels as a fraction, with a tolerance: antialiasing is not layout.
 *
 * Null when the two pages are not the same size, which is drift on its own and
 * cannot be measured: rows missing from the bottom are never visited by a count
 * taken from the shorter page, and a column removed from the side shifts every
 * row against its neighbour, so the fraction stops describing the layout.
 */
function differingFraction(before: Raster, after: Raster): number | null {
  if (before.width !== after.width || before.height !== after.height) return null;
  const count = before.width * before.height;
  let differing = 0;
  for (let pixel = 0; pixel < count; pixel += 1) {
    const at = pixel * 3;
    if (
      Math.abs((before.pixels[at] ?? 0) - (after.pixels[at] ?? 0)) > 8 ||
      Math.abs((before.pixels[at + 1] ?? 0) - (after.pixels[at + 1] ?? 0)) > 8 ||
      Math.abs((before.pixels[at + 2] ?? 0) - (after.pixels[at + 2] ?? 0)) > 8
    ) {
      differing += 1;
    }
  }
  return differing / count;
}

async function compare(beforeDir: string, afterDir: string): Promise<number> {
  let drifted = 0;
  const files = (await readdir(beforeDir)).filter((file) => file.endsWith(".pdf")).sort();
  for (const file of files) {
    const name = basename(file, ".pdf");
    const before = join(beforeDir, file);
    const after = join(afterDir, file);
    const beforePages = pageCount(before);
    const afterPages = pageCount(after);
    if (beforePages !== afterPages) {
      console.log(`${name.padEnd(18)} PAGE COUNT ${beforePages} -> ${afterPages}   *** DRIFT ***`);
      drifted += 1;
      continue;
    }

    const beforeRaster = await mkdtemp(join(tmpdir(), "cmp-before-"));
    const afterRaster = await mkdtemp(join(tmpdir(), "cmp-after-"));
    try {
      execFileSync("pdftoppm", ["-r", "100", before, join(beforeRaster, "p")]);
      execFileSync("pdftoppm", ["-r", "100", after, join(afterRaster, "p")]);
      const beforePpms = (await readdir(beforeRaster)).sort();
      const afterPpms = (await readdir(afterRaster)).sort();
      let worst = 0;
      let worstPage = 0;
      let resized = false;
      for (let index = 0; index < beforePpms.length; index += 1) {
        const beforePage = await readPpm(join(beforeRaster, beforePpms[index]!));
        const afterPage = await readPpm(join(afterRaster, afterPpms[index]!));
        const fraction = differingFraction(beforePage, afterPage);
        if (fraction === null) {
          console.log(
            `${name.padEnd(18)} PAGE SIZE page ${index + 1} ` +
              `${beforePage.width}x${beforePage.height} -> ${afterPage.width}x${afterPage.height}` +
              `   *** DRIFT ***`
          );
          resized = true;
          break;
        }
        if (fraction > worst) {
          worst = fraction;
          worstPage = index + 1;
        }
      }
      if (resized) {
        drifted += 1;
        continue;
      }
      const percent = worst * 100;
      const verdict = percent > 0.5 ? "*** DRIFT ***" : percent > 0.02 ? "(minor)" : "identical";
      if (percent > 0.5) drifted += 1;
      console.log(
        `${name.padEnd(18)} ${String(beforePages).padStart(3)}p  worst page ${worstPage} ${percent.toFixed(4)}%  ${verdict}`
      );
    } finally {
      await rm(beforeRaster, { recursive: true, force: true });
      await rm(afterRaster, { recursive: true, force: true });
    }
  }
  console.log(drifted === 0 ? "\nOK: no layout drift" : `\n${drifted} fixture(s) drifted`);
  return drifted;
}

const argv = process.argv.slice(2);
const install = argv.includes("--install");
const [first, ...rest] = argv.filter((argument) => argument !== "--install");
if (first === "--compare") {
  const [beforeDir, afterDir] = rest;
  if (!beforeDir || !afterDir) {
    throw new Error("usage: render-book-fixtures.ts --compare <beforeDir> <afterDir>");
  }
  process.exitCode = (await compare(beforeDir, afterDir)) === 0 ? 0 : 1;
} else if (first === "--baseline") {
  const [ref, outputDir] = rest;
  if (!ref) {
    throw new Error("usage: render-book-fixtures.ts --baseline <ref> [outDir] [--install]");
  }
  // Resolved here: the render runs with the worktree as its working directory.
  await renderBaseline(ref, resolvePath(outputDir ?? "output/book-fixtures-before"), install);
} else {
  await renderAll(first ?? "output/book-fixtures");
  await writeFile(
    join(first ?? "output/book-fixtures", "README.txt"),
    "Rendered by `pnpm render:fixtures`. Compare two of these directories with\n" +
      "`pnpm render:fixtures --compare <before> <after>`.\n",
    "utf8"
  );
}
