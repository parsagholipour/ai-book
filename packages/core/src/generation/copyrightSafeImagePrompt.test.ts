import { describe, expect, it, vi } from "vitest";
import {
  COPYRIGHT_SAFE_IMAGE_PROMPT_PURPOSE,
  CopyrightRewriteLeakError,
  rewriteImagePromptForCopyright,
  type CopyrightSafeImagePromptOutcome
} from "./copyrightSafeImagePrompt.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";

/**
 * What the real adapters do: they validate inside `generateJson` and raise
 * `AdapterJsonValidationError`, which `generateJsonWithRetry` treats as
 * repairable — so a reply the schema refuses is paid for twice, on the
 * identical schema, before the outcome resolves.
 */
const adapterAnswering = (data: unknown) =>
  vi.fn(async (options: GenerateJsonOptions<unknown>) => ({
    provider: "fake",
    model: "fake",
    text: "",
    data: parseSchemaWithContext("Fake", options.schema, data, options.purpose, "")
  }));

const textModel = (generateJson: TextModelAdapter["generateJson"]): TextModelAdapter =>
  ({
    generateText: async () => {
      throw new Error("unused");
    },
    generateJson
  }) as unknown as TextModelAdapter;

const answering = (data: unknown) =>
  textModel(
    vi.fn(async (options: { schema: { parse: (value: unknown) => unknown } }) => ({
      provider: "fake",
      model: "fake",
      text: "",
      data: options.schema.parse(data)
    })) as unknown as TextModelAdapter["generateJson"]
  );

