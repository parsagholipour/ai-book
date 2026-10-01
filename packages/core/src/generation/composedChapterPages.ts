import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import { figureFreeProse, figureStandInMarkdown } from "./figures/figureBlocks.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { IMAGE_PROMPT_CHARACTER_RULE } from "./pagesShared.js";

/**
 * The composed pass's "paginate and describe" stage: titles, summaries,
 * continuity notes and image prompts for the pages the typesetter cut a
 * chapter into. Split from `composedChapter.ts` for the 900-line budget.
 */
export const DESCRIBE_PAGES_PURPOSE = "describe-pages";

export type ChapterPageForDescription = { index: number; markdown: string };

export type DescribedPage = {
  index: number;
  title: string;
  summary: string;
  continuityNotes: string[];
  imagePrompt?: string;
};

const describedPageSchema = z.object({
  index: z.number().int().positive(),
  title: z.string().default(""),
  summary: z.string().default(""),
  continuityNotes: z.array(z.string()).default([]),
  imagePrompt: z.string().optional()
});

const describedPagesResponseSchema = z.preprocess(
  (value) => (Array.isArray(value) ? { pages: value } : isRecord(value) && Array.isArray(value.pages) ? value : value),
  z.object({ pages: z.array(z.unknown()) })
);

function firstSentence(markdown: string): string {
  const plain = markdown.replace(/[#*_>`]/g, " ").replace(/\s+/g, " ").trim();
  const match = plain.match(/^(.{20,240}?[.!?…؟。])(\s|$)/u);
  return (match?.[1] ?? plain.slice(0, 240)).trim();
}

/** What a page is called and remembered as when the model could not say. */
export function fallbackPageDescription(page: ChapterPageForDescription, illustrated: boolean): DescribedPage {
  const sentence = firstSentence(figureFreeProse(page.markdown));
  const title = sentence.split(/\s+/).slice(0, 7).join(" ").replace(/[,;:.!?…]+$/u, "") || `Page ${page.index}`;
  return {
    index: page.index,
    title,
    summary: sentence || `Page ${page.index}.`,
    continuityNotes: [],
    ...(illustrated && sentence ? { imagePrompt: `An illustration of this moment: ${sentence}` } : {})
  };
}

export async function describeChapterPages(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter: ChapterPlan;
  pages: ChapterPageForDescription[];
  illustratedIndexes: readonly number[];
  textModel: TextModelAdapter;
}): Promise<DescribedPage[]> {
  const illustrated = new Set(options.illustratedIndexes);
  const fallback = () => options.pages.map((page) => fallbackPageDescription(page, illustrated.has(page.index)));
  if (options.pages.length === 0) {
    return [];
  }
  let raw: unknown;
  try {
    raw = (
      await generateJsonWithRetry(options.textModel, {
        purpose: DESCRIBE_PAGES_PURPOSE,
        temperature: 0.2,
        maxTokens: Math.min(16_000, 800 + options.pages.length * 260),
        schema: z.unknown(),
        messages: [
          {
            role: "system",
            content: [
              "Describe each page of this chapter for the book's index and its continuity memory. Return one JSON object with a pages array in the same order as the input, one object per page: index, title, summary, continuityNotes, and imagePrompt only where asked.",
              "title: concise and specific to what happens on that page; never the chapter title, never a Page N label, never the same as a neighbouring page's title.",
              "summary: one or two sentences recording what the page covers — the facts, events or decisions — and any unresolved handoff into the next page.",
              "continuityNotes: zero to three short facts later chapters must keep consistent (names, dates, places, states, decisions). Omit trivia.",
              "imagePrompt: only for pages whose index is in illustratedPageIndexes. A self-contained visual description of one moment on that page in the book's illustration style, naming recurring characters exactly as in characters, with no text or lettering in the image. Omit the key on every other page.",
              IMAGE_PROMPT_CHARACTER_RULE,
              ...targetLanguageGenerationGuidance(options.input.language)
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                language: targetLanguagePayload(options.input.language),
                book: { title: options.plan.title, audience: options.plan.audience },
                chapter: { index: options.chapter.index, title: options.chapter.title },
                illustrationPlan: options.plan.illustrationPlan,
                characters: options.plan.characters,
                illustratedPageIndexes: options.illustratedIndexes,
                // The describer reads prose and a stand-in, never a figure's JSON.
                pages: options.pages.map((page) => ({ index: page.index, markdown: figureStandInMarkdown(page.markdown) })),
                outputContract: {
                  pages: [
                    {
                      index: options.pages[0]!.index,
                      title: "Specific page title",
                      summary: "One or two sentences.",
                      continuityNotes: ["A fact later chapters keep consistent."],
                      imagePrompt: "Only for illustrated pages."
                    }
                  ]
                }
              },
              null,
              2
            )
          }
        ]
      })
    ).data;
  } catch (error) {
    if (error instanceof Error && /stop/i.test(error.name)) {
      throw error;
    }
    return fallback();
  }
  const parsed = describedPagesResponseSchema.safeParse(raw);
  const byIndex = new Map<number, DescribedPage>();
  if (parsed.success) {
    for (const candidate of parsed.data.pages) {
      const page = describedPageSchema.safeParse(candidate);
      if (page.success && !byIndex.has(page.data.index)) {
        const { imagePrompt, ...rest } = page.data;
        byIndex.set(page.data.index, { ...rest, ...(imagePrompt !== undefined ? { imagePrompt } : {}) });
      }
    }
  }
  return options.pages.map((page) => {
    const described = byIndex.get(page.index);
    const stand = fallbackPageDescription(page, illustrated.has(page.index));
    if (!described) {
      return stand;
    }
    const wantsImage = illustrated.has(page.index);
    const imagePrompt = wantsImage ? described.imagePrompt?.trim() || stand.imagePrompt : undefined;
    return {
      index: page.index,
      title: distinctFromLeadingHeading(described.title.trim() || stand.title, page.markdown, options.chapter.title),
      summary: described.summary.trim() || stand.summary,
      continuityNotes: described.continuityNotes.map((note) => note.trim()).filter(Boolean).slice(0, 3),
      ...(imagePrompt ? { imagePrompt } : {})
    };
  });
}

function headingText(text: string): string {
  return text.toLowerCase().replace(/[*_`]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * A toolkit page (`instructionalBook.ts`) may open on its section's `###`
 * heading, and the compile strips a page's leading heading when it equals the
 * page title (`sanitizePageMarkdown`), so a title copied from the heading
 * would delete the heading from print. Such a title is prefixed with the
 * chapter's. A page opening on no heading — every other composed page — is
 * untouched.
 */
function distinctFromLeadingHeading(title: string, markdown: string, chapterTitle: string): string {
  const heading = markdown.trim().split(/\r?\n/, 1)[0]?.match(/^\s{0,3}###\s+(.+?)\s*#*\s*$/)?.[1];
  return heading && headingText(heading) === headingText(title) ? `${chapterTitle}: ${title}` : title;
}
