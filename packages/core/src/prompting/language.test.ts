import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter, unsupportedGenerateWithTools } from "../adapters/fake.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  TextModelAdapter,
  TextResult,
  ToolCallsResult
} from "../adapters/types.js";
import {
  detectPromptLanguage,
  explicitLanguageRequest,
  LANGUAGE_CLAUSE_END_GUARD,
  LANGUAGE_NAME_CODES,
  languageNamePattern,
  normalizeProjectLanguage,
  targetLanguageGenerationGuidance,
  targetLanguagePayload
} from "./language.js";

describe("explicitLanguageRequest", () => {
  it("reads an explicit request to write the book in a language", () => {
    expect(explicitLanguageRequest("Write it in Spanish")).toBe("es");
    expect(explicitLanguageRequest("write the book in Persian please")).toBe("fa");
    expect(explicitLanguageRequest("Please write the whole book in German")).toBe("de");
    expect(explicitLanguageRequest("translate it into French")).toBe("fr");
    expect(explicitLanguageRequest("Can you make the book in Japanese?")).toBe("ja");
    expect(explicitLanguageRequest("I want the book in Chinese")).toBe("zh");
    expect(explicitLanguageRequest("I'd like the whole thing written in Russian")).toBe("ru");
    expect(explicitLanguageRequest("rewrite the pages in Arabic")).toBe("ar");
    expect(explicitLanguageRequest("language: German")).toBe("de");
    expect(explicitLanguageRequest("the language should be Italian")).toBe("it");
    expect(explicitLanguageRequest("set the language to Korean")).toBe("ko");
    expect(explicitLanguageRequest("use Japanese")).toBe("ja");
    expect(explicitLanguageRequest("in Spanish please")).toBe("es");
    expect(explicitLanguageRequest("In Portuguese, thanks")).toBe("pt");
  });

  // A language name is overwhelmingly more often the subject than the
  // instruction. Reading "aliens in Chinese media" as a request once wrote a
  // whole book in Chinese for a reader who only ever chatted in English.
  it("ignores a language named as subject matter", () => {
    expect(explicitLanguageRequest("Just write a book about aliens in Chinese media")).toBeUndefined();
    expect(
      explicitLanguageRequest("An informative guide to aliens in Chinese films, TV, and literature")
    ).toBeUndefined();
    expect(explicitLanguageRequest("a book about growing up in Italian villages")).toBeUndefined();
    expect(explicitLanguageRequest("a history of jazz in French colonial Africa")).toBeUndefined();
    expect(explicitLanguageRequest("make it about samurai in Japanese history")).toBeUndefined();
    expect(explicitLanguageRequest("write a story set in Japanese-occupied Korea")).toBeUndefined();
    expect(explicitLanguageRequest("a novel about a girl in Italian Renaissance Florence")).toBeUndefined();
    expect(explicitLanguageRequest("Explain the differences in German and Dutch grammar")).toBeUndefined();
    expect(
      explicitLanguageRequest("create a book on the rise of anime in Japanese pop culture")
    ).toBeUndefined();
    expect(explicitLanguageRequest("a novel set in Persian Gulf oil towns")).toBeUndefined();
    expect(explicitLanguageRequest("a guide to learning Spanish")).toBeUndefined();
    expect(explicitLanguageRequest("A bedtime story about a fox")).toBeUndefined();
  });

  // A name inside a list is naming a subject, not choosing one of several books.
  it("ignores a language that is one item of a list", () => {
    expect(
      explicitLanguageRequest("a guide to travel in Spanish, French, and German cities")
    ).toBeUndefined();
    expect(
      explicitLanguageRequest("a book about food in Japanese, Korean, and Thai cuisine")
    ).toBeUndefined();
    expect(explicitLanguageRequest("compare recipes in Italian and French cooking")).toBeUndefined();
  });

  it("lets an explicit English request undo a wrong language", () => {
    expect(explicitLanguageRequest("actually write it in English")).toBe("en");
    expect(targetLanguageGenerationGuidance(explicitLanguageRequest("write it in English")).join(" ")).toContain("Target language: English");
    expect(explicitLanguageRequest("No in English")).toBe("en");
    expect(explicitLanguageRequest("No, in English please")).toBe("en");
  });
});

