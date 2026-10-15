/**
 * Every character XML 1.0 refuses to carry, raw or escaped: the C0 controls
 * except tab, line feed and carriage return, the noncharacters U+FFFE and
 * U+FFFF, and a surrogate without its partner. With the `u` flag a
 * well-formed pair is one astral code point, so the surrogate range matches
 * only a lone half.
 */
const XML_ILLEGAL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿\uD800-\uDFFF]/gu;

/**
 * The same characters, plus every numeric character reference in the two
 * spellings XML reads as one: `&#` and decimal digits, or `&#x` and hex digits
 * of either case. `&#X…;` is not a reference in XML, so it is not matched.
 */
const XML_ILLEGAL_CHARACTERS_OR_REFERENCES = new RegExp(
  `${XML_ILLEGAL_CHARACTERS.source}|&#(?:x([0-9A-Fa-f]+)|([0-9]+));`,
  "gu"
);

/**
 * The text with every character XML 1.0 forbids taken out, and nothing else
 * touched — a text that had none comes back identical, so a file that parsed
 * before is byte-identical after.
 *
 * One such character anywhere makes the whole document ill-formed: a
 * dedication pasted from Word carries U+000B for every Shift+Enter, and the
 * EPUB chapter and the Word file's `document.xml` that held it would not open.
 * Escaping cannot save it, because `&#11;` is refused exactly as the raw
 * character is.
 */
export function withoutXmlIllegalCharacters(text: string): string {
  return text.replace(XML_ILLEGAL_CHARACTERS, "");
}

/**
 * An XML document with every character XML 1.0 forbids taken out, whether it
 * is written raw or as a numeric character reference — `&#11;`, `&#x0B;`,
 * `&#0000011;`, `&#xD800;`, `&#xFFFE;`, `&#x110000;` and a number too long to
 * be a code point all go, the reference whole. Use it on markup, never on text
 * that will be escaped later: in text, `&#11;` is five harmless characters.
 *
 * A forbidden reference is dropped rather than turned into U+FFFD because it
 * is the same character as the raw one `withoutXmlIllegalCharacters` drops,
 * and the same character should come out the same whichever way it was
 * spelled; a replacement glyph would also print a visible "�" where the PDF
 * shows nothing. A reference to an allowed code point, and anything that only
 * looks like one — `&amp;#11;` is the text "&#11;", as marked writes it inside
 * code — is left byte for byte, so a document with nothing to drop comes back
 * identical. The one place markup and text disagree is CDATA, where a
 * reference is literal text; nothing here writes CDATA, and dropping a
 * forbidden one there still leaves the document well-formed.
 */
export function withoutXmlIllegalCharactersOrReferences(xml: string): string {
  return xml.replace(XML_ILLEGAL_CHARACTERS_OR_REFERENCES, (match, hex: string | undefined, decimal: string | undefined) => {
    const code = hex !== undefined ? Number.parseInt(hex, 16) : decimal !== undefined ? Number.parseInt(decimal, 10) : undefined;
    return code !== undefined && xmlAllowsCodePoint(code) ? match : "";
  });
}

/**
 * XML 1.0's `Char` production. A number past U+10FFFF — or one so long that
 * parsing it lost precision or overflowed to Infinity — is not a character.
 */
function xmlAllowsCodePoint(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}
