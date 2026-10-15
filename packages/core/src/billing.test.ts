import { describe, expect, it } from "vitest";
import {
  DEFAULT_BILLING_PRODUCTS,
  PROVIDER_COST_ASSUMPTIONS_USD,
  SUBSCRIPTION_INTRO_OFFERS,
  buildMarginEstimate,
  creditCostForOperation,
  estimateAudiobookCreditCost,
  narrationWordCount,
  estimateBookReplanCreditCost,
  estimateFullBookCreditCost,
  estimateInteriorImageCount,
  estimateProviderCostForProject,
  providerCostAssumptionsForInput
} from "./billing.js";
import { DEFAULT_CREDIT_COSTS } from "./creditPricing.js";
import { createProjectSchema } from "./schemas/book.js";

/** What a credit brings in after Google Play's 15%. */
const creditUsd = (priceMicros: number, credits: number) => (priceMicros / 1_000_000) * 0.85 / credits;

/** The Max plan's rate: $199.99 for 80,000 credits, the floor every per-page price rests on. */
const MAX_PLAN_CREDIT_USD = creditUsd(199_990_000, 80_000);

/**
 * The least a credit is ever sold for — every product and every intro offer.
 * The margin tests price against this rather than Max's rate by name, because
 * the intro offer used to grant a whole month for $9.99 and sold credits a
 * third under the floor while every test here still said Max was the cheapest.
 */
const CHEAPEST_CREDIT_USD = Math.min(
  ...DEFAULT_BILLING_PRODUCTS.map((product) => creditUsd(product.priceMicros, product.creditAmount)),
  ...SUBSCRIPTION_INTRO_OFFERS.map((offer) => creditUsd(offer.priceMicros, offer.creditAmount))
);

describe("the cheapest credit", () => {
  it("is never sold under the Max plan's floor, intro offers included, beyond rounding the credit count", () => {
    // 4,000 credits for the $9.99 intro is $0.0021229 against Max's $0.0021249.
    expect(CHEAPEST_CREDIT_USD).toBeGreaterThanOrEqual(MAX_PLAN_CREDIT_USD * 0.999);
    for (const offer of SUBSCRIPTION_INTRO_OFFERS) {
      const plan = DEFAULT_BILLING_PRODUCTS.find((product) => product.sku === offer.sku);
      expect(plan).toBeDefined();
      // An intro grants less than the plan it discounts, never the whole allowance.
      expect(offer.creditAmount).toBeLessThan(plan!.creditAmount);
      expect(creditUsd(offer.priceMicros, offer.creditAmount)).toBeGreaterThanOrEqual(MAX_PLAN_CREDIT_USD * 0.999);
    }
  });
});