describe("rewriteImagePromptForCopyright", () => {
  it("returns the rewritten prompt and the names it removed", async () => {
    const result = await rewriteImagePromptForCopyright({
      textModel: answering({
        prompt: "A young masked hero in a red-and-blue suit swings over the city at night.",
        changed: true,
        replaced: ["Spider-Man"]
      }),
      prompt: "Spider-Man swings over the city at night.",
      reason: "DataInspectionFailed"
    });

    expect(result).toEqual({
      outcome: "rewritten",
      prompt: "A young masked hero in a red-and-blue suit swings over the city at night.",
      replaced: ["Spider-Man"]
    });
  });

  it("passes the refusal reason and its own purpose to the model", async () => {
    const generateJson = vi.fn(async (options: { schema: { parse: (value: unknown) => unknown } }) => ({
      provider: "fake",
      model: "fake",
      text: "",
      data: options.schema.parse({ prompt: "rewritten", changed: true, replaced: [] })
    }));

    await rewriteImagePromptForCopyright({
      textModel: textModel(generateJson as unknown as TextModelAdapter["generateJson"]),
      prompt: "Spider-Man on a rooftop.",
      reason: "Fallback error: Output data is suspected of being involved in IP infringement"
    });

    const call = generateJson.mock.calls[0]?.[0] as unknown as { purpose: string; messages: { content: string }[] };
    expect(call.purpose).toBe(COPYRIGHT_SAFE_IMAGE_PROMPT_PURPOSE);
    // The prose, not a reason code: it names what was objected to.
    expect(call.messages.at(-1)?.content).toContain("IP infringement");
    expect(call.messages.at(-1)?.content).toContain("Spider-Man on a rooftop.");
  });

  it("has nothing to retry with when the model found nothing protected", async () => {
    const unchanged = await rewriteImagePromptForCopyright({
      textModel: answering({ prompt: "A girl and her dog.", changed: false, replaced: [] }),
      prompt: "A girl and her dog.",
      reason: "IMAGE_RECITATION"
    });
    expect(unchanged).toEqual({ outcome: "declined" });

    // `changed: true` over an identical prompt is the same nothing, and
    // retrying it would buy a second refusal at full price.
    const identical = await rewriteImagePromptForCopyright({
      textModel: answering({ prompt: "A girl and her dog.", changed: true, replaced: ["Lassie"] }),
      prompt: "A girl and her dog.",
      reason: "IMAGE_RECITATION"
    });
    expect(identical).toEqual({ outcome: "declined" });
  });

  it("leaves the caller's refusal standing when the rewrite itself fails, and says it failed", async () => {
    const outage = new Error("model is down");
    const failing = textModel((async () => {
      throw outage;
    }) as unknown as TextModelAdapter["generateJson"]);

    // Both of these leave the refusal standing; only one of them was paid for
    // and answered nothing, and the run log has to be able to tell them apart.
    await expect(
      rewriteImagePromptForCopyright({ textModel: failing, prompt: "Spider-Man.", reason: "IMAGE_RECITATION" })
    ).resolves.toEqual({ outcome: "failed", error: outage });

    const declined = await rewriteImagePromptForCopyright({
      textModel: answering({ prompt: "A girl and her dog.", changed: false, replaced: [] }),
      prompt: "A girl and her dog.",
      reason: "IMAGE_RECITATION"
    });
    expect(declined).toEqual({ outcome: "declined" });
  });

  it("declines a prompt too long to be worth a model call without calling one", async () => {
    const generateJson = vi.fn();
    const result = await rewriteImagePromptForCopyright({
      textModel: textModel(generateJson as unknown as TextModelAdapter["generateJson"]),
      prompt: "x".repeat(12_001),
      reason: "IMAGE_RECITATION"
    });

    expect(result).toEqual({ outcome: "declined" });
    expect(generateJson).not.toHaveBeenCalled();
  });

  it("takes a rewrite that grew past the gate, because growing is what a rewrite is", async () => {
    // The gate asks whether a prompt is small enough to be worth paying to
    // rewrite; the reply's ceiling asks whether the model's answer is usable.
    // While those were one number a prompt anywhere near the gate could not be
    // rewritten at all — swapping a protected name for a generic description is
    // the entire job, and it makes the prompt longer every time it works. The
    // reply came back over the same cap, the schema refused it,
    // `generateJsonWithRetry` spent its repair attempt on that identical
    // schema, and two paid calls resolved `failed` with the picture still
    // refused. Dense script, so nothing here is near the token fuse either.
    const original = "字".repeat(11_900);
    const grown = `${original}${"字".repeat(300)}`;
    const generateJson = adapterAnswering({ prompt: grown, changed: true, replaced: ["Spider-Man"] });

    const result = await rewriteImagePromptForCopyright({
      textModel: textModel(generateJson as unknown as TextModelAdapter["generateJson"]),
      prompt: original,
      reason: "Output data is suspected of being involved in IP infringement"
    });

    expect(result).toEqual({ outcome: "rewritten", prompt: grown, replaced: ["Spider-Man"] });
    // One call, not the repair attempt on the same schema that the refusal cost.
    expect(generateJson).toHaveBeenCalledTimes(1);
  });

  it("still lets a stop out, because a stopped run must not reach a second image call", async () => {
    class StopRequestedError extends Error {}
    const stopped = textModel((async () => {
      throw new StopRequestedError("stopped");
    }) as unknown as TextModelAdapter["generateJson"]);

    await expect(
      rewriteImagePromptForCopyright({
        textModel: stopped,
        prompt: "Spider-Man.",
        reason: "IMAGE_RECITATION",
        bailOnError: (error) => error instanceof StopRequestedError
      })
    ).rejects.toThrow("stopped");
  });
});

/** The names a leak refused, or a failure saying what came back instead. */
const leakedNames = (result: CopyrightSafeImagePromptOutcome): string[] => {
  if (result.outcome !== "failed" || !(result.error instanceof CopyrightRewriteLeakError)) {
    throw new Error(`expected a refused leak, got ${JSON.stringify(result)}`);
  }
  return result.error.survivingNames;
};

const rewriting = (reply: { prompt: string; replaced: string[] }, original: string) =>
  rewriteImagePromptForCopyright({
    textModel: answering({ prompt: reply.prompt, changed: true, replaced: reply.replaced }),
    prompt: original,
    reason: "Output data is suspected of being involved in IP infringement"
  });

