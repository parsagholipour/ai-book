import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import { bookDossierSchema, bookEpisodesSchema, type BookDossier, type BookEpisodes, type ChapterEpisode } from "../schemas/episodes.js";
import type { AuthorStance } from "../schemas/plan.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

/**
 * Material-first, step one: the episodes. One call plans two or three
 * episodes per chapter — a person, a place, a date and a document from the
 * record — before any prose exists, so that every chapter has something to
 * put on the page and the argument is found in the material rather than the
 * material illustrating the argument (opinion-fable-5 §3).
 */
export const PLAN_EPISODES_PURPOSE = "plan-episodes";

export {
  EPISODE_KINDS,
  bookDossierSchema,
  bookEpisodesSchema,
  chapterEpisodeSchema,
  dossierExcerptSchema,
  type BookDossier,
  type BookEpisodes,
  type ChapterEpisode,
  type DossierExcerpt,
  type EpisodeKind
} from "../schemas/episodes.js";

/** The episodes a plan stores, or nothing. */
export function planEpisodesFromPlan(plan: BookPlan): BookEpisodes | undefined {
  const stored = (plan as { episodes?: unknown }).episodes;
  if (!isRecord(stored)) return undefined;
  const parsed = bookEpisodesSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

/** The dossier a plan stores, or nothing. */
export function planDossierFromPlan(plan: BookPlan): BookDossier | undefined {
  const stored = (plan as { dossier?: unknown }).dossier;
  if (!isRecord(stored)) return undefined;
  const parsed = bookDossierSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

export function episodesForChapter(episodes: BookEpisodes | undefined, chapterIndex: number): ChapterEpisode[] {
  return episodes?.chapters.find((chapter) => chapter.index === chapterIndex)?.episodes ?? [];
}

export type PlanEpisodesResult = { episodes?: BookEpisodes | undefined; failure?: string | undefined };

export async function planEpisodes(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  textModel: TextModelAdapter;
}): Promise<PlanEpisodesResult> {
  try {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: PLAN_EPISODES_PURPOSE,
      temperature: Math.min(0.6, options.input.temperature),
      maxTokens: 12_000,
      schema: bookEpisodesSchema,
      messages: [
        {
          role: "system",
          content: [
            `You are the author of "${options.plan.title}", filling the shoebox before writing a word: for every chapter of the plan, the two or three episodes the chapter will be made from.`,
            "An episode is a particular: one named person or body, in one named place, on one date or in one short span, recorded in one document a reader could go and read — a letter, a chronicle, a roll, a statute, a treaty, a trial record, a register, a speech, a memoir, an inscription. It is never a theme, a period or a generalisation. Prefer episodes whose document is in print before 1930 and likely to be online in a public repository (Wikisource, Project Gutenberg, the Internet Archive), because the book will quote from the document itself.",
            "kind says what the chapter will do with it: scene (an event told in time), document (a text read closely), figure (a number or a table worked through), dispute (two named people or works that disagree about it), portrait (one person followed). Give each chapter at least one scene or portrait; vary the kinds across the book.",
            "searchQueries: two or three searches that would find the document's own text in a library catalogue — its title, its author, a distinctive phrase — never a topic. why: one sentence on what the episode lets the chapter show.",
            "Return one JSON object shaped exactly like outputContract, with one entry per chapter of the plan in the plan's order and the plan's index numbers.",
            ...targetLanguageGenerationGuidance(options.input.language)
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              language: targetLanguagePayload(options.input.language),
              book: { title: options.plan.title, premise: options.plan.premise, audience: options.plan.audience },
              stance: { thesis: options.stance.thesis, positions: options.stance.positions },
              chapters: options.plan.chapters.map((chapter) => ({
                index: chapter.index,
                title: chapter.title,
                summary: chapter.summary,
                keyBeats: chapter.keyBeats,
                targetPages: chapter.targetPages
              })),
              outputContract: {
                chapters: [
                  {
                    index: 1,
                    episodes: [
                      {
                        title: "",
                        kind: "scene",
                        person: "",
                        place: "",
                        date: "",
                        document: "",
                        why: "",
                        searchQueries: ["", ""]
                      }
                    ]
                  }
                ]
              }
            },
            null,
            2
          )
        }
      ]
    });
    const known = new Set(options.plan.chapters.map((chapter) => chapter.index));
    const chapters = result.data.chapters.filter((chapter) => known.has(chapter.index));
    if (chapters.length === 0) {
      return { failure: "no chapter of the plan received episodes" };
    }
    return { episodes: { chapters } };
  } catch (error) {
    if (error instanceof Error && /stop|abort/i.test(error.name + error.message)) {
      throw error;
    }
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}
