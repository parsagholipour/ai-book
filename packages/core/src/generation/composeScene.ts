import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import type { ChapterEpisode, DossierExcerpt, CaseEvidencePacket } from "../schemas/episodes.js";
import { CASE_EVIDENCE_WRITER_RULES } from "./caseEvidence.js";
import type { AuthorStance } from "../schemas/plan.js";
import { authorStancePromptLines, isNarrativeWritingMode } from "./authorStance.js";
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
 *
 * Nonfiction tells the episode as an account of what the record holds: no
 * passage of the record, no scene; a short passage, a short account. Three
 * blind readers found invented particulars in every cinematic opening.
 */
export const COMPOSE_SCENE_PURPOSE = "compose-scene";

export const SCENE_TARGET_WORDS = 700;
const SCENE_MIN_WORDS = 300;
/** Nonfiction: the shortest account kept; anything less is no scene rather than a padded one. */
export const ACCOUNT_MIN_WORDS = 80;

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
  evidencePackets?: readonly CaseEvidencePacket[] | undefined;
}): Promise<ComposedScene | undefined> {
  const target = options.targetWords ?? SCENE_TARGET_WORDS;
  const mode = inferWritingMode(options.input, options.plan);
  const narrative = isNarrativeWritingMode(mode);
  const excerpts = options.excerpts.filter((excerpt) => !excerpt.episodeTitle || excerpt.episodeTitle === options.episode.title);
  const packets = options.evidencePackets?.filter((packet) => packet.episode.title === options.episode.title);
  if (options.evidencePackets && (!packets?.length || !packets.some((packet) => packet.sequence.length >= 2))) return undefined;
  // Nonfiction with no passage of the record has nothing witnessed to tell;
  // model knowledge supplies context, never the detail a scene is made of.
  if (!narrative && excerpts.length === 0) return undefined;
  const rhythm = "Paragraphs of visibly different lengths; no heading, no title, no summary, no epigraph. Return only the scene's prose.";
  const systemLines = [
    `You are writing the opening of chapter ${options.chapter.index}, "${options.chapter.title}", of the book "${options.plan.title}", as its author.`,
    ...authorStancePromptLines(options.stance, mode, { exemplarOnly: true }),
    packets?.length
      ? `Narrate the documented sequence of ${options.episode.title} through the recorded choices and consequences. Use only actors, actions and dates supported by caseEvidence. Dialogue or sensory detail may appear only when a supplied passage records it. Do not add a cinematic setting or speculate to meet the length target.`
      : narrative
        ? `Tell one episode as a scene in time: ${options.episode.title}. A named person in a named place on a day, doing, seeing and saying; the reader is there. Tell it — do not argue it, do not explain what it means, do not say what the chapter or the book will make of it. Begin inside the episode, not before it, and end on its last event, not on a reflection.`
        : `Tell the documented episode ${options.episode.title} as an account in time: the recorded actors, what they did, and what followed, in the order the record gives it. Scene-level detail comes only from a supplied passage. If the supplied passages do not describe this episode, return an empty response with no explanation. Do not turn unrelated source context into an account of the requested event. Do not invent dialogue, private thoughts, remembered objects, gestures, weather or sensory effects, and do not write "would have" to license a detail the record does not hold. Add a contextual fact only where the reader needs it to identify the episode. Tell it — do not argue it, do not explain what it means, do not say what the chapter or the book will make of it. Begin inside the episode and end on its last recorded event.`,
    excerpts.length > 0
      ? "`dossier` holds verbatim passages from the record of this episode. Quote from them with quotation marks and the document named — a phrase, a line, a whole passage where it is better than anything you could write — and put quotation marks around nothing else."
      : "Quotation marks are a promise: put them only around words you are confident were said or written in that form.",
    ...(narrative && options.contract === "creative" ? [CREATIVE_CONTRACT_RULES[0]!] : ["Use the episode's document and the research notes; do not invent named people or documents."]),
    ...(packets?.length
      ? CASE_EVIDENCE_WRITER_RULES
      : narrative
        ? ["Where you reconstruct rather than report, let the grammar say so once — \"would have\", \"by his own account\", \"as the register has it\" — and then tell it plainly."]
        : []),
    narrative
      ? `Write between ${Math.round(target * 0.75)} and ${Math.round(target * 1.3)} words, aiming for ${target}. ${rhythm}`
      : `Write up to ${target} words; a short source warrants a short account. Do not invent or reiterate material to reach a minimum. ${rhythm}`,
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
    chapter: { title: options.chapter.title, summary: options.chapter.summary },
    ...(packets?.length ? { caseEvidence: packets } : {})
  };
  // Narrative may try once more for length; nonfiction is one call, a short
  // account kept as it is and never asked to fill a minimum.
  const attempts = narrative ? 2 : 1;
  const minWords = narrative ? SCENE_MIN_WORDS : ACCOUNT_MIN_WORDS;
  let best: ComposedScene | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
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
    if (words >= minWords) break;
  }
  return best && best.words >= minWords ? best : undefined;
}