describe("a rewrite that keeps a name it reported removing", () => {
  it("refuses the comparison leak REWRITE_RULES warns about, rather than paying to draw it", async () => {
    // `replaced` is a self-report and it is written to the asset row as settled
    // provenance. This reply passes every other gate — changed, non-empty, not
    // the original — so untested it bought a second primary→fallback render of
    // a prompt that still names the character, and `metadata.copyrightRewrite`
    // recorded "Spider-Man removed" over whatever the second provider drew.
    const result = await rewriting(
      {
        prompt: "A young masked hero in a red-and-blue suit, in Spider-Man style, on a rooftop.",
        replaced: ["Spider-Man"]
      },
      "Spider-Man on a rooftop."
    );

    expect(leakedNames(result)).toEqual(["Spider-Man"]);
  });

  it("reads the leak case-folded, because a proper noun spelled small is the same name", async () => {
    const result = await rewriting(
      { prompt: "A masked hero who moves like spider-man over the rooftops.", replaced: ["Spider-Man"] },
      "Spider-Man over the rooftops."
    );

    expect(leakedNames(result)).toEqual(["Spider-Man"]);
  });

  it("names every survivor and no name that was actually removed", async () => {
    const result = await rewriting(
      {
        prompt: "A young masked hero in a red-and-blue suit meets Elsa on a rooftop.",
        replaced: ["Spider-Man", "Elsa", "Batman"]
      },
      "Spider-Man meets Elsa and Batman on a rooftop."
    );

    expect(leakedNames(result)).toEqual(["Elsa"]);
  });

  it("is not a decline, because the model did not read the prompt and find nothing protected", async () => {
    // The two outcomes both keep the caller's refusal and draw nothing, and the
    // run log is the only place they are told apart — `declined` here would
    // record "this book named nothing protected" about a book that did.
    const result = await rewriting(
      { prompt: "A masked hero, in Spider-Man style, on a rooftop.", replaced: ["Spider-Man"] },
      "Spider-Man on a rooftop."
    );

    expect(result.outcome).toBe("failed");
  });

  it("catches a name in a script an ASCII word boundary cannot see", async () => {
    // `\b` sits between a word character and a non-word one, and no Persian
    // letter is a word character — so `\bعلی\b` matches nowhere and every
    // non-Latin leak walks straight through. Most books here are not in Latin.
    const leak = await rewriting(
      { prompt: "کودکی نقاب‌دار مانند علی روی پشت‌بام ایستاده است.", replaced: ["علی"] },
      "علی روی پشت‌بام ایستاده است."
    );
    expect(leakedNames(leak)).toEqual(["علی"]);

    // And the other half of the same rule: a zero-width non-joiner continues
    // the word, so «علی‌رضا» is somebody else and not a surviving «علی».
    const joined = await rewriting(
      { prompt: "کودکی نقاب‌دار به نام علی‌رضا روی پشت‌بام ایستاده است.", replaced: ["علی"] },
      "علی روی پشت‌بام ایستاده است."
    );
    expect(joined).toEqual({
      outcome: "rewritten",
      prompt: "کودکی نقاب‌دار به نام علی‌رضا روی پشت‌بام ایستاده است.",
      replaced: ["علی"]
    });
  });
});

