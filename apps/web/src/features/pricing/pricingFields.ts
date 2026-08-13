import type { CreditPricingKey } from "./types.js";

export type PricingFieldGroup = {
  title: string;
  blurb: string;
  fields: Array<{ key: CreditPricingKey; label: string; help: string }>;
};

/**
 * How the price list is presented.
 *
 * Grouped by the moment a reader is charged rather than by the shape of the
 * number, because that is the question an operator is answering: "what does it
 * cost someone to make a book / change one / read one out loud".
 *
 * The last group is the exception: those two are limits on the free tier, not
 * prices. They live in the same table because they need the same audit trail
 * and the same live reload, and an operator tuning one is usually reacting to
 * the same thing — abuse, or a margin that moved.
 */
export const PRICING_FIELD_GROUPS: PricingFieldGroup[] = [
  {
    title: "Making a book",
    blurb: "Charged once, when a plan is approved and the book is generated.",
    fields: [
      { key: "fullBookBaseFast", label: "Full book base — Quick draft", help: "Flat charge for generating any book on the Quick draft tier." },
      { key: "fullBookBase", label: "Full book base — Balanced", help: "Flat charge for generating any book. Also the rate for a book with no tier recorded." },
      { key: "fullBookBasePremium", label: "Full book base — Extra polish", help: "Flat charge for generating any book on the Extra polish tier." },
      { key: "fullBookPerPageFast", label: "Per page — Quick draft", help: "Multiplied by the target page count." },
      { key: "fullBookPerPage", label: "Per page — Balanced", help: "Multiplied by the target page count." },
      {
        key: "fullBookPerPagePremium",
        label: "Per page — Extra polish",
        help: "Multiplied by the target page count. The tier's real cost is ~$0.05 a page, so this must stay above ~24 or a long premium book loses money on a Max subscription."
      },
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
      { key: "premiumReview", label: "Premium review", help: "Added once for a book on the Extra polish tier, which runs an extra review pass." },
      { key: "coverRegeneration", label: "Cover regeneration", help: "Redrawing a cover on its own. No route charges this today." },
      { key: "planGeneration", label: "Plan generation", help: "Drafting the plan. Free today." },
      { key: "previewGeneration", label: "Preview generation", help: "Sample pages before committing. Free today." }
    ]
  },
  {
    title: "Changing a book",
    blurb: "Quoted in chat before the edit runs, then charged when it is confirmed.",
    fields: [
      { key: "planRevision", label: "Plan revision", help: "Reworking the plan before approval." },
      { key: "bookTextEditBase", label: "Text edit base", help: "Flat part of a small in-place edit. Not tiered — request overhead, not model spend." },
      { key: "bookTextEditPerPageFast", label: "Text edit per page — Quick draft", help: "Added for each page the edit touches." },
      { key: "bookTextEditPerPage", label: "Text edit per page — Balanced", help: "Added for each page the edit touches." },
      { key: "bookTextEditPerPagePremium", label: "Text edit per page — Extra polish", help: "Added for each page the edit touches, at premium prose rates." },
      { key: "pageRegenerationPerPageFast", label: "Page rewrite per page — Quick draft", help: "Rewrites, chapter regenerations, continuations." },
      { key: "pageRegenerationPerPage", label: "Page rewrite per page — Balanced", help: "Rewrites, chapter regenerations, continuations." },
      {
        key: "pageRegenerationPerPagePremium",
        label: "Page rewrite per page — Extra polish",
        help: "Rewrites, chapter regenerations, continuations, on the premium prose model."
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
    blurb: "What a reader gets each month without paying. Paid tiers take their allowance from the product catalog instead, because those numbers are pinned to a Play price.",
    fields: [
      {
        key: "freeMonthlyCredits",
        label: "Monthly credits",
        help: "Granted at the start of each calendar month. Resets rather than accumulating."
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
      }
    ]
  }
];
