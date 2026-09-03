import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import type { ChapterEpisode, DossierExcerpt } from "../schemas/episodes.js";
import type { AuthorStance } from "../schemas/plan.js";
import { authorStancePromptLines } from "./authorStance.js";
import { normalizeChapterMarkdown } from "./chapterPagination.js";
import { CREATIVE_CONTRACT_RULES, type ComposeContract } from "./composedChapter.js";
import { countReadableWords } from "./proseShape.js";
import { inferWritingMode } from "./styleContract.js";

/**
 * The scene call: one episode told as a scene, in a narrating register, by a
 * call whose whole job is to narrate. The same writer asked to argue a chapter
 * writes analysis whatever it is told about scenes; asked only to tell one
 * episode, it tells it. The scene is printed as the chapter's opening and the
 * compose call continues from it (`ChapterMaterial.scene`).
 */
export const COMPOSE_SCENE_PURPOSE = "compose-scene";

export const SCENE_TARGET_WORDS = 700;
const SCENE_MIN_WORDS = 300;

export type ComposedScene = { text: string; words: number; episodeTitle: string };

/** The episode a chapter opens on: the first scene or portrait, else nothing. */
export function openingEpisode(episodes: readonly ChapterEpisode[]): ChapterEpisode | undefined {
  return episodes.find((episode) => episode.kind === "scene" || episode.kind === "portrait");
}

export async function composeScene(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  chapter: ChapterPlan;
  episode: ChapterEpisode;
  excerpts: readonly DossierExcerpt[];
  contract: ComposeContract;
  textModel: TextModelAdapter;
  targetWords?: number | undefined;
}): Promise<ComposedScene | undefined> {
  const target = options.targetWords ?? SCENE_TARGET_WORDS;
  const mode = inferWritingMode(options.input, options.plan);
  const excerpts = options.excerpts.filter((excerpt) => !excerpt.episodeTitle || excerpt.episodeTitle === options.episode.title);
  const systemLines = [
    `You are writing the opening of chapter ${options.chapter.index}, "${options.chapter.title}", of the book "${options.plan.title}", as its author.`,
    ...authorStancePromptLines(options.stance, mode, { exemplarOnly: true }),
    `Tell one episode as a scene in time: ${options.episode.title}. A named person in a named place on a day, doing, seeing and saying; the reader is there. Tell it — do not argue it, do not explain what it means, do not say what the chapter or the book will make of it. Begin inside the episode, not before it, and end on its last event, not on a reflection.`,
    excerpts.length > 0
      ? "`dossier` holds verbatim passages from the record of this episode. Quote from them with quotation marks and the document named — a phrase, a line, a whole passage where it is better than anything you could write — and put quotation marks around nothing else."
      : "Quotation marks are a promise: put them only around words you are confident were said or written in that form.",
    ...(options.contract === "creative" ? [CREATIVE_CONTRACT_RULES[0]!] : ["Use the episode's document and the research notes; do not invent named people or documents."]),
    "Where you reconstruct rather than report, let the grammar say so once — \"would have\", \"by his own account\", \"as the register has it\" — and then tell it plainly.",
    `Write between ${Math.round(target * 0.75)} and ${Math.round(target * 1.3)} words, aiming for ${target}. Paragraphs of visibly different lengths; no heading, no title, no summary, no epigraph. Return only the scene's prose.`,
    ...targetLanguageGenerationGuidance(options.input.language)
  ];
  const payload = {
    language: targetLanguagePayload(options.input.language),
    episode: {
      title: options.episode.title,
      who: options.episode.person,
      where: options.episode.place,
      when: options.episode.date,
      document: options.episode.document,
      why: options.episode.why
    },
    ...(excerpts.length > 0
      ? {
          dossier: excerpts.map((excerpt) => ({
            document: excerpt.documentTitle,
            ...(excerpt.author ? { author: excerpt.author } : {}),
            ...(excerpt.year ? { year: excerpt.year } : {}),
            text: excerpt.text
          }))
        }
      : {}),
    chapter: { title: options.chapter.title, summary: options.chapter.summary }
  };
  let best: ComposedScene | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await options.textModel.generateText({
      purpose: COMPOSE_SCENE_PURPOSE,
      temperature: options.input.temperature,
      maxTokens: Math.min(16_000, Math.round(target * 4) + 4000),
      messages: [
        { role: "system", content: systemLines.join(" ") },
        { role: "user", content: JSON.stringify(payload, null, 2) }
      ]
    });
    const text = normalizeChapterMarkdown(result.text.trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, "$1"), { chapterTitle: options.chapter.title });
    const words = countReadableWords(text);
    if (!best || words > best.words) best = { text, words, episodeTitle: options.episode.title };
    if (words >= SCENE_MIN_WORDS) break;
  }
  return best && best.words >= SCENE_MIN_WORDS ? best : undefined;
}