describe("explicitLanguageRequest keeps every answer across the linear rewrite", () => {
  // Captured from the reader as it stood before its guard and its "language:"
  // pattern were made linear (each optional word now carries its own trailing
  // whitespace). The rewrite changes the backtracking and nothing else.
  const LANGUAGE_CORPUS: ReadonlyArray<readonly [string, string | undefined]> = [
    ["Write it in Spanish", "es"],
    ["write the book in Persian please", "fa"],
    ["Please write the whole book in German", "de"],
    ["translate it into French", "fr"],
    ["Can you make the book in Japanese?", "ja"],
    ["I want the book in Chinese", "zh"],
    ["rewrite the pages in Arabic", "ar"],
    ["language: German", "de"],
    ["the language should be Italian", "it"],
    ["set the language to Korean", "ko"],
    ["use Japanese", "ja"],
    ["in Spanish please", "es"],
    ["In Portuguese, thanks", "pt"],
    ["Just write a book about aliens in Chinese media", undefined],
    ["a book about food in Japanese, Korean, and Thai cuisine", undefined],
    ["compare recipes in Italian and French cooking", undefined],
    ["No, in English please", "en"],
    ["actually write it in English", "en"],
    ["make it in thai", "th"],
    ["make it in thai, and korean", undefined],
    ["make it in thai , or korean", undefined],
    ["make it in thai  and  korean please", undefined],
    ["make it in thai,korean", undefined],
    ["make it in thai and", undefined],
    ["make it in thai or", undefined],
    ["make it in thai, too", "th"],
    ["make it in thai as well", "th"],
    ["make it in thai)", "th"],
    ["make it in thai.", "th"],
    ["make it in thai \"now\"", "th"],
    ["the language is thai", "th"],
    ["the language  is  thai", "th"],
    ["languages:thai", "th"],
    ["the language should   be   Hindi", "hi"],
    ["language in Mandarin", "zh"],
    ["language into Farsi", "fa"],
    ["language = Greek", "el"],
    ["write it in Persian و بفرست", undefined],
    ["کتاب را in Spanish بنویس", undefined],
    ["écris-le en français", undefined],
    ["escríbelo en inglés", undefined],
    ["schreib es auf Deutsch", undefined],
    ["translate the book into Ukrainian and Polish", undefined],
    ["write it in Turkish thanks", "tr"],
    ["write it in Vietnamese,thanks", "vi"],
    ["write it in Danish\n", "da"],
    ["write it in Swedish\t\t,", "sv"],
    ["write it in Norwegian    or", undefined],
    ["write it in Dutch , and then add a cover", "nl"],
    ["in Hebrew", "he"],
    ["into Hindi.", "hi"],
    ["please, in Russian", "ru"],
    ["sorry, into Greek", "el"],
    ["no no in Korean", "ko"],
    ["use English or Spanish", undefined],
    ["use English, or Spanish", undefined]
  ];

  it("reads the same language, or none, from every phrasing it read before", () => {
    const moved = LANGUAGE_CORPUS.flatMap(([text, before]) => {
      const after = explicitLanguageRequest(text);
      return after === before ? [] : [{ text, before, after }];
    });
    expect(moved).toEqual([]);
  });

  // The guard and the "language:" pattern as they stood, kept as the reference
  // the rewrite is held to.
  const NAMES = languageNamePattern();
  const OLD_GUARD =
    `\\b(?!\\s*,?\\s*(?:and|or)?\\s*(?:${NAMES})\\b)` +
    `(?=\\s*$|\\s*[,.;:!?)"']|\\s+(?:please|thanks|thank\\s+you|only|instead|too|also|as\\s+well|now|ok|okay|` +
    `for|from|so|but|if|when|version|copy|edition|translation)\\b)`;
  const OLD_ANCHOR =
    "write|writes|written|writing|make|makes|made|generate|create|produce|translate|" +
    "translated|rewrite|regenerate|publish|render|say|convert|want|need|prefer|would\\s+like|" +
    "book|novel|story|text|pages?|chapters?";
  const OLD_PATTERNS = [
    new RegExp(`\\b(?:${OLD_ANCHOR})\\b[^.!?]{0,60}?\\b(?:in|into|to)\\s+(${NAMES})${OLD_GUARD}`, "iu"),
    new RegExp(`\\blanguages?\\b\\s*(?:is|are|:|=|should\\s+be|to|into|as|in)?\\s*(${NAMES})\\b`, "iu"),
    new RegExp(`\\buse\\s+(${NAMES})${OLD_GUARD}`, "iu"),
    new RegExp(`^\\W*(?:(?:no|actually|please|sorry)[,\\s]+)*(?:in|into)\\s+(${NAMES})${OLD_GUARD}`, "iu")
  ];
  const oldExplicit = (text: string): string | undefined => {
    const trimmed = text.trim();
    for (const pattern of trimmed ? OLD_PATTERNS : []) {
      const code = LANGUAGE_NAME_CODES[trimmed.match(pattern)?.[1]?.toLowerCase() ?? ""];
      if (code) {
        return code;
      }
    }
    return undefined;
  };
  // Every way the old optional pieces could sit around a run of whitespace.
  const PIECES = ["make it in", "language", " thai", "is", ",", "and", "or", " ", "  ", "\t", "\n", "korean", "x", "."];
  const texts: string[] = [];
  for (const a of PIECES) for (const b of PIECES) for (const c of PIECES) for (const d of PIECES) texts.push(a + b + c + d);

  it("agrees with the old reader on every short string built from its own pieces", () => {
    const moved = texts.flatMap((text) => {
      const before = oldExplicit(text);
      const after = explicitLanguageRequest(text);
      return after === before ? [] : [{ text, before, after }];
    });
    expect(moved).toEqual([]);
  });

  it("matches the same spans as the old guard, which the API's language-version reader appends too", () => {
    const oldGuarded = new RegExp(`\\b(?:in|to)\\s+(${NAMES})${OLD_GUARD}`, "giu");
    const newGuarded = new RegExp(`\\b(?:in|to)\\s+(${NAMES})${LANGUAGE_CLAUSE_END_GUARD}`, "giu");
    const spans = (pattern: RegExp, text: string): string =>
      [...text.matchAll(pattern)].map((match) => `${match.index}:${match[0]}`).join("|");
    const moved = texts.flatMap((raw) => {
      const text = `write it in ${raw}`;
      return spans(oldGuarded, text) === spans(newGuarded, text) ? [] : [text];
    });
    expect(moved).toEqual([]);
  });
});

