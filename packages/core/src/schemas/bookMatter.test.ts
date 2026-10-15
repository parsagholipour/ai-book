import { describe, expect, it } from "vitest";
import { BOOK_MATTER_LIMITS, bookMatterYear, cleanMatterText, parseBookMatter } from "./bookMatter.js";

const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/u;

describe("cleanMatterText", () => {
  it("reads a pasted soft line break, page break or Unicode separator as the line break it is", () => {
    // Word and PowerPoint write Shift+Enter as U+000B; it ended every EPUB and
    // Word export of the book as XML that would not parse.
    expect(cleanMatterText("For Mom,\u000bwho taught me", 100)).toBe("For Mom,\nwho taught me");
    expect(cleanMatterText("One\u000cTwo\u2028Three\u2029Four\u0085Five", 100)).toBe("One\nTwo\nThree\nFour\nFive");
  });

  it("folds those breaks into one space in a one-line field", () => {
    expect(cleanMatterText("Ada\u000bLovelace\u2028Press", 100, { singleLine: true })).toBe("Ada Lovelace Press");
    expect(cleanMatterText(" Ada \n\n Press ", 100, { singleLine: true })).toBe("Ada Press");
    // A no-break or ideographic space is typography, not a line break.
    expect(cleanMatterText("山田\u3000太郎\u00a0Press", 100, { singleLine: true })).toBe("山田\u3000太郎\u00a0Press");
  });

  it("drops every other character XML 1.0 forbids, and a line left blank by it", () => {
    expect(cleanMatterText("For\u0001 Mom\u001f\uFFFE\uFFFF \uD800Dad\uDC00", 100)).toBe("For Mom Dad");
    expect(cleanMatterText("For Mom\n\u0001\u0002\n\nLove", 100)).toBe("For Mom\n\nLove");
    expect(cleanMatterText("\u0001\u0008\u000e", 100)).toBeUndefined();
  });

  it("drops the chat's literal marks from a value copied out of a reply, and keeps a script's joiners", () => {
    // `chatMarkdownLiteral` quoted "For *Mom*" with U+FEFF beside each mark and
    // U+2060 after a bracket or before a list line; a composer copied them.
    expect(cleanMatterText("For ﻿*﻿Mom﻿*﻿ and Dad", 100)).toBe("For *Mom* and Dad");
    expect(cleanMatterText("⁠1. Sam [⁠x]⁠", 100)).toBe("1. Sam [x]");
    expect(parseBookMatter({ dedication: "For ﻿_﻿Dad﻿_﻿" })).toEqual({ dedication: "For _Dad_" });
    for (const text of ["تقدیم به مادرم‌ها", "क्‍ष", "👩‍👩‍👧"]) {
      expect(cleanMatterText(text, 100)).toBe(text);
    }
  });

  it("never leaves half an emoji where the clip falls inside one", () => {
    const clipped = cleanMatterText(`abc👩`, 4);
    expect(clipped).toBe("abc");
    expect(clipped).not.toMatch(XML_ILLEGAL);
  });

  it("keeps a tab and a well-formed text exactly as it was", () => {
    const text = "For Mom & Dad <3,\twho said \"yes\".\n\nAnd for 👩‍👩‍👧, متن\u200cها.";
    expect(cleanMatterText(text, 1000)).toBe(text);
  });
});

describe("parseBookMatter", () => {
  it("cleans a value already stored with a control character", () => {
    const matter = parseBookMatter({
      dedication: "For Mom,\u000bwho taught me\u0001",
      aboutAuthor: "Ada writes.\u000cShe lives by the sea.\uFFFE",
      imprint: "Clockwork\u000bPress",
      copyrightHolder: "Ada\u2028Lovelace\uD800",
      isbn: "978-0-306-40615-7\u0001",
      authorWebsite: "ada.example.com\u0007"
    });
    expect(matter).toEqual({
      dedication: "For Mom,\nwho taught me",
      aboutAuthor: "Ada writes.\nShe lives by the sea.",
      imprint: "Clockwork Press",
      copyrightHolder: "Ada Lovelace",
      isbn: "978-0-306-40615-7",
      authorWebsite: "ada.example.com"
    });
  });

  it("still clips an overlong stored value to its ceiling", () => {
    expect(parseBookMatter({ imprint: "x".repeat(500) }).imprint).toHaveLength(BOOK_MATTER_LIMITS.imprint);
  });

  it("keeps an imported book's own © year only when it is a year", () => {
    expect(parseBookMatter({ copyrightYear: "2019" })).toEqual({ copyrightYear: "2019" });
    expect(parseBookMatter({ copyrightYear: " 2015 –  2019 " })).toEqual({ copyrightYear: "2015 – 2019" });
    for (const copyrightYear of ["19", "2019 Jane Doe", 2019, "", "<b>2019</b>"]) {
      expect(parseBookMatter({ copyrightYear })).toEqual({});
    }
  });
});

describe("bookMatterYear", () => {
  it("is the book's own © year, else the year it was created", () => {
    const createdAt = new Date("2026-12-31T23:30:00Z");
    expect(bookMatterYear({ copyrightYear: "2019" }, createdAt)).toBe("2019");
    expect(bookMatterYear({ dedication: "For Sara" }, createdAt)).toBe(2026);
  });
});
