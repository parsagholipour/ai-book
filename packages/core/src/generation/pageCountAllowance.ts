import type { CreateProjectInput } from "../schemas/book.js";

type PageCountInput = Pick<CreateProjectInput, "targetPages"> & {
  mediaSettings?: unknown;
};

function savedPageCount(input: PageCountInput): { requestedPages: number; selectedPages: number } | undefined {
  const settings = input.mediaSettings;
  if (!settings || typeof settings !== "object" || !("generationPageCount" in settings)) return;
  const saved = settings.generationPageCount;
  if (!saved || typeof saved !== "object" || !("requestedPages" in saved) || !("selectedPages" in saved) ||
    typeof saved.requestedPages !== "number" || typeof saved.selectedPages !== "number" ||
    !Number.isInteger(saved.requestedPages) || saved.requestedPages < 1 || !Number.isInteger(saved.selectedPages)) return;
  return { requestedPages: saved.requestedPages, selectedPages: saved.selectedPages };
}

/** Story pages only: the customer's request is a floor, never a rounding target. */
export function pageCountAllowance(requestedPages: number): { minimumPages: number; maximumPages: number } {
  return { minimumPages: requestedPages, maximumPages: requestedPages + Math.max(1, Math.floor(requestedPages / 10)) };
}

/** A saved choice is fixed, so retries cannot compound the ten percent allowance. */
export function generationPageCountBounds(input: PageCountInput) {
  const saved = savedPageCount(input);
  if (saved && saved.selectedPages === input.targetPages &&
    saved.selectedPages >= saved.requestedPages && saved.selectedPages <= pageCountAllowance(saved.requestedPages).maximumPages) {
    return { minimumPages: saved.selectedPages, maximumPages: saved.selectedPages };
  }
  return pageCountAllowance(input.targetPages);
}

export function requestedGenerationPages(input: PageCountInput): number {
  const saved = savedPageCount(input);
  return saved && generationPageCountBounds(input).maximumPages === input.targetPages ? saved.requestedPages : input.targetPages;
}

export function inputWithSelectedPageCount(input: CreateProjectInput, selectedPages: number): CreateProjectInput {
  const { minimumPages, maximumPages } = generationPageCountBounds(input);
  if (!Number.isInteger(selectedPages) || selectedPages < minimumPages || selectedPages > maximumPages) {
    throw new Error(`Generated book has ${selectedPages} pages; expected ${minimumPages}-${maximumPages} pages.`);
  }
  if (minimumPages === maximumPages && savedPageCount(input)?.selectedPages === selectedPages) return input;
  return { ...input, targetPages: selectedPages, mediaSettings: { ...input.mediaSettings,
    generationPageCount: { requestedPages: requestedGenerationPages(input), selectedPages }
  } };
}

export const MAX_PICTURE_BOOK_PAGES = pageCountAllowance(40).maximumPages;
