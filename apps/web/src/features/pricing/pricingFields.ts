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
      { key: "fullBookBase", label: "Full book base", help: "Flat charge for generating any book." },
      { key: "fullBookPerPage", label: "Per page", help: "Multiplied by the target page count." },
      { key: "imageGeneration", label: "Interior image", help: "Per illustration; the count is capped by book type." },
      { key: "premiumReview", label: "Premium review", help: "Added for premium-preset or best-of-drafted books." },
      { key: "coverRegeneration", label: "Cover regeneration", help: "Redrawing a cover on its own." },
      { key: "planGeneration", label: "Plan generation", help: "Drafting the plan. Free today." },
      { key: "previewGeneration", label: "Preview generation", help: "Sample pages before committing. Free today." }
    ]
  },
  {
    title: "Changing a book",
    blurb: "Quoted in chat before the edit runs, then charged when it is confirmed.",
    fields: [
      { key: "planRevision", label: "Plan revision", help: "Reworking the plan before approval." },
      { key: "bookTextEditBase", label: "Text edit base", help: "Flat part of a small in-place edit." },
      { key: "bookTextEditPerPage", label: "Text edit per page", help: "Added for each page the edit touches." },
      { key: "pageRegenerationPerPage", label: "Page rewrite per page", help: "Rewrites, chapter regenerations, continuations." },
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
      { key: "audiobookPerPage", label: "Audiobook per page", help: "Added for each page narrated. Charged against the real page count." }
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
      }
    ]
  }
];