describe("billing credit assumptions", () => {
  it("itemizes a standard workbook package including its initial cover", () => {
    const input = createProjectSchema.parse({
      prompt: "Create a practical workbook about onboarding new managers.",
      category: "EDUCATION",
      subcategory: "Workbook or Study Guide",
      targetPages: 28,
      complexity: 5,
      temperature: 0.65,
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "minimal",
        finalReview: true,
        toneProfile: "neutral"
      }
    });

    const estimate = estimateFullBookCreditCost(input);

    // No export unlock: the finished book downloads free (2026-10-15).
    expect(estimate.totalCredits).toBe(889);
    expect(estimate.lineItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "FULL_BOOK_GENERATION", credits: 574 }),
        expect.objectContaining({ code: "IMAGE_GENERATION", quantity: 6, credits: 270 }),
        expect.objectContaining({
          code: "IMAGE_GENERATION",
          label: "Cover image generation",
          quantity: 1,
          credits: DEFAULT_CREDIT_COSTS.imageGeneration
        })
      ])
    );
    expect(estimate.lineItems.map((line) => line.code)).not.toContain("EXPORT_UNLOCK");
  });

  it("prices an initial cover as one image generation, never as a cover regeneration", () => {
    const input = createProjectSchema.parse({
      prompt: "Create a concise guide with a generated cover.",
      category: "BUSINESS",
      targetPages: 8,
      mediaSettings: {
        fullIllustrations: false,
        includeCover: false
      }
    });
    const pricing = {
      ...DEFAULT_CREDIT_COSTS,
      imageGeneration: 37,
      coverRegeneration: 999
    };
    const withoutCover = estimateFullBookCreditCost(input, pricing);
    const withCover = estimateFullBookCreditCost(
      { ...input, mediaSettings: { ...input.mediaSettings, includeCover: true } },
      pricing
    );

    expect(withCover.totalCredits - withoutCover.totalCredits).toBe(37);
    expect(withCover.assumptions).toMatchObject({ includesCover: true, estimatedInteriorImages: 0 });
    expect(withoutCover.assumptions.includesCover).toBe(false);
    expect(withCover.lineItems).toContainEqual(
      expect.objectContaining({
        code: "IMAGE_GENERATION",
        label: "Cover image generation",
        quantity: 1,
        unitCredits: 37,
        credits: 37
      })
    );
    expect(withoutCover.lineItems).toContainEqual(
      expect.objectContaining({ label: "Cover image generation", quantity: 0, credits: 0 })
    );
    expect(withCover.lineItems.some((item) => item.code === "COVER_REGENERATION")).toBe(false);
  });

  it("charges for the cover only when a model draws it", () => {
    const base = {
      prompt: "Create a concise guide with a cover.",
      category: "BUSINESS",
      targetPages: 8,
      mediaSettings: { fullIllustrations: false }
    };
    const quote = (mediaSettings: Record<string, unknown>) =>
      estimateFullBookCreditCost(
        createProjectSchema.parse({ ...base, mediaSettings: { ...base.mediaSettings, ...mediaSettings } })
      );

    const ai = quote({ includeCover: true, coverArtSource: "ai" });
    const designed = quote({ includeCover: false, coverArtSource: "design" });
    const none = quote({ includeCover: false, coverArtSource: "none" });

    expect(ai.totalCredits - designed.totalCredits).toBe(DEFAULT_CREDIT_COSTS.imageGeneration);
    // A bundled design is drawn from the catalog, so it costs the same as no
    // cover at all even though the book ends up with one.
    expect(designed.totalCredits).toBe(none.totalCredits);
    expect(designed.assumptions.includesCover).toBe(false);
    expect(ai.assumptions.includesCover).toBe(true);
  });

  it("keeps quoting projects written before coverArtSource existed", () => {
    // The legacy flag is the only thing older rows carry, and `includeCover:
    // false` now means a designed cover — the quote must not move for either.
    const legacy = (includeCover: boolean) =>
      estimateFullBookCreditCost(
        createProjectSchema.parse({
          prompt: "Create a concise guide with a cover.",
          category: "BUSINESS",
          targetPages: 8,
          mediaSettings: { fullIllustrations: false, includeCover }
        })
      );

    expect(legacy(true).assumptions.includesCover).toBe(true);
    expect(legacy(false).assumptions.includesCover).toBe(false);
    expect(legacy(true).totalCredits - legacy(false).totalCredits).toBe(DEFAULT_CREDIT_COSTS.imageGeneration);
  });

  it("adds premium review credits for the premium tier, not for an inert best-of knob or the app's echo", () => {
    const inputWith = (mediaExtras: Record<string, unknown>) =>
      createProjectSchema.parse({
        prompt: "Create a premium guide about pricing consulting retainers.",
        category: "BUSINESS",
        subcategory: "Lead Magnet Ebook",
        targetPages: 24,
        complexity: 6,
        temperature: 0.55,
        mediaSettings: {
          fullIllustrations: true,
          illustrationCadence: "template-driven",
          includeCover: true,
          coverTemplate: "business",
          finalReview: true,
          toneProfile: "confident",
          ...mediaExtras
        }
      });

    const premium = estimateFullBookCreditCost(inputWith({ modelTier: "premium" }));
    expect(premium.assumptions.includesPremiumReview).toBe(true);
    const ultra = estimateFullBookCreditCost(inputWith({ modelTier: "ultra" }));
    expect(ultra.assumptions.includesPremiumReview).toBe(true);
    expect(premium.lineItems).toContainEqual(
      expect.objectContaining({ code: "PREMIUM_REVIEW", credits: DEFAULT_CREDIT_COSTS.premiumReview })
    );

    // `draftCandidates` alone no longer prices premium review: mobile lengths
    // route to strategies that never read the knob, so it charged for nothing.
    const knobOnly = estimateFullBookCreditCost(inputWith({ draftCandidates: 2 }));
    expect(knobOnly.assumptions.includesPremiumReview).toBe(false);

    // Nor does the app's own metadata echo. It is written only by the mobile
    // client, so pricing off it let a project that set the tier directly run
    // premium models for free — and a row written before tier routing carries
    // the echo while running the legacy model, which is balanced work.
    const echoOnly = estimateFullBookCreditCost(inputWith({ mobile: { qualityPreset: "premium" } }));
    expect(echoOnly.assumptions.includesPremiumReview).toBe(false);
    expect(echoOnly.assumptions.modelTier).toBe("balanced");
  });

  it("prices a book at its own tier's rates", () => {
    const inputForTier = (modelTier?: "fast" | "balanced" | "premium" | "ultra") =>
      createProjectSchema.parse({
        prompt: "Create a practical guide about onboarding new managers.",
        category: "BUSINESS",
        subcategory: "Lead Magnet Ebook",
        targetPages: 18,
        mediaSettings: {
          fullIllustrations: true,
          illustrationCadence: "template-driven",
          includeCover: true,
          coverTemplate: "business",
          finalReview: true,
          toneProfile: "confident",
          ...(modelTier ? { modelTier } : {})
        }
      });

    // An 18-page lead magnet is illustrated on pages 1, 8 and 16, plus a
    // cover — four image units. Spelled out rather than recomputed from the
    // price table: the app mirrors this formula and there is no server quote
    // route to fall back on, so a change here has to be a visible change here.
    // No tier carries an export unlock: the finished book downloads free.
    expect(estimateFullBookCreditCost(inputForTier("fast")).totalCredits).toBe(220 + 18 * 5 + 4 * 45);
    expect(estimateFullBookCreditCost(inputForTier("balanced")).totalCredits).toBe(350 + 18 * 8 + 4 * 45);
    expect(estimateFullBookCreditCost(inputForTier("premium")).totalCredits).toBe(
      500 + 18 * 30 + 4 * 85 + DEFAULT_CREDIT_COSTS.premiumReview
    );
    expect(estimateFullBookCreditCost(inputForTier("ultra")).totalCredits).toBe(
      650 + 18 * 130 + 4 * 85 + DEFAULT_CREDIT_COSTS.premiumReview
    );

    // A book from before tiers existed pays the balanced rates, because that
    // is the work it runs and what the unsuffixed keys have always meant.
    expect(estimateFullBookCreditCost(inputForTier()).totalCredits).toBe(
      estimateFullBookCreditCost(inputForTier("balanced")).totalCredits
    );
    expect(estimateFullBookCreditCost(inputForTier()).assumptions.modelTier).toBe("balanced");
  });

  it("keeps the tier price ladder in the same order as what the tiers cost to run", () => {
    const inputForTier = (modelTier: "fast" | "balanced" | "premium" | "ultra") =>
      createProjectSchema.parse({
        prompt: "Create a practical guide about onboarding new managers.",
        category: "EDUCATION",
        subcategory: "Workbook or Study Guide",
        targetPages: 28,
        mediaSettings: {
          fullIllustrations: true,
          illustrationCadence: "template-driven",
          includeCover: true,
          coverTemplate: "minimal",
          finalReview: true,
          toneProfile: "neutral",
          modelTier
        }
      });

    const credits = (tier: "fast" | "balanced" | "premium" | "ultra") => estimateFullBookCreditCost(inputForTier(tier)).totalCredits;
    const cost = (tier: "fast" | "balanced" | "premium" | "ultra") => estimateProviderCostForProject(inputForTier(tier)).estimatedUsd;

    expect(credits("fast")).toBeLessThan(credits("balanced"));
    expect(credits("balanced")).toBeLessThan(credits("premium"));
    expect(credits("premium")).toBeLessThan(credits("ultra"));

    // The property that matters is not the ordering but the margin: every tier
    // has to clear its own provider cost at the cheapest a credit is ever sold
    // for — the Max plan's rate ($199.99 for 80,000 credits, less Google Play's
    // 15%), the plan someone can burn 80,000 of on long premium books, or the
    // intro offer priced at that floor, whichever is lower.
    for (const tier of ["fast", "balanced", "premium", "ultra"] as const) {
      expect(credits(tier) * CHEAPEST_CREDIT_USD).toBeGreaterThan(cost(tier));
    }
  });

  it("adjusts provider cost assumptions per model tier", () => {
    const mediaSettings = {
      fullIllustrations: true,
      illustrationCadence: "template-driven",
      includeCover: true,
      coverTemplate: "business",
      finalReview: true,
      toneProfile: "confident"
    };
    const inputForTier = (modelTier?: "fast" | "balanced" | "premium" | "ultra") =>
      createProjectSchema.parse({
        prompt: "Create a premium guide about pricing consulting retainers.",
        category: "BUSINESS",
        subcategory: "Lead Magnet Ebook",
        targetPages: 24,
        mediaSettings: { ...mediaSettings, ...(modelTier ? { modelTier } : {}) }
      });

    // Balanced is its own entry in the table rather than a fallthrough, so it
    // no longer equals the base table: page 1's second draft and its judge put
    // it $0.003 above. What the pair still pins is the property that mattered —
    // a book with **no tier recorded** costs as balanced, by the same rule that
    // prices it as balanced, and would keep doing so if a fifth tier were added.
    expect(providerCostAssumptionsForInput(inputForTier())).toEqual(
      providerCostAssumptionsForInput(inputForTier("balanced"))
    );
    expect(providerCostAssumptionsForInput(inputForTier("balanced"))).toMatchObject({
      // The one-off rides the per-book base, never `textPerPage` — the rate the
      // Max break-even floor below is tested against, per page.
      textBase: 0.083,
      textPerPage: PROVIDER_COST_ASSUMPTIONS_USD.textPerPage,
      imageGeneration: PROVIDER_COST_ASSUMPTIONS_USD.imageGeneration,
      coverIncluded: PROVIDER_COST_ASSUMPTIONS_USD.coverIncluded
    });
    expect(providerCostAssumptionsForInput(inputForTier("fast"))).toMatchObject({
      textPerPage: 0.008,
      // Fast draws one draft of page 1, so best-of moved nothing here.
      textBase: PROVIDER_COST_ASSUMPTIONS_USD.textBase
    });
    expect(providerCostAssumptionsForInput(inputForTier("premium"))).toMatchObject({
      // Page 1's best-of-3 draft and its judge, charged once per book.
      textBase: 0.14,
      textPerPage: 0.05,
      imageGeneration: 0.067,
      coverIncluded: 0.134
    });
    expect(providerCostAssumptionsForInput(inputForTier("ultra"))).toMatchObject({
      textBase: 0.17,
      textPerPage: 0.12,
      imageGeneration: 0.067,
      coverIncluded: 0.134
    });
    expect(providerCostAssumptionsForInput(inputForTier("ultra")).textPerPage).toBeGreaterThan(
      providerCostAssumptionsForInput(inputForTier("premium")).textPerPage
    );

    const fastEstimate = estimateProviderCostForProject(inputForTier("fast"));
    const balancedEstimate = estimateProviderCostForProject(inputForTier("balanced"));
    const premiumEstimate = estimateProviderCostForProject(inputForTier("premium"));
    expect(fastEstimate.estimatedUsd).toBeLessThan(balancedEstimate.estimatedUsd);
    expect(premiumEstimate.estimatedUsd).toBeGreaterThan(balancedEstimate.estimatedUsd);
  });

  it("charges page 1's best-of drafting once per book, never per page", () => {
    // No illustrations and no AI cover, so the only thing that moves between
    // these two books is text: base + pages x per-page.
    const inputFor = (modelTier: "fast" | "balanced" | "premium" | "ultra", targetPages: number) =>
      createProjectSchema.parse({
        prompt: "Create a guide about pricing consulting retainers.",
        category: "BUSINESS",
        subcategory: "Lead Magnet Ebook",
        targetPages,
        mediaSettings: {
          fullIllustrations: false,
          includeCover: false,
          finalReview: true,
          toneProfile: "confident",
          modelTier
        }
      });

    for (const tier of ["fast", "balanced", "premium", "ultra"] as const) {
      const assumptions = providerCostAssumptionsForInput(inputFor(tier, 8));
      const short = estimateProviderCostForProject(inputFor(tier, 8)).estimatedUsd;
      const long = estimateProviderCostForProject(inputFor(tier, 108)).estimatedUsd;

      // The whole point of putting the one-off on `textBase`: a hundred more
      // pages cost a hundred per-page rates and not one cent more. Folded into
      // `textPerPage` instead, the extra opening-page work would be billed a
      // hundred times over on the long book and once-in-a-hundred on a short one.
      expect(long - short).toBeCloseTo(100 * assumptions.textPerPage, 6);
      const premiumReview = tier === "premium" || tier === "ultra" ? assumptions.premiumReview : 0;
      expect(short).toBeCloseTo(assumptions.textBase + 8 * assumptions.textPerPage + assumptions.exportCompile + premiumReview, 6);
    }

    // And the base itself did move for the tiers that pay for three candidates.
    expect(estimateProviderCostForProject(inputFor("premium", 8)).estimatedUsd).toBeCloseTo(0.62, 6);
    expect(estimateProviderCostForProject(inputFor("ultra", 8)).estimatedUsd).toBeCloseTo(1.21, 6);
  });

  it("builds margin summaries from estimated revenue and actual provider cost", () => {
    const input = createProjectSchema.parse({
      prompt: "Create a short story about a lighthouse keeper.",
      category: "STORY",
      subcategory: "Short Story",
      targetPages: 16,
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "fiction",
        finalReview: true,
        toneProfile: "narrative"
      }
    });

    const creditEstimate = estimateFullBookCreditCost(input);
    const providerEstimate = estimateProviderCostForProject(input);
    const margin = buildMarginEstimate({
      creditEstimate,
      providerEstimate,
      actualProviderCostUsd: 1.25
    });

    expect(estimateInteriorImageCount(input)).toBe(3);
    // A margin values credits at the cheapest a paid credit is sold for, never
    // at the notional cent (`CREDIT_USD_VALUE`), which read 4.7× too rosy.
    const revenueUsd = creditEstimate.totalCredits * CHEAPEST_CREDIT_USD;
    expect(margin.estimatedRevenueUsd).toBeCloseTo(revenueUsd, 6);
    expect(margin.actualProviderCostUsd).toBe(1.25);
    expect(margin.actualMarginUsd).toBeCloseTo(revenueUsd - 1.25, 6);
  });
});