describe("explicitLanguageRequest on adversarial input", () => {
  // The creation chat and the finished-book chat read this on the API's only
  // thread. Three `\s*` in a row around an optional comma and conjunction cut
  // one run of whitespace every possible way: "make it in thai", 3,000 spaces
  // and an "x" took 3 s. Each input is timed at 1k before 10k, so a
  // super-linear regression fails fast instead of hanging the suite.
  const fill =
    (head: string, filler: string, tail = "x") =>
    (length: number): string => {
      const room = length - head.length - tail.length;
      return head + filler.repeat(Math.ceil(room / filler.length)).slice(0, room) + tail;
    };
  const ADVERSARIAL: ReadonlyArray<readonly [string, (length: number) => string]> = [
    ["a request + spaces", fill("make it in thai", " ")],
    ["a request + tabs and newlines", fill("write it in thai\n", "\t\n")],
    ["a request + a comma and spaces", fill("make it in thai,", " ")],
    ["a request + spaced commas", fill("make it in thai", " ,")],
    ["a request + a conjunction and spaces", fill("make it in thai and", " ")],
    ["language + spaces", fill("the language", " ")],
    ["language is + spaces", fill("the language is", " ")],
    ["use + spaces", fill("use thai", " ")],
    ["a bare request + spaces", fill("in thai", " ")],
    ["a courtesy run before the request", fill("", "no, ", "in thai x")],
    ["repeated requests", fill("", "make it in thai ")]
  ];
  const readMs = (run: () => unknown): number => {
    // Best of two, so one slow read under load is not a failure.
    let best = Number.POSITIVE_INFINITY;
    for (let read = 0; read < 2; read += 1) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it("stays linear on long runs of whitespace between its optional words", () => {
    for (const [length, budgetMs] of [
      [1_000, 200],
      [10_000, 1_000]
    ] as const) {
      for (const [label, build] of ADVERSARIAL) {
        const text = build(length);
        expect(text).toHaveLength(length);
        const ms = readMs(() => explicitLanguageRequest(text));
        expect(ms, `${label} at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(budgetMs);
      }
    }
  });
});

describe("prompt language helpers", () => {
  it("makes English explicit even when it is the default language", async () => {
    await expect(
      detectPromptLanguage(new FakeTextModelAdapter(), "A practical book about community gardens.")
    ).resolves.toBe("en");

    expect(normalizeProjectLanguage("English")).toBe("en");
    expect(targetLanguageGenerationGuidance("en").join(" ")).toContain("Target language: English");
    expect(targetLanguagePayload("en")).toEqual({ targetLanguage: "English" });
  });

  it("detects and names non-English prompt languages", async () => {
    await expect(
      detectPromptLanguage(new FakeTextModelAdapter(), "یک کتاب کودکانه درباره ماه و قصه‌های شبانه.")
    ).resolves.toBe("Persian");

    expect(targetLanguageGenerationGuidance("fa").join(" ")).toContain("Persian");
    expect(targetLanguagePayload("Persian")).toEqual({ targetLanguage: "Persian" });
  });

  it("accepts detector responses that omit the optional language code", async () => {
    await expect(
      detectPromptLanguage(new LanguageOnlyDetectorAdapter("Persian"), "یک کتاب کودکانه درباره ماه.")
    ).resolves.toBe("Persian");
  });
});

class LanguageOnlyDetectorAdapter implements TextModelAdapter {
  constructor(private readonly language: string) {}

  async generateText(): Promise<TextResult> {
    return { text: this.language, model: "test-model", provider: "test" };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>) {
    const data = options.schema.parse({ language: this.language });
    return {
      data,
      text: JSON.stringify(data),
      model: "test-model",
      provider: "test"
    };
  }

  async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
    yield this.language;
  }

  generateWithTools(): Promise<ToolCallsResult> {
    return unsupportedGenerateWithTools();
  }
}
