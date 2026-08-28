import { describe, expect, it } from "vitest";
import { FallbackImageAdapter } from "./imageFallback.js";
import { ImageContentRefusedError } from "./imageRefusal.js";
import { imageRefusalCategory } from "./imageRefusalVerdict.js";
import { ProviderHttpError } from "./retry.js";
import type { ImageAdapter } from "./types.js";

const refusingAdapter = (details: { provider: string; model: string; reason: string }): ImageAdapter => ({
  generateImage: async () => {
    throw new ImageContentRefusedError(details);
  }
});

const brokenAdapter = (error: Error): ImageAdapter => ({
  generateImage: async () => {
    throw error;
  }
});

const fallbackError = async (primary: ImageAdapter, fallback: ImageAdapter): Promise<unknown> => {
  const adapter = new FallbackImageAdapter({
    primary: { provider: "gemini", model: "gemini-2.5-flash-image", adapter: primary },
    fallback: { provider: "alibaba", model: "qwen-image-2.0", adapter: fallback }
  });
  return adapter.generateImage({ prompt: "Illustrate Spiderman." }).catch((error: unknown) => error);
};

describe("imageRefusalCategory", () => {
  const refusal = (reason: string, detail?: string) =>
    new ImageContentRefusedError({
      provider: "gemini",
      model: "gemini-2.5-flash-image",
      reason,
      ...(detail ? { detail } : {})
    });

  it("needs positive evidence, so a bare safety label is not a copyright block", () => {
    // Gemini puts SAFETY and PROHIBITED_CONTENT on a character likeness as
    // readily as on anything else, so they prove nothing either way.
    expect(imageRefusalCategory(refusal("IMAGE_SAFETY"))).toBe("other");
    expect(imageRefusalCategory(refusal("PROHIBITED_CONTENT"))).toBe("other");
    expect(imageRefusalCategory(refusal("NO_IMAGE", "I'd rather not draw that."))).toBe("other");
  });

  it("recognises the words a filter uses when it means intellectual property", () => {
    expect(imageRefusalCategory(refusal("IMAGE_RECITATION"))).toBe("copyright");
    expect(imageRefusalCategory(refusal("NO_IMAGE", "That is a copyrighted character."))).toBe("copyright");
    expect(
      imageRefusalCategory(refusal("DataInspectionFailed", "Output data is suspected of being involved in IP infringement"))
    ).toBe("copyright");
  });

  it("reads the evidence across both attempts of a fallback failure", async () => {
    // The refusal that ended the book: Gemini gave a bare safety label and only
    // Qwen said what it was actually objecting to.
    const error = await fallbackError(
      refusingAdapter({ provider: "gemini", model: "gemini-2.5-flash-image", reason: "IMAGE_SAFETY" }),
      brokenAdapter(
        new ImageContentRefusedError({
          provider: "alibaba",
          model: "qwen-image-2.0",
          reason: "DataInspectionFailed",
          detail: "Output data is suspected of being involved in IP infringement"
        })
      )
    );

    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("still rewrites a copyright refusal whose prose happens to describe a children's book", () => {
    // The prose a native image model returns in a picture's place restates the
    // request, and nearly every book here is a children's book — so a veto read
    // off the scene rather than off the filter turned the exact case this retry
    // was built for into a no-op, and a silent one: the gate short-circuits
    // before `copyright_rewrite_declined` reaches the run log.
    expect(
      imageRefusalCategory(refusal("IMAGE_RECITATION", "I can't create an image of Spider-Man teaching a child to read."))
    ).toBe("copyright");
    expect(
      imageRefusalCategory(
        refusal("NO_IMAGE", "I'm unable to draw copyrighted characters like Elsa alongside the children in this scene.")
      )
    ).toBe("copyright");
    expect(
      imageRefusalCategory(
        refusal(
          "DataInspectionFailed",
          "Output data is suspected of being involved in IP infringement: a minor character from a film."
        )
      )
    ).toBe("copyright");
  });

  it("never calls a child-safety or sexual-content block rewritable, whatever else it says", () => {
    // The veto outranks the copyright evidence standing beside it, so each of
    // these carries both. Nothing may retry its way past them — and each one
    // names the filter's own category rather than the scene.
    expect(imageRefusalCategory(refusal("PROHIBITED_CONTENT", "Sexual content involving a copyrighted character."))).toBe(
      "other"
    );
    expect(imageRefusalCategory(refusal("IMAGE_RECITATION", "This request violates our child safety policy."))).toBe("other");
    expect(
      imageRefusalCategory(refusal("RECITATION", "I won't generate images that sexualize minors, copyrighted or not."))
    ).toBe("other");
    expect(imageRefusalCategory(refusal("IMAGE_RECITATION", "The prompt depicts nudity."))).toBe("other");
    expect(imageRefusalCategory(refusal("RECITATION", "This would exploit a child."))).toBe("other");
  });

  /**
   * The ambiguous half of the veto's vocabulary, one row at a time.
   *
   * Every string here is a plain copyright refusal that happens to use the
   * words an IP filter uses about a *work*: it would "exploit" a character,
   * it is an "abuse" of a mark, the mascot is an "endangered" species, the
   * change is a "minor" one. Pairing a protected-person word with a harm word
   * inside one sentence read all of them as child safety — and since the
   * person word is "child" in a product that makes children's books, the
   * feature went quiet for precisely the case it was built for. The reason
   * carries no evidence on purpose: the prose is the only thing under test.
   */
  it.each([
    "I can't create an image of Spider-Man teaching a child to read, as this would exploit a copyrighted character.",
    "Using her likeness in a children's book would exploit Disney's trademark.",
    "Commercial exploitation of a trademarked children's franchise is not something I can help with.",
    "This is a minor variation on a copyrighted design and would still exploit the original work.",
    "Output data is suspected of being involved in IP infringement: exploitation of a registered children's character.",
    "I won't draw that: it would be an abuse of the Pokemon trademark in a book for children.",
    "That request infringes copyright. Even a minor change would not avoid exploiting the protected design.",
    "I can't depict this endangered-species mascot with children, it is a trademarked character.",
    "The studio's exploitation rights over the children's franchise are exclusive, so I can't reproduce this copyrighted character.",
    "A minor character from the film appears, so the output is suspected of IP infringement."
  ])("still rewrites a copyright refusal that talks about exploiting a work: %s", (detail) => {
    expect(imageRefusalCategory(refusal("NO_IMAGE", detail))).toBe("copyright");
  });

  /**
   * The other direction, which is the one that must never move.
   *
   * Each of these carries copyright evidence too — most of them in the reason
   * — so the veto is what decides them, and each pairs one of the ambiguous
   * words above with the vocabulary of a *person* being harmed. That pairing
   * is the whole test: `exploit` is IP English until it governs a child.
   */
  it.each([
    "This would exploit a child.",
    "The abuse of a child alongside a trademarked mascot is never permitted.",
    "I won't draw a copyrighted character exploiting children.",
    "Prompts that endanger children are refused, trademark or not.",
    "This trademarked scene shows a minor being abused.",
    "The exploitation of minors is prohibited even in a parody of a copyrighted film.",
    "The prompt depicts an underage character being exploited.",
    "Blocked for child endangerment; the character is also copyrighted.",
    "Content depicting the sexual exploitation of children is prohibited.",
    "The request was blocked for child safety.",
    "Detected child_sexual_abuse_material in a prompt about a copyrighted work.",
    "Requests involving nudity of a minor are refused.",
    "I won't generate images that sexualize minors, copyrighted or not."
  ])("never rewrites a child-safety refusal, however it is phrased: %s", (detail) => {
    expect(imageRefusalCategory(refusal("IMAGE_RECITATION", detail))).toBe("other");
  });

  /**
   * The same adjective, one inflection over.
   *
   * `minor` earned its adjective reading from a list of the singular nouns it
   * could be modifying, and the list asked for a word boundary immediately
   * after each — so `"a minor variation"` was the adjective and `"minor
   * variations"` was a child, and every plural of every entry escaped the same
   * way. What escaped with them is the veto firing on ordinary
   * intellectual-property English: the category goes to `other`, no rewrite is
   * offered, and the only trace is one `copyright_rewrite_not_offered` line
   * that does not say the veto is why. The test is written over inflections and
   * over nouns the list never had, because a list of nouns is what failed.
   */
  it.each([
    "This would exploit minor variations of a copyrighted design.",
    "This would exploit minor changes of a copyrighted design.",
    "This would exploit minor details of a copyrighted design.",
    "This would exploit minor differences from a copyrighted design.",
    "This would exploit minor versions of a copyrighted design.",
    "This would exploit minor references to a copyrighted design.",
    "This would exploit minor tweaks of a copyrighted design.",
    "This would exploit minor edits of a copyrighted design.",
    "This would exploit minor revisions of a copyrighted design.",
    "This would exploit minor issues of a copyrighted design.",
    "This would exploit minor points of a copyrighted design.",
    "This would exploit minor deviations of a copyrighted design.",
    "This would exploit minor elements of a copyrighted design.",
    "This would exploit minor roles in a copyrighted film.",
    "This would exploit minor parts of a copyrighted design.",
    // Nouns no list had: the head-noun test needs neither of them named.
    "This would exploit minor likenesses of a copyrighted design.",
    "This would exploit minor stylings of a copyrighted design.",
    "A minor styling change would still exploit the copyrighted mascot.",
    // The singular the list did cover, so the fix is measured against it.
    "This would exploit minor variation of a copyrighted design.",
    "This request would exploit a minor character from the copyrighted film."
  ])("still rewrites a copyright refusal whose 'minor' is the adjective: %s", (detail) => {
    expect(imageRefusalCategory(refusal("NO_IMAGE", detail))).toBe("copyright");
  });

  /**
   * And the direction that must not move with it: `minor` heading its own noun
   * phrase is the person, whatever stands after it. Each of these carries
   * copyright evidence, so the veto is the only thing that can decide it.
   */
  it.each([
    "This would exploit a minor.",
    "This would exploit a minor, and the design is copyrighted.",
    "This depicts the abuse of a minor and a copyrighted character.",
    "A minor who is exploited beside a copyrighted character.",
    "The safety of a minor is at stake; the character is also copyrighted.",
    "Endangerment of a minor in a copyrighted setting.",
    "This trademarked scene shows a minor being abused.",
    "The abuse of a minor girl beside a trademarked mascot is never permitted."
  ])("still vetoes where 'minor' heads its own noun phrase: %s", (detail) => {
    expect(imageRefusalCategory(refusal("NO_IMAGE", detail))).toBe("other");
  });

  /**
   * The compound label reading the scene, which is the same bug the
   * `/child|minor/` test above was, one pattern further in.
   *
   * `child safety` and `child protection` are the filter's category names *and*
   * an ordinary children's-book subject — a crossing lesson, a poster. Read
   * bare over prose, they vetoed a refusal that was purely about a franchise
   * name: the category went to `other`, no rewrite was offered, and the only
   * trace was one `copyright_rewrite_not_offered` line that does not say the
   * veto is why. The `codes` half of the same rule would not have vetoed any of
   * these, which is the tell.
   */
  it.each([
    "I can't create an image of Bluey teaching child safety at a crossing, as Bluey is a copyrighted character.",
    "I can't create an image for a child protection poster featuring the trademarked Bluey.",
    "I can't create an image of children learning child safety beside a copyrighted mascot.",
    "The child safety lesson poster reproduces a copyrighted character."
  ])("still rewrites a copyright refusal whose scene is about child safety: %s", (detail) => {
    expect(imageRefusalCategory(refusal("NO_IMAGE", detail))).toBe("copyright");
  });

  /**
   * And the veto that must not move with it: the same words where the filter's
   * own statement is what put them there, or in the code spelling no sentence
   * writes. Each carries copyright evidence too, so the veto is the only thing
   * that can decide it.
   */
  it.each([
    "The request was blocked for child safety.",
    "This request violates our child safety policy.",
    "Refused: child safety. The character is also copyrighted.",
    "I'm unable to generate that image due to child safety concerns; the mascot is trademarked.",
    "Blocked: child_safety in a prompt about a copyrighted work.",
    "Our content policy prohibits this; child protection applies to the copyrighted mascot.",
    "Child safety guidelines forbid this, copyrighted or not.",
    "Detected child_sexual_abuse_material in a prompt about a copyrighted work."
  ])("still vetoes the same label where the filter's own statement frames it: %s", (detail) => {
    expect(imageRefusalCategory(refusal("IMAGE_RECITATION", detail))).toBe("other");
  });

  /**
   * The permissive half of the same asymmetry: a bare `/copyright/i` over prose
   * that is mostly the request read back.
   *
   * A book asking for "in the style of a copyright-free vintage travel poster"
   * is refused for `IMAGE_SAFETY`, the restatement lands in `prose` — twice,
   * since the error's own message embeds `detail` — and the word matches the
   * scene. That buys a full paid text rewrite per refused illustration for a
   * block that was never about IP. {@link CLEARED_CONTENT_EVIDENCE} already
   * knew every one of these phrasings; this test simply never had it.
   */
  it.each([
    "I can't create an image in the style of a copyright-free vintage travel poster.",
    "I can't create an image of a royalty-free, copyright-cleared stock character.",
    "I can't draw that trademark-free logo wall.",
    "I created an original character so there is no copyright concern.",
    "The artwork is entirely original, so copyright is not a concern."
  ])("does not buy a rewrite for prose that clears the subject rather than objecting: %s", (detail) => {
    expect(imageRefusalCategory(refusal("IMAGE_SAFETY", detail))).toBe("other");
  });

  /**
   * And the direction that costs the picture rather than a call, so it is the
   * one that must not move: the clearance is read **per sentence**, and never
   * over a code at all.
   */
  it("still buys a rewrite where the same prose objects, and over a code regardless", () => {
    expect(imageRefusalCategory(refusal("IMAGE_SAFETY", "I can't create an image of Spider-Man; it would infringe copyright."))).toBe(
      "copyright"
    );
    // One sentence objects and the next one clears: a whole-string veto would
    // have discounted both.
    expect(
      imageRefusalCategory(refusal("IMAGE_SAFETY", "The image would infringe copyright. Copyright-free art is fine."))
    ).toBe("copyright");
    // A code is the filter describing itself, so no clearance in the prose
    // beside it may discount one.
    expect(imageRefusalCategory(refusal("IMAGE_RECITATION", "A copyright-free vintage travel poster."))).toBe("copyright");
  });

  /**
   * The same clearance vocabulary read over the wrong speaker.
   *
   * A refusal states what it will not do in the words a clearance uses about
   * what a picture lacks, so the one sentence carrying the objection was
   * discounted by its own verb: `avoid\w*` threw away "I must avoid generating
   * content that infringes on intellectual property", `without` threw away "I
   * can't create this image without infringing copyright", and a bare `not`
   * before a presence verb threw away "I will not depict any copyrighted
   * character". Every one of those is a plain IP refusal, and every one of them
   * ended at `other` — so `CopyrightSafeRetryImageAdapter` rethrew and
   * `renderCharacterReferenceSheets` wrote the refusal onto
   * `PlanVersion.characterReferenceRefusals`, where nothing revisits it for the
   * life of the plan version. The reason carries no evidence on purpose: the
   * prose is the only thing under test.
   */
  it.each([
    // `avoid`, under each prospective modal that takes the bare stem.
    "I must avoid generating content that infringes on intellectual property.",
    "I will avoid depicting any copyrighted characters in this image.",
    "I'll avoid using the trademarked logo in this illustration.",
    "I have to avoid reproducing that copyrighted design.",
    // `without` over the offence rather than over a thing.
    "I can't create this image without infringing copyright.",
    "This cannot be drawn without violating copyright.",
    "I am unable to render it without breaching the copyright on that work.",
    // A presence verb negated by a modal rather than by `do`-support.
    "I will not depict any copyrighted character.",
    "I will not reproduce a copyrighted design.",
    "I must not use the trademarked logo you described.",
    // The control the reviewer's probes were read against, which never moved.
    "I can't create an image of Spider-Man, a copyrighted character."
  ])("still buys a rewrite for a refusal that says what it will not do: %s", (detail) => {
    expect(imageRefusalCategory(refusal("IMAGE_SAFETY", detail))).toBe("copyright");
  });

  /**
   * And the drawn picture's own narration, one surviving entry at a time.
   *
   * This is the direction the clearance veto exists for, and the direction that
   * pays for the narrowing above: each of these is a turn that drew something
   * and lost its bytes, describing its own care in the filter's vocabulary. A
   * rewrite bought here is a paid text call for a block that was never about a
   * name.
   */
  it.each([
    // no
    "The illustration contains no copyrighted characters.",
    // none
    "None of the elements in this picture are copyrighted.",
    // nothing
    "There is nothing copyrighted in this illustration.",
    // without, over a thing
    "The scene was drawn without any trademarked logos.",
    // free of / free from
    "The final artwork is free of any copyrighted material.",
    "The composition is free from trademarked elements.",
    // devoid of
    "The composition is devoid of trademarked elements.",
    // clear of / cleared of
    "The image was cleared of trademark concerns before rendering.",
    // avoids / avoided
    "The artwork avoids any copyrighted character.",
    "I avoided any trademarked logos in the background.",
    // a presence verb under do-support, the copula and the perfect
    "The design is original and does not infringe any existing work.",
    "The picture doesn't contain any copyrighted characters.",
    "The final sheet is not depicting a trademarked mascot.",
    "The render has not reproduced any copyrighted artwork."
  ])("still refuses a rewrite to a drawn picture narrating its own compliance: %s", (detail) => {
    expect(imageRefusalCategory(refusal("IMAGE_SAFETY", detail))).toBe("other");
  });

  /**
   * The residual, pinned so it is found rather than discovered.
   *
   * The quantifier entries keep their bare spelling deliberately: a refusal
   * reaches them only by wrapping a noun phrase in a permission predicate, a
   * deontic copula or a negation of the clearance itself, and each of those
   * needs a modal or a second negation to identify. Narrowing them is the trade
   * `avoid` already lost — they carry the archetypal clearances above, and one
   * dropped here is a picture-less blip typed as a settled refusal on the other
   * side of the module pair, which no rewrite can recover. None of these is a
   * spoken decline either, so a refusal behind one arrives on a provider code
   * or not at all.
   */
  it.each([
    "This request is blocked: no copyrighted characters may be generated.",
    "I cannot proceed; nothing infringing copyright may be produced.",
    "The prompt must be devoid of copyrighted characters; this one is not.",
    "This prompt is not free of copyrighted material, so it is blocked."
  ])("does not read a quantifier wrapped in a modal as an objection: %s", (detail) => {
    expect(imageRefusalCategory(refusal("IMAGE_SAFETY", detail))).toBe("other");
  });

  it("takes the veto from the provider's own code, whatever the prose says", () => {
    // A code is the filter describing itself, so a bare word in one is evidence
    // the same word in a sentence is not.
    expect(imageRefusalCategory(refusal("CHILD_SAFETY", "That character is trademarked."))).toBe("other");
    expect(imageRefusalCategory(refusal("SEXUALLY_EXPLICIT", "Recitation of a protected work."))).toBe("other");
  });

  it("vetoes across both attempts of a fallback, from whichever one named the category", async () => {
    const error = await fallbackError(
      refusingAdapter({ provider: "gemini", model: "gemini-2.5-flash-image", reason: "IMAGE_RECITATION" }),
      brokenAdapter(
        new ImageContentRefusedError({
          provider: "alibaba",
          model: "qwen-image-2.0",
          reason: "DataInspectionFailed",
          detail: "The request was blocked for child safety."
        })
      )
    );

    expect(imageRefusalCategory(error)).toBe("other");
  });

  it("is not a category for anything that is not a refusal at all", () => {
    expect(imageRefusalCategory(new ProviderHttpError("upstream is down", { status: 503 }))).toBe("other");
    expect(imageRefusalCategory(new Error("fetch failed"))).toBe("other");
  });
});
