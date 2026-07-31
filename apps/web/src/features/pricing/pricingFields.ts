import type { CreditPricingKey } from "./types.js";

export type PricingFieldGroup = {
  title: string;
  blurb: string;
  fields: Array<{ key: CreditPricingKey; label: string; help: string }>;
};

/**
 * How the fourteen prices are presented.
 *
 * Grouped by the moment a reader is charged rather than by the shape of the
 * number, because that is the question an operator is answering: "what does it
 * cost someone to make a book / change one / read one out loud".
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
      { key: "voiceCallPerMinute", label: "Voice call per minute", help: "Rounded up; calls are capped at 30 minutes." }
    ]
  }
];
