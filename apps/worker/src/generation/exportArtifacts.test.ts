import { EXPORT_FORMATS } from "@book-maker/core";
import { describe, expect, it } from "vitest";
import {
  artifactPublications,
  EVERY_COMPANION_PRODUCED,
  formatsTouchedByPublication,
  pendingExportPaths,
  publishedExportFormats,
  type CompanionsProduced
} from "./exportArtifacts.js";

/**
 * The list of files a publication installs and retires, as a pure function. The
 * nested ternary this replaced had no direct test, so the whole grid is spelled
 * out here rather than inferred from the renames a publication happens to make.
 */

const noEpub: CompanionsProduced = { epub: false, docx: true };
const noDocx: CompanionsProduced = { epub: true, docx: false };
const none: CompanionsProduced = { epub: false, docx: false };

describe("publishedExportFormats", () => {
  it("installs the PDF and every companion a full compile rendered", () => {
    expect(publishedExportFormats({ companionsProduced: EVERY_COMPANION_PRODUCED, repairFormat: null })).toEqual(["pdf", "epub", "docx"]);
    expect(publishedExportFormats({ companionsProduced: noEpub, repairFormat: null })).toEqual(["pdf", "docx"]);
    expect(publishedExportFormats({ companionsProduced: noDocx, repairFormat: null })).toEqual(["pdf", "epub"]);
    expect(publishedExportFormats({ companionsProduced: none, repairFormat: null })).toEqual(["pdf"]);
  });

  it("installs only the repaired format, and nothing when that companion failed", () => {
    expect(publishedExportFormats({ companionsProduced: EVERY_COMPANION_PRODUCED, repairFormat: "pdf" })).toEqual(["pdf"]);
    expect(publishedExportFormats({ companionsProduced: EVERY_COMPANION_PRODUCED, repairFormat: "epub" })).toEqual(["epub"]);
    expect(publishedExportFormats({ companionsProduced: EVERY_COMPANION_PRODUCED, repairFormat: "docx" })).toEqual(["docx"]);
    expect(publishedExportFormats({ companionsProduced: noDocx, repairFormat: "docx" })).toEqual([]);
    expect(publishedExportFormats({ companionsProduced: noEpub, repairFormat: "epub" })).toEqual([]);
    // A PDF repair does not look at the companions it did not render.
    expect(publishedExportFormats({ companionsProduced: none, repairFormat: "pdf" })).toEqual(["pdf"]);
  });
});

describe("artifactPublications", () => {
  const pending = pendingExportPaths("/books/p", "token");
  const live = (name: string) => `/books/p/${name}`;
  const summarize = (publications: ReturnType<typeof artifactPublications>) =>
    publications.map((publication) => `${publication.pending === null ? "retire" : "install"} ${publication.live}`);

  it("installs the whole set on a full compile", () => {
    expect(
      summarize(
        artifactPublications({ projectDir: "/books/p", pending, companionsProduced: EVERY_COMPANION_PRODUCED, repairFormat: null, publishReconstructedMarkdown: false })
      )
    ).toEqual([
      `install ${live("book.md")}`,
      `install ${live("book.pdf")}`,
      `install ${live("book.epub")}`,
      `install ${live("book.docx")}`
    ]);
  });

  it("retires every companion a full compile could not render", () => {
    expect(
      summarize(
        artifactPublications({ projectDir: "/books/p", pending, companionsProduced: none, repairFormat: null, publishReconstructedMarkdown: false })
      )
    ).toEqual([
      `install ${live("book.md")}`,
      `install ${live("book.pdf")}`,
      `retire ${live("book.epub")}`,
      `retire ${live("book.docx")}`
    ]);
  });

  it("touches only the repaired format on a repair, plus any reconstructed markdown", () => {
    for (const repairFormat of ["pdf", "epub", "docx"] as const) {
      expect(
        summarize(
          artifactPublications({ projectDir: "/books/p", pending, companionsProduced: EVERY_COMPANION_PRODUCED, repairFormat, publishReconstructedMarkdown: false })
        ),
        repairFormat
      ).toEqual([`install ${live(`book.${repairFormat}`)}`]);
      expect(
        summarize(
          artifactPublications({ projectDir: "/books/p", pending, companionsProduced: EVERY_COMPANION_PRODUCED, repairFormat, publishReconstructedMarkdown: true })
        ),
        repairFormat
      ).toEqual([`install ${live("book.md")}`, `install ${live(`book.${repairFormat}`)}`]);
    }
  });

  it("retires the repaired companion when its render failed, and leaves the other companion alone", () => {
    expect(
      summarize(
        artifactPublications({ projectDir: "/books/p", pending, companionsProduced: noDocx, repairFormat: "docx", publishReconstructedMarkdown: false })
      )
    ).toEqual([`retire ${live("book.docx")}`]);
    expect(
      summarize(
        artifactPublications({ projectDir: "/books/p", pending, companionsProduced: none, repairFormat: "epub", publishReconstructedMarkdown: true })
      )
    ).toEqual([`install ${live("book.md")}`, `retire ${live("book.epub")}`]);
    // A PDF repair never retires a companion, whatever it did not render.
    expect(
      summarize(
        artifactPublications({ projectDir: "/books/p", pending, companionsProduced: none, repairFormat: "pdf", publishReconstructedMarkdown: false })
      )
    ).toEqual([`install ${live("book.pdf")}`]);
  });

  it("parks each predecessor under a per-publication name beside its scratch twin", () => {
    const [markdown] = artifactPublications({
      projectDir: "/books/p",
      pending,
      companionsProduced: EVERY_COMPANION_PRODUCED,
      repairFormat: null,
      publishReconstructedMarkdown: false
    });
    expect(markdown?.pending).toBe("/books/p/.book-token.md");
    expect(markdown?.superseded).toMatch(/^\/books\/p\/\.book-superseded-[0-9a-f-]+\.md$/);
  });
});

describe("formatsTouchedByPublication", () => {
  it("writes or retires a record for every format a full compile owns, and only the repaired one otherwise", () => {
    expect([...formatsTouchedByPublication(null)]).toEqual([...EXPORT_FORMATS]);
    expect([...formatsTouchedByPublication("epub")]).toEqual(["epub"]);
    expect([...formatsTouchedByPublication("docx")]).toEqual(["docx"]);
  });
});