describe("interior illustration billing matches generation slots", () => {
  const illustrated = (overrides: Record<string, unknown>) =>
    createProjectSchema.parse({
      prompt: "Create a short illustrated book.",
      complexity: 5,
      temperature: 0.65,
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral"
      },
      ...overrides
    });

  it("charges a 5-page short story or lead magnet for one interior, not two", () => {
    // Generation only illustrates page 1 of a 5-page template-driven book.
    // ceil(pages/4) used to quote 2 and overcharge the reader.
    const story = illustrated({
      category: "STORY",
      subcategory: "Short Story",
      targetPages: 5
    });
    const leadMagnet = illustrated({
      category: "BUSINESS",
      subcategory: "Lead Magnet Ebook",
      targetPages: 5
    });
    const business = illustrated({ category: "BUSINESS", targetPages: 5 });

    expect(estimateInteriorImageCount(story)).toBe(1);
    expect(estimateInteriorImageCount(leadMagnet)).toBe(1);
    expect(estimateInteriorImageCount(business)).toBe(1);
  });

  it("charges an 8-page default-cadence book for pages 1 and 8", () => {
    const story = illustrated({
      category: "STORY",
      subcategory: "Short Story",
      targetPages: 8
    });
    expect(estimateInteriorImageCount(story)).toBe(2);
  });

  it("still caps a 28-page education workbook at 6 interiors", () => {
    const workbook = illustrated({
      category: "EDUCATION",
      subcategory: "Workbook or Study Guide",
      targetPages: 28
    });
    expect(estimateInteriorImageCount(workbook)).toBe(6);
  });
});

