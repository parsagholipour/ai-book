import type { BookCategory } from "../categories.js";
import type { ManuscriptStyleProfile } from "../ingestion/manuscriptImport.js";
import { bookPlanSchema, type BookPlan } from "../schemas/book.js";
import type { StudioKind } from "../schemas/mediaSettings.js";

/**
 * The plan an author's book publishes with.
 *
 * Every path downstream of a book — the compile, chat edits, illustrations,
 * continuation, voice calls — reads a `BookPlan`, and an author's book has none
 * of its own: nobody planned it. So publish synthesizes one without a model
 * call, the way the manuscript import always has, from what the Studio knows:
 * the chapters and their page counts, the book's characters, the art style.
 *
 * `illustrationPlan.globalStyle` is sent to the image model with every picture
 * of this book ("Global visual style: …"), so it is the author's art style or a
 * neutral description — never the import's "No illustrations" sentence, which
 * a Studio illustration would otherwise be told to follow.
 */

export const DEFAULT_STUDIO_ART_STYLE =
  "Warm, detailed book illustration with soft natural light, matching the tone of the text";

/** Which book category a Studio book files under. Categories drive covers and fonts, not prose. */
export const STUDIO_KIND_CATEGORY: Record<StudioKind, BookCategory> = {
  story: "STORY",
  nonfiction: "CUSTOM",
  picture: "KIDS",
  other: "CUSTOM"
};

export type AuthorPlanChapter = { title: string; summary: string; pageCount: number };

export type AuthorPlanCharacter = { name: string; role?: string; description: string; visualRules?: string[] };

export function synthesizeAuthorBookPlan(input: {
  title: string;
  subtitle?: string | null | undefined;
  kind?: StudioKind | undefined;
  chapters: readonly AuthorPlanChapter[];
  artStyle?: string | null | undefined;
  characters?: readonly AuthorPlanCharacter[] | undefined;
  style?: ManuscriptStyleProfile | null | undefined;
}): BookPlan {
  const style = input.style ?? null;
  const continuityRules = [
    style && style.pointOfView !== "unknown" ? `Point of view: ${style.pointOfView}.` : null,
    style && style.tense !== "unknown" ? `Narrative tense: ${style.tense}.` : null,
    style && style.tone !== "neutral" ? `Tone: ${style.tone}.` : null,
    "The author's manuscript text is canonical; never contradict it."
  ].filter((rule): rule is string => rule !== null);
  const chapters = input.chapters.length > 0 ? input.chapters : [{ title: input.title, summary: input.title, pageCount: 1 }];
  const artStyle = input.artStyle?.trim() || DEFAULT_STUDIO_ART_STYLE;

  return bookPlanSchema.parse({
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    premise: style?.premise || `A book written by its author: ${input.title}.`,
    audience: style?.audience || (input.kind === "picture" ? "Young children and the adults who read to them" : "General readers"),
    writingComplexity: style?.writingComplexity ?? (input.kind === "picture" ? 2 : 5),
    voiceGuide: style?.voiceGuide || "Match the author's own voice exactly: their diction, rhythm, and paragraphing.",
    antiAiRules: style?.antiAiRules ?? [],
    questions: [],
    chapters: chapters.map((chapter, index) => ({
      index: index + 1,
      title: chapter.title.trim() || `Chapter ${index + 1}`,
      summary: chapter.summary.trim() || chapter.title.trim() || `Chapter ${index + 1}`,
      targetPages: Math.max(1, chapter.pageCount),
      keyBeats: []
    })),
    characters: (input.characters ?? []).map((character) => ({
      name: character.name,
      role: character.role || "character",
      description: character.description,
      traits: [],
      visualRules: character.visualRules ?? []
    })),
    locations: [],
    continuityRules,
    promises: [],
    researchQueries: [],
    researchNotes: [],
    illustrationPlan: {
      cadence: "manual",
      globalStyle: artStyle,
      characterReferencePrompts: [],
      pageRules: []
    }
  });
}