describe("a rewrite that only re-spelled the name it removed", () => {
  // Every one of these passed the check while it folded with nothing but
  // `toLowerCase`, so the caller bought a second full primary→fallback render
  // of a prompt that still names the character and — where that landed — a
  // settled row asserting a removal that had not happened. A re-spelling is not
  // a different name: it is the same letters, encoded another way.
  const respellings: [label: string, rewritten: string, removed: string][] = [
    // A zero-width non-joiner is not even a different rendering.
    ["a zero-width joiner dropped inside the name", "A hero, in Spider\u200C-Man style, on a rooftop.", "Spider-Man"],
    ["a bidi mark dropped inside the name", "A hero, in Spider\u200E-Man style, on a rooftop.", "Spider-Man"],
    // NFC in `replaced`, NFD in the prompt: canonically equivalent, which is
    // Unicode's own way of saying they are the same text.
    ["the decomposed spelling of a composed name", `A trainer in ${"Pokémon".normalize("NFD")} style.`, "Pokémon"],
    ["the composed spelling of a decomposed name", "A trainer in Pokémon style.", "Pokémon".normalize("NFD")],
    // What a model reaches for inside a name it does not want broken over a line.
    ["a non-breaking hyphen for the ASCII one", "A hero, in Spider\u2011Man style, on a rooftop.", "Spider-Man"],
    ["a fullwidth hyphen for the ASCII one", "A hero, in Spider\uFF0DMan style, on a rooftop.", "Spider-Man"],
    // The apostrophe every model writes, and the one every keyboard types.
    ["a curly apostrophe for a straight one", "A tale of Bilbo\u2019s ring.", "Bilbo's"],
    ["a straight apostrophe for a curly one", "A tale of Bilbo's ring.", "Bilbo\u2019s"],
    ["the modifier letter apostrophe, which is a letter", "A tale of Bilbo\u02BCs ring.", "Bilbo's"],
    // A model trained on Arabic writes «ي»/«ك» into a Persian prompt; that is a
    // keyboard, not a rename. Most books here are not in Latin script.
    ["Arabic yeh where the name carries the Persian one", "کودکی مانند علي روی پشت‌بام.", "علی"],
    ["Arabic kaf where the name carries the Persian one", "کودکی مانند كیان روی پشت‌بام.", "کیان"],
    // «R۲-D۲» is R2-D2.
    ["Arabic-Indic digits for ASCII ones", "یک ربات به نام R2\u0660\u0661 اینجاست.", "R201"],
    ["Persian digits for ASCII ones", "یک ربات به نام R2\u06F0\u06F1 اینجاست.", "R201"]
  ];

  it.each(respellings)("catches %s", async (_label, rewritten, removed) => {
    expect(leakedNames(await rewriting({ prompt: rewritten, replaced: [removed] }, `${removed} on a rooftop.`))).toEqual([
      removed
    ]);
  });
});

