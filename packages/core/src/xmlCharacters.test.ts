import { describe, expect, it } from "vitest";
import { withoutXmlIllegalCharacters, withoutXmlIllegalCharactersOrReferences } from "./xmlCharacters.js";

describe("withoutXmlIllegalCharacters", () => {
  it("removes every C0 control but tab, line feed and carriage return", () => {
    const controls = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join("");
    expect(withoutXmlIllegalCharacters(`a${controls}b`)).toBe("a\t\n\rb");
  });

  it("removes the two noncharacters XML 1.0 refuses and every lone surrogate", () => {
    expect(withoutXmlIllegalCharacters("a\uFFFEb\uFFFFc")).toBe("abc");
    expect(withoutXmlIllegalCharacters("a\uD800b")).toBe("ab");
    expect(withoutXmlIllegalCharacters("a\uDC00b")).toBe("ab");
    // A low surrogate before its high one is two lone halves, not a pair.
    expect(withoutXmlIllegalCharacters("a\uDC00\uD800b")).toBe("ab");
    expect(withoutXmlIllegalCharacters("end\uD83D")).toBe("end");
  });

  it("keeps every character XML 1.0 allows, astral ones included", () => {
    const allowed = "Tab\there, Persian متن\u200cها, 山田\u3000太郎, NBSP\u00a0, NEL\u0085, DEL\u007f, \uFFFD, 👩‍👩‍👧, 🇮🇷, 𝔸";
    expect(withoutXmlIllegalCharacters(allowed)).toBe(allowed);
  });

  it("hands back the very string it was given when there is nothing to remove", () => {
    const text = "Nothing to strip here.\n";
    expect(withoutXmlIllegalCharacters(text)).toBe(text);
  });
});

describe("withoutXmlIllegalCharactersOrReferences", () => {
  it("drops a reference to every C0 control but tab, line feed and carriage return, in each spelling", () => {
    const codes = Array.from({ length: 0x20 }, (_, code) => code);
    const spellings = (code: number) => [
      `&#${code};`,
      `&#000${code};`,
      `&#x${code.toString(16)};`,
      `&#x${code.toString(16).toUpperCase()};`,
      `&#x00${code.toString(16).padStart(2, "0")};`
    ];
    for (const code of codes) {
      const kept = code === 0x9 || code === 0xa || code === 0xd;
      for (const reference of spellings(code)) {
        expect(withoutXmlIllegalCharactersOrReferences(`a${reference}b`)).toBe(kept ? `a${reference}b` : "ab");
      }
    }
  });

  it("drops a reference to a surrogate, a noncharacter XML refuses, or no code point at all", () => {
    for (const reference of [
      "&#xD800;", "&#xd800;", "&#55296;", "&#xDBFF;", "&#xDC00;", "&#xDFFF;", "&#57343;",
      "&#xFFFE;", "&#xfffe;", "&#65534;", "&#xFFFF;", "&#65535;",
      "&#x110000;", "&#1114112;", "&#x7FFFFFFF;",
      "&#99999999999999999999999999;", `&#x${"F".repeat(40)};`, `&#${"9".repeat(400)};`
    ]) {
      expect(withoutXmlIllegalCharactersOrReferences(`a${reference}b`)).toBe("ab");
    }
  });

  it("keeps a reference to every code point XML allows byte for byte, boundaries and leading zeros included", () => {
    const allowed =
      "&#9;&#xA;&#xa;&#13;&#x20;&#32;&#xD7FF;&#55295;&#xE000;&#xFFFD;&#65533;&#x10000;&#x10FFFF;&#1114111;" +
      "&#233;&#0233;&#x00e9;&#xE9;&#x1F600;&#128512;&#160;&#x20AC;";
    expect(withoutXmlIllegalCharactersOrReferences(`<p title="${allowed}">${allowed}</p>`)).toBe(`<p title="${allowed}">${allowed}</p>`);
  });

  it("leaves what only looks like a reference alone", () => {
    // `&amp;#11;` is the text "&#11;" — how marked writes it inside code. XML
    // has no `&#X`, and the rest are not references at all.
    const lookalikes = "&amp;#11; &amp;#xD800; &#X0B; &#11 &#; &#x; &#x0G; &#-11; &# 11; #11; &lt;#11;";
    expect(withoutXmlIllegalCharactersOrReferences(lookalikes)).toBe(lookalikes);
  });

  it("drops only the forbidden references among allowed ones, and the raw characters with them", () => {
    expect(withoutXmlIllegalCharactersOrReferences("<p>caf&#233;&#11; \u000b&#x1F600;&#xFFFE;\uD800 &amp;#11;</p>")).toBe(
      "<p>caf&#233; &#x1F600; &amp;#11;</p>"
    );
  });

  it("removes every raw character the text version removes", () => {
    const controls = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join("");
    const raw = `a${controls}\uFFFE\uFFFF\uD800\uDC00b 👩‍👩‍👧`;
    expect(withoutXmlIllegalCharactersOrReferences(raw)).toBe(withoutXmlIllegalCharacters(raw));
  });

  it("hands back an equal document when there is nothing to remove", () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<p title="R&amp;D">caf&#233; &#160;</p>\n';
    expect(withoutXmlIllegalCharactersOrReferences(xml)).toBe(xml);
  });
});
