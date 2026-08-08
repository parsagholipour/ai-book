import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import {
  COVER_DESIGN_SELECTION_PURPOSE,
  coverDesign,
  coverDesignCatalogLines,
  fallbackCoverDesign,
  type CoverDesign
} from "./coverDesigns.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";

export type CoverDesignChoice = {
  design: CoverDesign;
  /** How the design was chosen; recorded on the cover asset for provenance. */
  selectedBy: "model" | "fallback";
  reason?: string;
};

export type SelectCoverDesignOptions = {
  textModel: TextModelAdapter;
  input: CreateProjectInput;
  plan: BookPlan;
  /** Breaks ties in the model-free pick — pass the project id. */
  seed: string;
  title?: string | null | undefined;
  subtitle?: string | null | undefined;
  /**
   * Errors this returns true for are re-thrown instead of falling back. Core
   * knows nothing about the worker's stop signal, but swallowing one here let
   * a user-stopped run finish its cover and compile to COMPLETE.
   */
  bailOnError?: ((error: unknown) => boolean) | undefined;
};

const coverDesignSelectionSchema = z.object({
  designId: z.string(),
  reason: z.string().max(240).optional()
});

/**
 * Picks the bundled cover for a book.
 *
 * This runs at the very end of a book that has already been paid for and fully
 * written, so it does not throw: any model failure, timeout or unknown id falls
 * through to `fallbackCoverDesign`, which always answers — except for errors the
 * caller's `bailOnError` claims, which must propagate. The id is validated
 * against the catalog here rather than with a 50-member `z.enum`, so a model
 * that invents one is a fallback rather than a repair loop.
 */
export async function selectCoverDesign(options: SelectCoverDesignOptions): Promise<CoverDesignChoice> {
  const context = {
    category: options.input.category,
    subcategory: options.input.subcategory,
    hints: [options.title, options.subtitle, options.plan.premise, options.plan.audience].filter(Boolean).join(" ")
  };
  const fallback = (): CoverDesignChoice => ({
    design: fallbackCoverDesign({ ...context, seed: options.seed }),
    selectedBy: "fallback"
  });

  try {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: COVER_DESIGN_SELECTION_PURPOSE,
      temperature: 0.2,
      maxTokens: 300,
      schema: coverDesignSelectionSchema,
      messages: [
        {
          role: "system",
          content: [
            "You choose one pre-made cover design for a finished book from a fixed catalog.",
            "Answer with the design whose artwork best matches the book's subject, genre and mood.",
            "The book's title and author are typeset over the artwork afterwards, so ignore typography and pick on imagery alone.",
            `Reply as JSON: {"designId": "<one id from the catalog>", "reason": "<max 20 words>"}.`,
            "Catalog:",
            coverDesignCatalogLines()
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              title: options.title ?? options.plan.title,
              subtitle: options.subtitle ?? options.plan.subtitle,
              category: options.input.category,
              subcategory: options.input.subcategory,
              audience: options.plan.audience,
              premise: options.plan.premise,
              language: options.input.language
            },
            null,
            2
          )
        }
      ]
    });
    const design = coverDesign(result.data.designId.trim());
    if (!design) {
      return fallback();
    }
    return {
      design,
      selectedBy: "model",
      ...(result.data.reason ? { reason: result.data.reason } : {})
    };
  } catch (error) {
    if (options.bailOnError?.(error)) {
      throw error;
    }
    return fallback();
  }
}