describe("audiobook pricing", () => {
  // What a credit is worth at its cheapest: the plan that can spend the most of
  // them ($199.99 for 80,000, less Google Play's 15%), or an intro offer at that floor.
  const CHEAPEST_USD = CHEAPEST_CREDIT_USD;
  // $0.00025 a second of audio at ~155 spoken words a minute.
  const speechUsd = (words: number) => (words / 155) * 60 * 0.00025;

  it("charges a base plus every hundred narrated words, rounded up", () => {
    const estimate = estimateAudiobookCreditCost({ pageCount: 20, wordCount: 9_001 });
    expect(estimate.totalCredits).toBe(DEFAULT_CREDIT_COSTS.audiobookBase + 91 * DEFAULT_CREDIT_COSTS.audiobookPer100Words);
    expect(estimate.lineItems).toHaveLength(1);
    expect(estimate.lineItems[0]).toMatchObject({
      code: "AUDIOBOOK_GENERATION",
      quantity: 91,
      unitCredits: DEFAULT_CREDIT_COSTS.audiobookPer100Words
    });
  });

  it("clears the speech bill on the Max plan for a prose-heavy book", () => {
    // A composed nonfiction book: ~450 words a page.
    const wordCount = 20 * 450;
    const revenueUsd = estimateAudiobookCreditCost({ pageCount: 20, wordCount }).totalCredits * CHEAPEST_USD;
    expect(revenueUsd).toBeGreaterThan(speechUsd(wordCount) * 1.2);
  });

  it("charges a short picture book less than the old flat 12 credits a page did", () => {
    const estimate = estimateAudiobookCreditCost({ pageCount: 16, wordCount: 16 * 60 });
    expect(estimate.totalCredits).toBeLessThan(80 + 16 * 12);
    expect(estimate.totalCredits * CHEAPEST_USD).toBeGreaterThan(speechUsd(16 * 60));
  });

  it("prices a book with no words at the base alone rather than going negative", () => {
    expect(estimateAudiobookCreditCost({ pageCount: 0, wordCount: 0 }).totalCredits).toBe(DEFAULT_CREDIT_COSTS.audiobookBase);
    expect(estimateAudiobookCreditCost({ pageCount: -5, wordCount: -50 }).totalCredits).toBe(DEFAULT_CREDIT_COSTS.audiobookBase);
  });

  it("honours operator overrides, a per-page rate included", () => {
    const pricing = { ...DEFAULT_CREDIT_COSTS, audiobookBase: 500, audiobookPerPage: 20, audiobookPer100Words: 3 };
    const estimate = estimateAudiobookCreditCost({ pageCount: 10, wordCount: 1_000 }, pricing);
    expect(estimate.totalCredits).toBe(500 + 200 + 30);
    expect(estimate.lineItems).toHaveLength(2);
    expect(creditCostForOperation("AUDIOBOOK_GENERATION", pricing)).toBe(500);
  });
});

