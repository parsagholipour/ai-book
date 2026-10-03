import type { CreditPricingKey } from "./types.js";

export type PricingFieldGroup = {
  title: string;
  blurb: string;
  fields: Array<{ key: CreditPricingKey; label: string; help: string; toggle?: boolean }>;
};

/**
 * How the price list is presented.
 *
 * Grouped by the moment a reader is charged rather than by the shape of the
 * number, because that is the question an operator is answering: "what does it
 * cost someone to make a book / change one / read one out loud".
 *
 * The last group is the exception: those are limits on the free tier, not
 * prices. They live in the same table because they need the same audit trail
 * and the same live reload, and an operator tuning one is usually reacting to
 * the same thing — abuse, or a margin that moved.
 */
export const PRICING_FIELD_GROUPS: PricingFieldGroup[] = [
  {
    title: "Welcome credits",
    blurb: "A one-time gift for new accounts, separate from monthly credits. Set how many accounts from the same IP can receive it within 30 days. Changes affect grants that have not settled yet; existing balances stay the same.",
    fields: [
      { key: "welcomeCreditsEnabled", label: "Give welcome credits", toggle: true, help: "Turn the welcome gift on or off for all new accounts." },
      { key: "welcomeCreditsRegionalEnabled", label: "Use country income groups", toggle: true, help: "Use the signup country's World Bank FY2027 income group. All EU/EEA countries receive the same offer." },
      { key: "welcomeCredits", label: "Global / fallback credits", help: "Used everywhere when regional amounts are off, or for other and unknown locations when on. 0 means no gift." },
      { key: "welcomeCreditsHighIncome", label: "High-income countries", help: "US, Canada, EU/EEA, UK, Australia, Japan, South Korea, Singapore, UAE and other high-income economies. 0 means no gift." },
      { key: "welcomeCreditsLowMiddleIncome", label: "Low- and middle-income countries", help: "India, Pakistan, Bangladesh, Indonesia, China, Brazil, South Africa and other low- or middle-income economies. 0 means no gift." },
      { key: "welcomeCreditsAccountsPerIpHighIncome", label: "Accounts per IP — High-income countries", help: "Maximum accounts that can receive welcome credits from one IP within 30 days. Applies even when regional credit amounts are off. 0 disables the gift for this group." },
      { key: "welcomeCreditsAccountsPerIpLowMiddleIncome", label: "Accounts per IP — Low- and middle-income countries", help: "Maximum accounts that can receive welcome credits from one IP within 30 days, including unknown locations. Applies even when regional credit amounts are off. 0 disables the gift for this group." }
    ]
  },
  ...(["Free", "Creator", "Pro", "Max"] as const).map((plan): PricingFieldGroup => ({
    title: `Ordinary messages — ${plan}`,
    blurb: "Shared across creation and book chats. The allowance renews at midnight UTC. A reset restores the full allowance until that same midnight.",
    fields: [
      { key: `messageCredits${plan}`, label: "Credits per message", help: "0 makes ordinary messages free. Generation and edit charges still apply separately." },
      { key: `messageDailyLimit${plan}`, label: "Daily messages", help: "Total user sends across all chats, including edited messages. 0 disables messaging." },
      { key: `messageResetEnabled${plan}`, label: "Allow credit resets", help: "1 enables the reset option at the cap; 0 disables it." },
      { key: `messageResetCredits${plan}`, label: "Credits per reset", help: "Charged only after the reader confirms. 0 offers a free reset when enabled." }
    ]
  })),

  {
    title: "Making a book",
    blurb: "Planning is charged when it starts; the book package is charged later, after plan approval.",
    fields: [
      { key: "planGenerationFast", label: "Initial plan — Quick draft", help: "Charged immediately when Quick draft planning starts." },
      { key: "planGeneration", label: "Initial plan — Balanced", help: "Charged immediately when Balanced planning starts. Also used when no tier is recorded." },
      { key: "planGenerationPremium", label: "Initial plan — Extra polish", help: "Charged immediately when Extra polish planning starts." },
      { key: "planGenerationUltra", label: "Initial plan — Ultra effort", help: "Charged immediately when Ultra effort planning starts." },
      { key: "fullBookBaseFast", label: "Full book base — Quick draft", help: "Flat charge for generating any book on the Quick draft tier." },
      { key: "fullBookBase", label: "Full book base — Balanced", help: "Flat charge for generating any book. Also the rate for a book with no tier recorded." },
      { key: "fullBookBasePremium", label: "Full book base — Extra polish", help: "Flat charge for generating any book on the Extra polish tier." },
      { key: "fullBookBaseUltra", label: "Full book base — Ultra effort", help: "Flat charge for generating any book on the Ultra effort tier. Extra passes, not a different image model." },
      { key: "fullBookPerPageFast", label: "Per page — Quick draft", help: "Multiplied by the target page count." },
      { key: "fullBookPerPage", label: "Per page — Balanced", help: "Multiplied by the target page count." },
      {
        key: "fullBookPerPagePremium",
        label: "Per page — Extra polish",
        help: "Multiplied by the target page count. The tier's real cost is ~$0.05 a page, so this must stay above ~24 or a long premium book loses money on a Max subscription."
      },
      { key: "fullBookPerPageUltra", label: "Per page — Ultra effort", help: "Multiplied by the target page count on Ultra effort." },
      {
        key: "imageGenerationFast",
        label: "Generated image — Quick draft",
        help: "Per initial cover or interior illustration; the interior count is capped by book type."
      },
      {
        key: "imageGeneration",
        label: "Generated image — Balanced",
        help: "Per initial cover or interior illustration. Quick draft and Balanced share an image model, so these two normally match."
      },
      {
        key: "imageGenerationPremium",
        label: "Generated image — Extra polish",
        help: "Per image on the premium image model, which also draws a more expensive cover."
      },
      {
        key: "imageGenerationUltra",
        label: "Generated image — Ultra effort",
        help: "Same image model as Extra polish; Ultra charges the same per image."
      },
      { key: "premiumReview", label: "Premium review", help: "Added once for Extra polish or Ultra effort, which run an extra review pass." },
      { key: "coverRegeneration", label: "Cover regeneration", help: "Redrawing a cover on its own. No route charges this today." },
      { key: "previewGeneration", label: "Preview generation", help: "Sample pages before committing. Free today." }
    ]
  },
  {
    title: "Changing a book",
    blurb: "Quoted in chat before the edit runs, then charged when it is confirmed.",
    fields: [
      { key: "planRevisionFast", label: "Plan revision — Quick draft", help: "Reworking the plan before approval. Runs the same planner as the first plan, so it follows the same tier ladder." },
      { key: "planRevision", label: "Plan revision — Balanced", help: "Reworking the plan before approval." },
      { key: "planRevisionPremium", label: "Plan revision — Extra polish", help: "Reworking the plan before approval, on the premium planner." },
      { key: "planRevisionUltra", label: "Plan revision — Ultra effort", help: "Reworking the plan before approval, on Ultra effort." },
      { key: "bookTextEditBase", label: "Text edit base", help: "Flat part of a small in-place edit. Not tiered — request overhead, not model spend." },
      { key: "bookTextEditPerPageFast", label: "Text edit per page — Quick draft", help: "Added for each page the edit touches." },
      { key: "bookTextEditPerPage", label: "Text edit per page — Balanced", help: "Added for each page the edit touches." },
      { key: "bookTextEditPerPagePremium", label: "Text edit per page — Extra polish", help: "Added for each page the edit touches, at premium prose rates." },
      { key: "bookTextEditPerPageUltra", label: "Text edit per page — Ultra effort", help: "Added for each page the edit touches, at Ultra effort rates." },
      { key: "pageRegenerationPerPageFast", label: "Page rewrite per page — Quick draft", help: "Rewrites, chapter regenerations, continuations." },
      { key: "pageRegenerationPerPage", label: "Page rewrite per page — Balanced", help: "Rewrites, chapter regenerations, continuations." },
      {
        key: "pageRegenerationPerPagePremium",
        label: "Page rewrite per page — Extra polish",
        help: "Rewrites, chapter regenerations, continuations, on the premium prose model."
      },
      {
        key: "pageRegenerationPerPageUltra",
        label: "Page rewrite per page — Ultra effort",
        help: "Rewrites, chapter regenerations, continuations, on Ultra effort."
      },
      { key: "bookReplanBase", label: "Replan base", help: "Added on top of a full regeneration of the book." }
    ]
  },
  {
    title: "Reading and talking",
    blurb: "Charged at the point of use.",
    fields: [
      { key: "exportUnlock", label: "Export unlock", help: "One-off unlock for PDF/EPUB download." },
      { key: "voiceCallPerMinute", label: "Voice call per minute", help: "Rounded up; calls are capped at 30 minutes." },
      { key: "audiobookBase", label: "Audiobook base", help: "Flat part of narrating a finished book." },
      { key: "audiobookPerPage", label: "Audiobook per page", help: "Added for each page narrated. Charged against the real page count." },
      {
        key: "characterPortraitGeneration",
        label: "Character portrait",
        help: "Drawing a profile portrait for a library character, from their photo or description."
      }
    ]
  },
  {
    title: "Free plan limits",
    blurb: "What a reader gets without paying. Paid tiers take their allowance from the product catalog instead, because those numbers are pinned to a Play price.",
    fields: [
      {
        key: "freeMonthlyCredits",
        label: "Monthly credits",
        help: "Credits a free reader gets each calendar month. Unused credits do not carry over."
      },
      {
        key: "freeIllustratedBooksPerMonth",
        label: "Illustrated books a month",
        help: "After this, a free reader can still write books, but only without visuals."
      },
      {
        key: "freeManuscriptImportsPerMonth",
        label: "Manuscript imports a month",
        help: "Bring-your-own-book uploads on the free plan. Subscribers import without limits."
      },
      {
        key: "freeMaxBookPages",
        label: "Longest free book (pages)",
        help: "The longest book a free reader can have written. Longer books, up to 600 pages, need a plan. 0 stops every free book."
      }
    ]
  }
];