describe("a rewrite that did the job", () => {
  it("is taken whole, and a name only found inside a longer word is not a survivor", async () => {
    // Substring matching is the other way to get this wrong: a removed `Sam`
    // found inside "same" vetoes a rewrite that is fine, and a rejected rewrite
    // is a picture the book does not get. The same sub-token collision
    // `matchLibraryCharacter` was burned by one directory over.
    const rewritten =
      "A cheerful boy and his grandmother bake in the same warm kitchen, up on the hill, with a batman-shaped cutter.";
    const result = await rewriting({ prompt: rewritten, replaced: ["Sam", "Bat"] }, "Sam and Batman bake.");

    expect(result).toEqual({ outcome: "rewritten", prompt: rewritten, replaced: ["Sam", "Bat"] });
  });

  it("lets a hyphen join a word rather than end it, so a longer name is not the shorter one", async () => {
    const rewritten = "A small brown rabbit called Luna-Bear naps under the porch.";
    const result = await rewriting({ prompt: rewritten, replaced: ["Luna"] }, "Luna naps under the porch.");

    expect(result).toEqual({ outcome: "rewritten", prompt: rewritten, replaced: ["Luna"] });
  });

  it("joins from either side of the hyphen, because a compound is one word in both directions", async () => {
    // The rule reached only the *trailing* boundary, because the leading test
    // was `libraryMentions.ts`'s marker test and a marker has no hyphen in
    // front of it. `-` is not a name character, so a hyphen before a match
    // suppressed nothing: "Luna-Bear" was correctly kept and "Bear-Luna" was
    // scored a surviving "Luna". Welding a word onto the archetype is exactly
    // what REWRITE_RULES asks the model to invent, so these are the shape of a
    // rewrite that *worked* — each discarded as a leak, handing the caller back
    // its refusal with two paid text calls spent.
    const compounds: [rewritten: string, removed: string][] = [
      ["A small brown rabbit called Bear-Luna naps under the porch.", "Luna"],
      ["A courier drone banks over Neo-Tokyo at dusk.", "Tokyo"],
      ["A friendly Spider-Bot skitters up the wall.", "Bot"],
      // The leading half of the same rule, which always worked.
      ["A small brown rabbit called Luna-Bear naps under the porch.", "Luna"],
      // A non-breaking hyphen joins too, so the set is the set and not just `-`.
      ["A small brown rabbit called Bear\u2011Luna naps under the porch.", "Luna"],
      // And a script whose compounds an ASCII boundary cannot read either way.
      ["خرگوشی به نام مهتاب-خرس زیر ایوان می‌خوابد.", "خرس"],
      ["خرگوشی به نام خرس-مهتاب زیر ایوان می‌خوابد.", "خرس"]
    ];

    for (const [rewritten, removed] of compounds) {
      await expect(rewriting({ prompt: rewritten, replaced: [removed] }, `${removed} naps.`)).resolves.toEqual({
        outcome: "rewritten",
        prompt: rewritten,
        replaced: [removed]
      });
    }
  });

  it("still reads a hyphen with nothing on its far side as ordinary punctuation", async () => {
    // The mirror is not an escape hatch. A hyphen joins only where there is a
    // word on both sides of it, so neither of these is a compound and both are
    // a Luna the rewrite reported removing and then kept.
    for (const rewritten of [
      "A small brown rabbit - Luna - naps under the porch.",
      "A small brown rabbit -Luna naps under the porch."
    ]) {
      const result = await rewriting({ prompt: rewritten, replaced: ["Luna"] }, "Luna naps.");
      expect(leakedNames(result)).toEqual(["Luna"]);
    }
  });

  it("is not vetoed by a blank name, which would otherwise match everywhere", async () => {
    // `z.string().max(120)` admits an empty string and models pad lists, and an
    // empty needle is found in every prompt there is.
    const rewritten = "A young masked hero in a red-and-blue suit on a rooftop.";
    const result = await rewriting({ prompt: rewritten, replaced: ["", "  "] }, "Spider-Man on a rooftop.");

    expect(result).toEqual({ outcome: "rewritten", prompt: rewritten, replaced: ["", "  "] });
  });

  it("still matches a two-word name the rewrite broke over a line", async () => {
    const rewritten = "A cheerful cartoon mouse in red shorts,\ndrawn in Mickey Mouse\nstyle, waving.";
    const result = await rewriting({ prompt: rewritten, replaced: ["Mickey  Mouse"] }, "Mickey Mouse waving.");

    expect(leakedNames(result)).toEqual(["Mickey  Mouse"]);
  });

  // The other direction of the fold, and the reason it is not `foldCharacterName`.
  // That one deletes marks, folds alef maksura onto yeh, and is right to: it
  // asks "are these two spellings one person's name" of two names against a
  // list of at most ten. This asks "does this document still contain this exact
  // name" of a twelve-thousand-character prompt, where every pair those steps
  // merge gets a document's worth of chances to collide — and a collision is a
  // rewrite that worked, discarded, with two paid text calls spent and the
  // caller left holding the refusal it already had.
  const distinctWords: [label: string, rewritten: string, removed: string][] = [
    // «على» is "on", one of the commonest words in Arabic. «علی» is Ali.
    ["an Arabic preposition that is not a Persian name", "الطفل يقف على السطح في الليل.", "علی"],
    // Vietnamese tone marks tell six words apart; "ma" is a ghost, "Mã" a name.
    ["a Vietnamese word that differs only by its tone mark", "Một con ma nhỏ bay qua mái nhà.", "Mã"],
    // Arabic and Hebrew children's books are the vocalized ones.
    ["a pointed Hebrew word an unpointed name is not", "יֶלֶד רָכוּב עַל שָׁלוֹם בַּגַּג.", "שלום"],
    ["a Latin word an accented name is not", "A boy named Jose waves from the roof.", "José"]
  ];

  it.each(distinctWords)("keeps %s out of the leak set", async (_label, rewritten, removed) => {
    await expect(rewriting({ prompt: rewritten, replaced: [removed] }, `${removed} on a roof.`)).resolves.toEqual({
      outcome: "rewritten",
      prompt: rewritten,
      replaced: [removed]
    });
  });

  it("folds the hyphen's spellings and not the dash family, in both rules at once", async () => {
    // One character list backs the fold and the word-joining test, so a
    // spelling cannot join a compound in one and miss a needle in the other.
    // The dashes proper stay out: an en dash is punctuation between two words,
    // so the "Luna" in "the Bear–Luna treaty" is standing on its own.
    const joined = "A rabbit called Bear\uFF0DLuna naps under the porch.";
    await expect(rewriting({ prompt: joined, replaced: ["Luna"] }, "Luna naps.")).resolves.toEqual({
      outcome: "rewritten",
      prompt: joined,
      replaced: ["Luna"]
    });

    const dashed = await rewriting({ prompt: "The Bear\u2013Luna treaty is signed.", replaced: ["Luna"] }, "Luna naps.");
    expect(leakedNames(dashed)).toEqual(["Luna"]);
  });

  it("still ends no word on a joiner, so «علی‌رضا» is somebody else", async () => {
    // Stripping the invisible marks is what catches a joiner dropped *inside* a
    // name, and it must not cost the rule that a joiner *continues* one: the
    // letters it sat between are still adjacent afterwards, so the boundary
    // test refuses the match exactly as it did.
    const rewritten = "کودکی نقاب‌دار به نام علی‌رضا روی پشت‌بام ایستاده است.";
    await expect(rewriting({ prompt: rewritten, replaced: ["علی"] }, "علی روی پشت‌بام.")).resolves.toEqual({
      outcome: "rewritten",
      prompt: rewritten,
      replaced: ["علی"]
    });
  });

  it("reads a reply built entirely of what the fold rewrites in bounded time", async () => {
    // The fold is five character-class replaces and a whitespace collapse, all
    // linear — but a sibling in this feature was found at 7.2 s on 18
    // separators, so a new pattern is measured rather than reasoned about. The
    // inputs are the schema's own ceiling made of nothing but characters every
    // step touches, plus the matcher's worst case: twenty maximal needles that
    // match at every offset of a maximal reply and never close a token. That
    // last one measures 26 ms, and this is the worker's only thread inside a
    // generate-image job, which is how BullMQ comes to call one stalled.
    const shapes: [rewritten: string, replaced: string[]][] = [
      ["-\u2011\u2019 \u200C".repeat(2_400), ["Spider-Man"]],
      ["ي\u0660\u06F9\u200C ".repeat(2_400), ["علی"]],
      ["a".repeat(18_000), Array.from({ length: 20 }, () => "a".repeat(120))],
      ["a".repeat(18_000), Array.from({ length: 20 }, (_entry, index) => `${"a".repeat(119)}${index}`)]
    ];

    for (const [rewritten, replaced] of shapes) {
      const started = performance.now();
      await rewriting({ prompt: rewritten, replaced }, "Spider-Man on a rooftop.");
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});

describe("the output budget", () => {
  const budgetFor = async (prompt: string) => {
    const rewritten = `${prompt} (rewritten)`;
    const generateJson = adapterAnswering({ prompt: rewritten, changed: true, replaced: [] });

    const result = await rewriteImagePromptForCopyright({
      textModel: textModel(generateJson as unknown as TextModelAdapter["generateJson"]),
      prompt,
      reason: "IMAGE_RECITATION"
    });

    // The budget is only worth reading off a call whose reply was *taken*. A
    // reply the schema refuses records its `maxTokens` all the same, so
    // measuring the mock and dropping the outcome reported the ceiling of a
    // rewrite that had already failed — which is exactly what these two cases
    // were doing at the top of the range, green, while the reply they measured
    // was schema-rejected and the outcome was `failed`.
    expect(result).toEqual({ outcome: "rewritten", prompt: rewritten, replaced: [] });
    expect(generateJson).toHaveBeenCalledTimes(1);

    const call = generateJson.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("the rewrite made no model call");
    }
    return call.maxTokens ?? 0;
  };

  it("holds the whole reply back when the prompt is not in Latin script", async () => {
    // The reply has to contain the prompt back plus the JSON around it, and a
    // Persian or Japanese character is close to a token of its own — so the
    // budget cannot be counted the way an English prompt's is. Same length,
    // three scripts, and the two dense ones must be given room for a character
    // per token rather than the two an English prompt is measured at.
    const latin = "A masked hero swings between the towers over the city at night, in warm colour. ".repeat(20);
    const persian = "قهرمانی نقاب‌دار شب هنگام میان برج‌های شهر در نور گرم پرواز می‌کند و کودکان او را می‌بینند. ".repeat(20);
    const japanese = "仮面のヒーローが夜の街のビルの間を暖かい光の中で飛び回っている場面を描いてください。".repeat(20);

    const persianBudget = await budgetFor(persian);
    const japaneseBudget = await budgetFor(japanese);

    expect(persianBudget).toBeGreaterThanOrEqual([...persian].length);
    expect(japaneseBudget).toBeGreaterThanOrEqual([...japanese].length);
    // The old rule was ceil(chars / 2) for every script alike, which is what
    // truncated these two.
    expect(persianBudget).toBeGreaterThan(Math.ceil(persian.length / 2) * 1.5);
    expect(japaneseBudget).toBeGreaterThan(Math.ceil(japanese.length / 2) * 1.5);
    // An English prompt keeps at least the room it always had.
    expect(await budgetFor(latin)).toBeGreaterThanOrEqual(Math.ceil(latin.length / 2));
  });

  it("is a fuse, so it stays between a floor and a ceiling", async () => {
    expect(await budgetFor("Spider-Man on a rooftop.")).toBe(800);
    // The ceiling is the echo's, so the reply's is that plus the JSON
    // allowance. The echo is the *rewritten* prompt, half again as long as the
    // one that went in, so the longest prompt the gate admits still buys the
    // whole ceiling — a longer one than this is declined without a model call
    // at all.
    expect(await budgetFor("字".repeat(12_000))).toBe(18_400);
  });

  it("never lets the ceiling clip the JSON allowance the echo was sized with", async () => {
    // A ceiling over the *sum* is the echo's own ceiling minus whatever the
    // scaffolding asked for, so the last 400 tokens of the supported range were
    // spent on the prompt and the JSON around it got the remainder: 399 tokens
    // at an 11,601-token echo, and exactly zero at the 12,000-character cap. A
    // reply that stops mid-string is an unterminated one, not a short one — it
    // fails to parse, the repair attempt runs on the same budget and fails the
    // same way, and the one paid rewrite is gone with the picture.
    //
    // Every character here is a token of its own, so the echo the budget is
    // built from is the length itself plus the growth allowance the rewrite is
    // sized for. Only a script that writes no spaces reaches this: an ASCII
    // space counts Latin, which is why the same 12,000 characters are 10,577
    // echo tokens in Persian and 11,690 in Japanese.
    for (const denseChars of [11_600, 11_601, 11_900, 12_000]) {
      const budget = await budgetFor("字".repeat(denseChars));
      const rewrittenEcho = Math.min(18_000, Math.ceil(denseChars * 1.5));
      expect(budget - rewrittenEcho).toBeGreaterThanOrEqual(400);
    }
  });
});