describe("narrated word count", () => {
  it("counts the words the narrator reads and nothing it skips", () => {
    const pages = [
      "# The Harbour\n\nMina walked to the **old** pier.\n\n![a boat](/assets/images/p/boat.png)",
      "```js\nconst ignored = true;\n```\n\n| a | b |\n| - | - |\n\nShe waved."
    ];
    // "The Harbour" (2) + "Mina walked to the old pier" (6) + "She waved" (2).
    expect(narrationWordCount(pages)).toBe(10);
  });

  it("estimates unspaced scripts from their characters", () => {
    expect(narrationWordCount(["月光照在海面上。"])).toBeGreaterThan(1);
  });
});

describe("creditCostForOperation message quotes", () => {
  const pricing = {
    ...DEFAULT_CREDIT_COSTS,
    messageCreditsFree: 1,
    messageResetCreditsFree: 11,
    messageCreditsCreator: 2,
    messageResetCreditsCreator: 22,
    messageCreditsPro: 3,
    messageResetCreditsPro: 33,
    messageCreditsMax: 4,
    messageResetCreditsMax: 44,
    premiumReview: 777
  };

  it("quotes Free message keys when the plan tier is omitted", () => {
    expect(creditCostForOperation("CHAT_MESSAGE", pricing)).toBe(1);
    expect(creditCostForOperation("MESSAGE_LIMIT_RESET", pricing)).toBe(11);
    expect(creditCostForOperation("CHAT_MESSAGE")).toBe(DEFAULT_CREDIT_COSTS.messageCreditsFree);
    expect(creditCostForOperation("MESSAGE_LIMIT_RESET")).toBe(DEFAULT_CREDIT_COSTS.messageResetCreditsFree);
    expect(creditCostForOperation("CHAT_MESSAGE", pricing, "free")).toBe(1);
    expect(creditCostForOperation("MESSAGE_LIMIT_RESET", pricing, "free")).toBe(11);
  });

  it.each([
    ["creator", 2, 22],
    ["pro", 3, 33],
    ["max", 4, 44]
  ] as const)("quotes %s message keys from an explicit pricing object", (tier, messageCredits, resetCredits) => {
    expect(creditCostForOperation("CHAT_MESSAGE", pricing, tier)).toBe(messageCredits);
    expect(creditCostForOperation("MESSAGE_LIMIT_RESET", pricing, tier)).toBe(resetCredits);
  });

  it("ignores planTier for operations that are not message-priced", () => {
    expect(creditCostForOperation("PREMIUM_REVIEW", pricing, "max")).toBe(777);
    expect(creditCostForOperation("PREMIUM_REVIEW", pricing)).toBe(777);
  });

  it("prices the retired export unlock at nothing, whatever a price list says", () => {
    expect(creditCostForOperation("EXPORT_UNLOCK", { ...pricing, exportUnlock: 150 })).toBe(0);
    expect(creditCostForOperation("EXPORT_UNLOCK")).toBe(0);
  });
});

describe("estimateBookReplanCreditCost", () => {
  it("itemises the rebuild base ahead of the copy's full-book quote and adds up to both", () => {
    const input = createProjectSchema.parse({
      title: "The Lighthouse",
      prompt: "A small book about a lighthouse keeper",
      category: "STORY",
      targetPages: 12
    });
    const book = estimateFullBookCreditCost(input, DEFAULT_CREDIT_COSTS);
    const replan = estimateBookReplanCreditCost(input, DEFAULT_CREDIT_COSTS);

    expect(replan.totalCredits).toBe(DEFAULT_CREDIT_COSTS.bookReplanBase + book.totalCredits);
    expect(replan.lineItems[0]).toEqual({
      code: "BOOK_REPLAN",
      label: "Book rebuild",
      quantity: 1,
      unitCredits: DEFAULT_CREDIT_COSTS.bookReplanBase,
      credits: DEFAULT_CREDIT_COSTS.bookReplanBase
    });
    expect(replan.lineItems.slice(1)).toEqual(book.lineItems);
    expect(replan.lineItems.reduce((total, line) => total + line.credits, 0)).toBe(replan.totalCredits);
  });
});
