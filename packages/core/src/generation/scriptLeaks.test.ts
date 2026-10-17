import { describe, expect, it } from "vitest";
import { bookLetterScripts, describeScriptLeaks, findScriptLeaks } from "./scriptLeaks.js";

const fa = { language: "fa" };
const en = { language: "en" };
const words = (markdown: string, options: Parameters<typeof findScriptLeaks>[1]) =>
  findScriptLeaks(markdown, options).map((leak) => `${leak.kind}:${leak.script}:${leak.word}`);

describe("findScriptLeaks", () => {
  // E1c (2026-10-16), the same Persian chapter: Gemini, gpt-6-luna, and the production draft before them.
  it("finds the E1c leaks in a Persian chapter", () => {
    const gemini = "لید برنجیِ سنگین با دسته‌ای حلقه شکل در کف دستِ باز او بود، покрыیده از گردِ خاکِ زرد و ریشه‌های باریک و خشکیدهٔ شمعدانی.";
    expect(words(gemini, fa)).toEqual(["fused:Cyrillic:покрыیده"]);
    const luna = "پیرمرد گفت. نوه‌اش یک քայլ جلو آمد، բայց پیرمرد دست բարձր نکرد. جوان از آن سوی در گفت:";
    expect(words(luna, fa)).toEqual(["inline:Armenian:քայլ", "inline:Armenian:բայց", "inline:Armenian:բարձր"]);
    const production = "یکی از دانه‌ها به آستینش چسبید. «من تنها չէم؛ فقط کسی اینجا نیست.»";
    expect(words(production, fa)).toEqual(["fused:Armenian:չէم"]);
    expect(findScriptLeaks(gemini, { language: "Persian" })).toHaveLength(1);
  });

  // Every hit on the 18,059 stored pages and 5,663 stored chapter drafts and edits, all real leaks.
  it("finds the stored English leaks: another script fused into a word", () => {
    expect(words("Communist forces entered Beiping after the Nationalist commander傅作义 reached an agreement.", en))
      .toEqual(["fused:Han:commander傅作义"]);
    expect(words("The tribute system imposes these limits, capping the索取 and ensuring fairness.", en)).toEqual(["fused:Han:the索取"]);
    expect(words("The scene braided these cables, twisting them with绞合 and twists.", en)).toEqual(["fused:Han:with绞合"]);
    expect(words("a vulnerability that the pasture allocation制度 sought to mitigate", en)).toEqual(["fused:Han:allocation制度"]);
    expect(words("At places such as Ribاط-i Sharaf in Khurasan, built in the Seljuq period", en)).toEqual(["fused:Arabic:Ribاط"]);
  });

  it("passes what the stored pages hold legitimately", () => {
    // The honorific ligature after the Prophet's name (13 stored pages).
    expect(words("The Prophet ﷺ said: \"Prayer in congregation is twenty-seven times better.\" After the Prophet's ﷺ death", en)).toEqual([]);
    // Greek letters as transliteration and as math (22 stored pages).
    expect(words("The relay stations known as *ulaγaγči* or, in later imperial practice, *ulaγa* and *ulaγan*.", en)).toEqual([]);
    expect(words("Euler’s totient φ(N) = (p−1)(q−1) = 160, and y = αˣ modulo p gives αˣᵏ.", en)).toEqual([]);
    // A Latin-script book quotes a word in its own script, bare: 元朝秘史 is the one inline shape the English pages hold.
    expect(words("he completed the collation of a manuscript copy of the 元朝秘史 Yüan-ch'ao pi-shih, \"Secret History of the Mongols\".", en)).toEqual([]);
    expect(words("A blunt удар shook frost from the palisade.", en)).toEqual([]);
  });

  it("allows Latin in every book, and Persian suffixes joined to it", () => {
    expect(words("فایل‌های PDFها را با iPhone و Wi-Fi باز کرد و ۱۲ cm جلو رفت.", fa)).toEqual([]);
    expect(words("Он открыл iPhone и прочитал PDF.", { language: "ru" })).toEqual([]);
    expect(words("彼はiPhoneで漢字とカタカナを読んだ。", { language: "ja" })).toEqual([]);
    expect(words("그는 韓國의 iPhone을 샀다.", { language: "ko" })).toEqual([]);
  });

  it("skips code, math and links", () => {
    expect(words("کد زیر را ببینید:\n\n```python\nprint(\"привет\")  # Ελληνικά\n```\n\nو سپس `пример` را اجرا کنید.", fa)).toEqual([]);
    expect(words("زاویهٔ $\\alpha + β = γδεζ$ برابر است و \\(λμνξ\\) نیز.", fa)).toEqual([]);
    expect(words("نشانی https://ru.wikipedia.org/wiki/Тегеран را ببینید.", fa)).toEqual([]);
  });

  it("passes a foreign word a writer set off, and finds one standing bare in a Persian sentence", () => {
    expect(words("واژهٔ یونانی «λόγος» به معنای سخن است.", fa)).toEqual([]);
    expect(words("واژهٔ یونانی (λόγος) به معنای سخن است.", fa)).toEqual([]);
    expect(words("واژهٔ یونانی *λόγος* به معنای سخن است.", fa)).toEqual([]);
    expect(words("λόγος — لوگوس", fa)).toEqual([]);
    expect(words("واژهٔ یونانی λόγος به معنای سخن است.", fa)).toEqual(["inline:Greek:λόγος"]);
    // A Greek symbol of up to three letters is not a word.
    expect(words("زاویهٔ αβ برابر است.", fa)).toEqual([]);
    // A ZWNJ-joined suffix keeps the word inside the sentence.
    expect(words("نوه‌اش یک քայլ‌ها جلو آمد.", fa)).toEqual(["inline:Armenian:քայլ"]);
  });

  it("allows a script the brief is written in or names the language of", () => {
    const named = "دوستم Արամ دیروز آمد و Արամ‌را دیدم.";
    expect(words(named, fa)).toHaveLength(2);
    expect(words(named, { ...fa, brief: "یک داستان کوتاه دربارهٔ دوستم Արամ" })).toEqual([]);
    const primer = "کلمهٔ привет یعنی سلام و کلمهٔ спасибо یعنی ممنون.";
    expect(words(primer, fa)).toHaveLength(2);
    expect(words(primer, { ...fa, brief: "کتاب آموزش زبان روسی برای مبتدیان" })).toEqual([]);
    expect(words(primer, { ...fa, brief: "A Russian primer for Persian speakers" })).toEqual([]);
    // A name inside a longer word is not the language: «عروسی» is a wedding, not Russian.
    expect(words(primer, { ...fa, brief: "داستانی دربارهٔ یک عروسی" })).toHaveLength(2);
    expect(words("The Nationalist commander傅作义 agreed.", { ...en, brief: "A history of the Chinese civil war" })).toEqual([]);
  });

  it("checks every known script, and nothing whose script is unknown", () => {
    expect(words("彼は한국어で話した。", { language: "ja" })).toEqual(["fused:Hangul:彼は한국어で話した"]);
    expect(words("Он сделал один քայլ вперёд.", { language: "ru" })).toEqual(["inline:Armenian:քայլ"]);
    expect(words("Ο άνθρωπος είπε שלום στο παιδί.", { language: "el" })).toEqual(["inline:Hebrew:שלום"]);
    expect(bookLetterScripts("am")).toBeUndefined();
    expect(words("ሰላም покры ዓለም", { language: "am" })).toEqual([]);
    expect(bookLetterScripts("fi")).toEqual([]);
    expect(bookLetterScripts(undefined)).toEqual([]);
  });

  it("describes a few distinct words", () => {
    const leaks = findScriptLeaks("نوه‌اش یک քայլ جلو آمد، բայց پیرمرد دست բարձր نکرد و یک քայլ دیگر، покрыیده از گرد.", fa);
    expect(describeScriptLeaks(leaks)).toBe("\"քայլ\" (Armenian), \"բայց\" (Armenian), \"բարձր\" (Armenian) and 1 more");
  });
});
