import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReaderChapter, ReaderChapterResult } from "@book-maker/core";
import {
  readCompatibleCachedReaderChapters,
  readerChapterCachePath,
  readerChaptersFromPublishedMarkdown,
  readerChaptersWithCache
} from "./readerChapterCache.js";

describe("readerChaptersWithCache", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  async function projectDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "reader-chapters-cache-"));
    dirs.push(dir);
    return dir;
  }

  const chapters: ReaderChapter[] = [
    { index: 1, title: "Openings", summary: "The first movement.", startPageIndex: 1, endPageIndex: 4 },
    { index: 2, title: "Endings", summary: "The last movement.", startPageIndex: 5, endPageIndex: 8 }
  ];

  const deterministicChapters: ReaderChapter[] = [
    { index: 1, title: "Pages 1-8", summary: "Grouped without a model.", startPageIndex: 1, endPageIndex: 8 }
  ];

  /** A charged compile: the model call is allowed, so the fallback never fires. */
  function resolve(options: {
    projectDir: string;
    fingerprint?: string;
    compute: () => Promise<ReaderChapterResult>;
    allowModelCall?: boolean;
    deterministic?: () => ReaderChapter[];
  }): Promise<ReaderChapter[]> {
    return readerChaptersWithCache({
      projectDir: options.projectDir,
      fingerprint: options.fingerprint ?? "abc",
      allowModelCall: options.allowModelCall ?? true,
      compute: options.compute,
      deterministic: options.deterministic ?? (() => deterministicChapters)
    });
  }

  it("computes on a miss and reuses the result on the next compile", async () => {
    const dir = await projectDir();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { chapters, source: "model" as const };
    };

    expect(await resolve({ projectDir: dir, compute })).toEqual(chapters);
    expect(await resolve({ projectDir: dir, compute })).toEqual(chapters);
    expect(calls).toBe(1);
  });

  it("caches an empty model result — a long single-arc book is the case worth caching", async () => {
    const dir = await projectDir();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { chapters: [], source: "model" as const };
    };

    expect(await resolve({ projectDir: dir, compute })).toEqual([]);
    expect(await resolve({ projectDir: dir, compute })).toEqual([]);
    expect(calls).toBe(1);
  });

  it("never writes a fallback result, so one provider outage is not frozen in", async () => {
    const dir = await projectDir();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { chapters, source: "fallback" as const };
    };

    expect(await resolve({ projectDir: dir, compute })).toEqual(chapters);
    expect(await resolve({ projectDir: dir, compute })).toEqual(chapters);
    expect(calls).toBe(2);
    await expect(readFile(readerChapterCachePath(dir), "utf8")).rejects.toThrow();
  });

  it("never writes a rejected result, so an unreadable reply is not frozen in", async () => {
    // The empty array here looks exactly like the one a long single-arc book
    // earns, and only `source` tells them apart — so this is the case a cache
    // keyed on the chapters alone would silently get wrong.
    const dir = await projectDir();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { chapters: [], source: "rejected" as const };
    };

    expect(await resolve({ projectDir: dir, compute })).toEqual([]);
    expect(await resolve({ projectDir: dir, compute })).toEqual([]);
    expect(calls).toBe(2);
    await expect(readFile(readerChapterCachePath(dir), "utf8")).rejects.toThrow();
  });

  it("recomputes when the manuscript fingerprint changes", async () => {
    const dir = await projectDir();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { chapters, source: "model" as const };
    };

    await resolve({ projectDir: dir, compute });
    await resolve({ projectDir: dir, fingerprint: "def", compute });
    expect(calls).toBe(2);
  });

  it("treats a corrupt cache file as a miss", async () => {
    const dir = await projectDir();
    await writeFile(readerChapterCachePath(dir), "{not json", "utf8");
    let calls = 0;

    const result = await resolve({
      projectDir: dir,
      compute: async () => {
        calls += 1;
        return { chapters, source: "model" as const };
      }
    });

    expect(result).toEqual(chapters);
    expect(calls).toBe(1);
  });

  describe("when the model call is not allowed", () => {
    const refuse = async (): Promise<ReaderChapterResult> => {
      throw new Error("A detached export repair must not call the chapterization model.");
    };

    it("still serves a cached answer, which is the usual repair", async () => {
      const dir = await projectDir();
      await resolve({ projectDir: dir, compute: async () => ({ chapters, source: "model" as const }) });

      expect(await resolve({ projectDir: dir, allowModelCall: false, compute: refuse })).toEqual(chapters);
    });

    it("serves a cached empty verdict rather than regrouping the book", async () => {
      // `[]` is a real answer — one uninterrupted arc — and it is cached, so a
      // repair must not hand the deterministic grouping back over the top of it.
      const dir = await projectDir();
      await resolve({ projectDir: dir, compute: async () => ({ chapters: [], source: "model" as const }) });

      expect(await resolve({ projectDir: dir, allowModelCall: false, compute: refuse })).toEqual([]);
    });

    it("falls back deterministically on a miss instead of spending", async () => {
      // The legacy case: a book compiled before the cache existed, or one whose
      // chapterization fell back, has no entry and never will until a charged
      // compile writes one.
      const dir = await projectDir();

      expect(await resolve({ projectDir: dir, allowModelCall: false, compute: refuse })).toEqual(
        deterministicChapters
      );
    });

    it("caches nothing on a miss, so the next charged compile still asks", async () => {
      const dir = await projectDir();
      let calls = 0;

      await resolve({ projectDir: dir, allowModelCall: false, compute: refuse });
      await resolve({ projectDir: dir, allowModelCall: false, compute: refuse });
      await expect(readFile(readerChapterCachePath(dir), "utf8")).rejects.toThrow();

      const charged = await resolve({
        projectDir: dir,
        compute: async () => {
          calls += 1;
          return { chapters, source: "model" as const };
        }
      });
      expect(charged).toEqual(chapters);
      expect(calls).toBe(1);
    });

    it("does not reuse a cached answer from a different manuscript", async () => {
      // The repair races an edit: the revision claim decides publication, but
      // stale boundaries must never be printed over rewritten prose.
      const dir = await projectDir();
      await resolve({ projectDir: dir, compute: async () => ({ chapters, source: "model" as const }) });

      expect(
        await resolve({ projectDir: dir, fingerprint: "edited", allowModelCall: false, compute: refuse })
      ).toEqual(deterministicChapters);
    });
  });

  it("recovers a compatible prior layout after an edit changed only the fingerprint", async () => {
    const dir = await projectDir();
    await resolve({ projectDir: dir, compute: async () => ({ chapters, source: "model" as const }) });

    await expect(
      readCompatibleCachedReaderChapters(
        dir,
        Array.from({ length: 8 }, (_, index) => ({ index: index + 1 }))
      )
    ).resolves.toEqual(chapters);
    await expect(
      readCompatibleCachedReaderChapters(
        dir,
        Array.from({ length: 9 }, (_, index) => ({ index: index + 1 }))
      )
    ).resolves.toBeUndefined();
  });

  it("recovers titles and boundaries from published Contents markup", () => {
    const markdown = [
      '<section class="book-contents book-contents--compact" aria-labelledby="book-contents-title">',
      '  <ol class="book-contents__list">',
      '    <li class="book-contents__item">',
      '      <span class="book-contents__name">Openings &amp; Questions</span>',
      '      <span class="book-contents__page">1</span>',
      "    </li>",
      '    <li class="book-contents__item">',
      '      <span class="book-contents__name">Endings</span>',
      '      <span class="book-contents__page">5</span>',
      "    </li>",
      "  </ol>",
      "</section>"
    ].join("\n");

    expect(
      readerChaptersFromPublishedMarkdown(
        markdown,
        Array.from({ length: 8 }, (_, index) => ({ index: index + 1 }))
      )
    ).toEqual([
      {
        index: 1,
        title: "Openings & Questions",
        summary: "",
        startPageIndex: 1,
        endPageIndex: 4
      },
      { index: 2, title: "Endings", summary: "", startPageIndex: 5, endPageIndex: 8 }
    ]);
  });

  it("treats a published book with no Contents section as no reader-chapter override", () => {
    expect(readerChaptersFromPublishedMarkdown("# One Arc\n\nProse.", [{ index: 1 }])).toEqual([]);
  });
});
