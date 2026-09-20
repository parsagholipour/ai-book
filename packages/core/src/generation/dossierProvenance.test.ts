import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { dossierExcerptSchema } from "../schemas/episodes.js";
import { chapterEpigraph } from "./chapterApparatus.js";
import { reviewDossierProvenance } from "./dossierProvenance.js";

const text = "The Contents of the Nautical Almanac and Astronomical Ephkmeris for the year 1 842 are the Baine generally as those of the preceding year.";
const excerpt = dossierExcerptSchema.parse({ id: "x1", chapterIndex: 1, documentTitle: "Nautical Almanac", documentUrl: "https://example.test/almanac", author: "Airy", year: "1767", text });
function fixture() {
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockResolvedValue({ data: { verdict: "defect", reason: "1842 volume mislabeled 1767; OCR corrupts ephemeris and same." }, text: "", provider: "fake", model: "fake" });
  return { generate, options: {
    excerpts: [excerpt], textModel,
    documents: [{ id: "d1", title: excerpt.documentTitle, url: excerpt.documentUrl, host: "test", author: "Airy", year: "1767", text: "Nautical Almanac for 1842.\n\n" + text, episodeTitle: "Time" }],
    windows: [{ id: "w1", documentId: "d1", episodeTitle: "Time", score: 1, text }]
  } };
}

describe("dossier provenance before composition and epigraphs", () => {
  it("judges a normalized excerpt against the original wrapped source window", async () => {
    const test = fixture();
    const wrapped = text.replaceAll(" ", "\n\n");
    await reviewDossierProvenance({ ...test.options, windows: [{ ...test.options.windows[0]!, text: wrapped }] });
    expect(test.generate).toHaveBeenCalledOnce();
    expect(test.generate.mock.calls[0]![0].purpose).toBe("review-dossier-provenance");
    expect(JSON.parse(test.generate.mock.calls[0]![0].messages[1]!.content).passageWindows).toEqual([wrapped]);
  });
  it("drops an exact quotation when contextual review finds the edition or transcription wrong", async () => {
    const test = fixture();
    const kept = await reviewDossierProvenance(test.options);
    expect(kept).toEqual([]);
    expect(chapterEpigraph(kept)).toBeUndefined();
    const payload = JSON.parse(test.generate.mock.calls[0]![0].messages[1]!.content);
    expect(payload).toMatchObject({ excerpt, document: { catalogYear: "1767" }, passageWindows: [text] });
    expect(payload.documentOpeningExcerpt).toContain("1842");
  });

  it("reviews every excerpt and preserves authentic spelling and dates discussed in a verified older source unchanged", async () => {
    // No screen ahead of the review: across four evaluations a decision model never answered
    // `supported` confidently on an exact quotation, so every excerpt was reviewed anyway.
    const test = fixture();
    test.generate.mockResolvedValue({ data: { verdict: "supported", reason: "Register of 1612, passage verbatim." }, text: "", provider: "fake", model: "fake" });
    const source = "In the yeare 1600 the vessel made her passage, as we recorded in this register of 1612.";
    const clean = { ...excerpt, author: "", year: "1612", text: source };
    const kept = await reviewDossierProvenance({ ...test.options, excerpts: [clean], documents: [{ ...test.options.documents[0]!, author: "", year: "1612", text: "Register, 1612. " + source }], windows: [{ ...test.options.windows[0]!, text: source }] });
    expect(kept).toEqual([{ ...clean, provenanceVerified: true }]);
    expect(chapterEpigraph(kept)).toContain(source);
    expect(test.generate).toHaveBeenCalledOnce();
  });

  it.each(["uncertain", "malformed", "offline", "missing passage"])("does not authorize quotations after %s", async (kind) => {
    const test = fixture();
    if (kind === "offline") test.generate.mockRejectedValue(new Error("offline"));
    else test.generate.mockResolvedValue({ data: kind === "malformed" ? {} : { verdict: "insufficient_context", reason: "Edition not established" }, text: "", provider: "fake", model: "fake" });
    expect(await reviewDossierProvenance({ ...test.options, windows: kind === "missing passage" ? [] : test.options.windows })).toEqual([]);
    if (kind === "missing passage") expect(test.generate).not.toHaveBeenCalled();
  });

  it("propagates cancellation from the diagnostic", async () => {
    const test = fixture();
    const stop = Object.assign(new Error("Stopped"), { name: "StopRequestedError" });
    test.generate.mockRejectedValue(stop);
    await expect(reviewDossierProvenance(test.options)).rejects.toBe(stop);
  });
});
