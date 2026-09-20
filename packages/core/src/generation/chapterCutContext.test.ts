import { describe, expect, it } from "vitest";
import { chapterCutConstraints, chapterRemovedSpans, citedChapters } from "./chapterCutContext.js";

describe("cited chapters", () => {
  const chapters = Array.from({ length: 15 }, (_, i) => ({ index: i + 1, markdown: `Chapter ${i + 1} prose about the survey of ${1900 + i}.` }));
  it("reads the chapters the third 100-page book's notes named, in every form the read wrote them", () => {
    expect(citedChapters([
      "Cut the paragraph beginning 'The difference between Cocks's memorandum and the public RSA paper is visible in their circumstances as well as in their equations.' Chapter 3 already establishes the same distinction in the retained passage beginning 'By the time the RSA paper appeared in the February 1978 issue of Communications of the ACM'; both explain that classified Cocks material had mathematical priority.",
      "Cut the paragraph beginning 'Diffie and Hellman's public account in 1976 made this kind of exchange available to readers outside Cheltenham.' Chapter 3 already makes that point in the retained passage beginning 'On 8 June 1976, the public record acquired a compact description of that possibility'."
    ], chapters, { language: "en", except: 4 })).toEqual([3]);
    expect(citedChapters([
      "Cut the paragraph beginning 'A system can be described as secure against one party while being deliberately accessible to another.' Chapter 9 already establishes the same system-level point.",
      "Cut the paragraph beginning 'The distinction between a public parameter and a public derivation is easy to miss.' Chapter 10 already makes the same unexplained-parameter point in the retained passage beginning 'The constants were the troubling part'."
    ], chapters, { except: 10 })).toEqual([9]);
    // Naming only the chapter being cut is a recognised citation of nothing else: the reviewer needs no other chapter.
    expect(citedChapters(["Chapter 10 already makes the same point in its second paragraph."], chapters, { except: 10 })).toEqual([]);
    expect(citedChapters(["Chapters 12, 13 and 15 already restate this; so does chapter 2."], chapters, { except: 14 })).toEqual([2, 12, 13, 15]);
    // A year, a standard's number or a date is not a chapter.
    expect(citedChapters(["Cut the closing paragraph; FIPS 203 and the 13 August 2024 standards are already covered in chapter 1978."], chapters, { except: 13 })).toBeUndefined();
  });
  it("finds a chapter by the opening words the note quotes when no chapter is named", () => {
    const withProse = [...chapters, { index: 16, markdown: "The report ends here.\n\nThe survey explicitly rules out a causal conclusion, and says so twice." }];
    expect(citedChapters(["Cut the repeated caveat; “the survey explicitly rules out a causal conclusion” is already stated."], withProse, { except: 2 })).toEqual([16]);
    // A short or common quotation is not evidence of a chapter.
    expect(citedChapters(["Cut the paragraph beginning 'The report'."], withProse, { except: 2 })).toBeUndefined();
  });
  it("keeps every chapter in view when the notes cite nothing recognisable", () => {
    expect(citedChapters(["Cut the closing recap; the chapter already made the point."], chapters, { except: 5 })).toBeUndefined();
    expect(citedChapters([], chapters)).toBeUndefined();
  });
  it("reads the book language's word for chapter and its digits", () => {
    const persian = [{ index: 2, markdown: "متن فصل دوم." }, { index: 3, markdown: "متن فصل سوم." }, { index: 5, markdown: "متن فصل پنجم درباره پیمایش رود." }];
    expect(citedChapters(["این بند را حذف کن؛ فصل ۳ همین نکته را پیش‌تر گفته است."], persian, { language: "persian", except: 5 })).toEqual([3]);
    expect(citedChapters(["Kapitel 2 und 3 sagen dasselbe."], persian, { language: "german", except: 5 })).toEqual([2, 3]);
    expect(citedChapters(["第3章已经说明了这一点。"], persian, { language: "chinese", except: 5 })).toEqual([3]);
    expect(citedChapters(["3장에서 이미 다루었다."], persian, { language: "korean", except: 5 })).toEqual([3]);
    // The English word still counts in a translated book's notes, and «guillemets» quote its prose.
    expect(citedChapters(["Chapter 2 covers it; «متن فصل پنجم درباره پیمایش» is repeated."], persian, { language: "persian", except: 3 })).toEqual([2, 5]);
  });
});

describe("chapter cut context", () => {
  it("bounds a cut by the floor, quarter limit, and any caller limit", () => {
    const original = "word ".repeat(100);
    expect(chapterCutConstraints(original, 90).maxRemovableWords).toBe(10);
    expect(chapterCutConstraints(original, 0).maxRemovableWords).toBe(25);
    expect(chapterCutConstraints(original, 0, 7).maxRemovableWords).toBe(7);
    expect(chapterCutConstraints(original, 110).maxRemovableWords).toBe(0);
  });
  it("reports whole deleted sentences despite shared words with their neighbors", () => {
    expect(chapterRemovedSpans("The opening stays. The redundant sentence goes. The ending stays.", "The opening stays. The ending stays.")).toEqual([
      { removed: "The redundant sentence goes.", before: "The opening stays.", after: "The ending stays." }
    ]);
  });
  it("uses only surviving prose for both joins when multiple cuts share a paragraph", () => {
    expect(chapterRemovedSpans("Opening. Delete one. Middle. Delete two. Ending.", "Opening. Middle. Ending.")).toEqual([
      { removed: "Delete one.", before: "Opening.", after: "Middle. Ending." },
      { removed: "Delete two.", before: "Opening. Middle.", after: "Ending." }
    ]);
  });
  it("keeps original deletion bytes and candidate paragraph boundaries", () => {
    expect(chapterRemovedSpans("Opening.\n\nFirst loss.\nSecond loss.\n\nEnding.", "Opening.\n\nEnding.")).toEqual([
      { removed: "First loss.\nSecond loss.", before: "Opening.", after: "Ending." }
    ]);
  });
  it("does not describe a rewrite as a deletion", () => {
    expect(chapterRemovedSpans("The dam caused the flood.", "The flood caused the dam.")).toEqual([]);
  });
});
