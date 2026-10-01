import type { SectionForm } from "./chapterFormPalette.js";
import type { ChapterComposition } from "./chapterForms.js";
import type { ChapterMaterial } from "./composedChapterMaterial.js";

/**
 * An opening scene is an assignment, so it is taken back from whoever else
 * held it. `composeScene` tells one of the chapter's episodes ahead of the
 * chapter, and the chapter was still handed that episode three times over: in
 * `episodes` ("give each episode a real stretch"), in the section of the form
 * plan that owns it, and in that section's material. Told not to repeat the
 * scene, the writer obeyed its assignments instead: across the history books
 * of 2026-09-30 half to all of a scene's numbers came back later in the same
 * chapter, and blind readers named it in every round ("the Ideal X voyage is
 * told three times"). The scene does not always sit over the first section —
 * one plan put the voyage third, so the chapter opened on it, went back
 * twenty years and told it again.
 *
 * So the section that treats the told episode becomes its aftermath, the
 * episode leaves `episodes`, and nothing else moves. Only where the palette
 * has an aftermath form, which is the analytical one: a narrative book's
 * scenes ran 480–580 words and its chapters repeated a quarter of their
 * numbers, so its sections are left as planned.
 */
const AFTERMATH = "aftermath";
const NARRATED_FORMS: ReadonlySet<string> = new Set(["scene", "portrait"]);
/** Share of the episode title's words a section must carry to be the one that treats it. */
const TREATS_SHARE = 0.6;
const STOP_WORDS: ReadonlySet<string> = new Set([
  "over", "from", "with", "that", "this", "into", "their", "about", "after", "before", "during", "under", "between", "through", "against", "which", "where", "when", "what"
]);

function keyWords(text: string): Set<string> {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  return new Set(words.map((word) => (word.length > 4 ? word.replace(/s$/u, "") : word)));
}

export function sceneToldNote(episodeTitle: string): string {
  return `The opening scene has already told "${episodeTitle}": what happened, who was there, its dates, figures and quotations. Tell none of it again. This section starts after it, with what it led to and what the rest of this section's material adds.`;
}

export function afterOpeningScene(
  options: { composition: ChapterComposition; material?: ChapterMaterial | undefined },
  palette: readonly SectionForm[]
): { composition: ChapterComposition; material?: ChapterMaterial | undefined } {
  const { composition, material } = options;
  const scene = material?.scene;
  if (!material || !scene || !palette.some((form) => form.id === AFTERMATH)) return { composition, material };
  const wanted = [...keyWords(scene.episodeTitle)];
  const treats = (text: string): number => {
    if (wanted.length === 0) return 0;
    const have = keyWords(text);
    return wanted.filter((word) => have.has(word)).length / wanted.length;
  };
  const scores = composition.sections.map((section) => treats([section.subject, ...section.owns].join(" ")));
  const best = scores.indexOf(Math.max(0, ...scores));
  return {
    composition: (scores[best] ?? 0) < TREATS_SHARE ? composition : {
      ...composition,
      sections: composition.sections.map((section, index) => index !== best ? section : {
        ...section,
        form: NARRATED_FORMS.has(section.form) ? AFTERMATH : section.form,
        owns: section.owns.filter((own) => treats(own) < TREATS_SHARE),
        note: sceneToldNote(scene.episodeTitle)
      })
    },
    material: { ...material, episodes: material.episodes.filter((episode) => episode.title !== scene.episodeTitle) }
  };
}
