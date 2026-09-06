import type { ChapterWordBudget } from "./composedChapter.js";
import type { ChapterEpisode, DossierExcerpt, CaseEvidencePacket } from "../schemas/episodes.js";
import { CASE_EVIDENCE_WRITER_RULES } from "./caseEvidence.js";

/**
 * Material-first, as the writer sees it: the contract it writes under, the
 * chapter's episodes and dossier as prompt lines and payload keys, and the
 * budget left once an opening scene has been told. Split from
 * `composedChapter.ts` for the 900-line budget; the compose and edit calls
 * import from here.
 */
export type ComposeContract = "grounded" | "creative";

export type ChapterMaterial = {
  episodes: readonly ChapterEpisode[];
  excerpts: readonly DossierExcerpt[];
  evidencePackets?: readonly CaseEvidencePacket[] | undefined;
  /** The opening scene, composed by `composeScene` before the chapter and printed ahead of it. */
  scene?: { text: string; words: number; episodeTitle: string } | undefined;
  /** Episodes whose full treatment belongs to another chapter: named so the writer refers to them rather than retelling them. */
  reservedCases?: ReadonlyArray<{ chapterIndex: number; episodes: ReadonlyArray<Pick<ChapterEpisode, "title" | "person" | "place" | "date" | "document">> }> | undefined;
};

/** The routing line for `reservedCases`: nothing when no other chapter owns a case. */
export function caseReservationLines(options: { material?: ChapterMaterial | undefined }): string[] {
  if (!options.material?.reservedCases?.length) return [];
  return [
    "reservedCases names episodes whose full treatment belongs to another chapter. Refer to them only briefly when a comparison adds something this chapter needs; do not narrate them again. Develop the mechanisms, decisions, consequences and source details of this chapter's own episodes instead."
  ];
}

/**
 * The creative contract's rules, in place of the grounded factuality rule and
 * the citation contract. Reconstruction is permitted and marked; quotation
 * marks stay a promise the quote guard can check.
 */
export const CREATIVE_CONTRACT_RULES = [
  "researchNotes are a starting point, not a boundary. You are an author who knows this subject: draw on your own knowledge for the people, places, dates, documents, objects and numbers that make a page particular, and prefer the telling detail to the safe generality.",
  "Quotation marks are a promise. Put them only around words you are confident were said or written in that form, and say who said them; otherwise give the sense in your own words without marks. A number you are not sure of is given as a range or with \"about\". Never attribute to a named person a work or a remark that is not theirs."
];

export const CREATIVE_RECONSTRUCTION_RULE =
  "A scene may be told as it happened: a named person in a named place on a day, with what they saw, said and did, reconstructed from what the record makes likely. Where you reconstruct rather than report, let the grammar say so once — \"would have\", \"by his own account\", \"as the register has it\" — and then tell it plainly. Never present an invented person as a real one; a type (\"a clerk of the customs house\") is named as a type.";

export type ComposedChapterText = { markdown: string; words: number; attempts: number };


/** The chapter's budget less the scene already written for it. */
export function remainingBudget(budget: ChapterWordBudget, sceneWords: number): ChapterWordBudget {
  if (sceneWords <= 0) return budget;
  const floor = Math.max(300, Math.round(budget.perPage * 1.5));
  return {
    perPage: budget.perPage,
    min: Math.max(floor, budget.min - sceneWords),
    target: Math.max(floor, budget.target - sceneWords),
    max: Math.max(floor + 200, budget.max - sceneWords)
  };
}

/**
 * System lines for the editor pass. The editor needs the case evidence rules
 * and case reservations, but not the compose-time opening-scene instructions
 * that materialLines() adds.
 */
export function materialEditLines(options: { material?: ChapterMaterial | undefined }): string[] {
  return [
    ...(options.material?.evidencePackets?.length ? CASE_EVIDENCE_WRITER_RULES : []),
    ...caseReservationLines(options),
  ];
}

/**
 * Material-first: the writer's lines about the chapter's episodes, its
 * dossier and the scene already written. Content assignments per chapter,
 * never a shape rule, and named in the payload keys (`episodes`, `dossier`,
 * `openingScene`) so the writer does not have to spell them from prose.
 */
export function materialLines(options: { material?: ChapterMaterial | undefined }): string[] {
  const material = options.material;
  if (!material) return [];
  const lines = [
    "This chapter is built from the episodes in `episodes`: each is a person, a place, a date and a document from the record, and the chapter's sections are made from them — an episode told in time, a document read closely, a figure worked through — with the argument arising from the material rather than the material illustrating the argument. Give each episode a real stretch of the chapter, not a mention."
  ];
  if (material.episodes.length === 0) lines.length = 0;
  lines.push(...caseReservationLines(options));
  if (material.evidencePackets?.length) lines.push(...CASE_EVIDENCE_WRITER_RULES);
  if (material.excerpts.length > 0) {
    lines.push(
      "`dossier` holds verbatim passages from primary sources, each with the document it comes from. Quote from them — a phrase, a sentence, up to a whole passage — with quotation marks and the document named, wherever a passage says something better than you could; these are the only words you put quotation marks around. Paraphrase the rest of what they say freely."
    );
  }
  if (material.scene) {
    lines.push(
      `The chapter's first ${material.scene.words} words are already written and printed: \`openingScene\`, the episode "${material.scene.episodeTitle}" told as a scene. Do not rewrite, repeat or summarise it. Begin where it stops — its last paragraph is still on the reader's page — and let the first thing you write follow from it.`
    );
  }
  return lines;
}

export function materialPayload(options: { material?: ChapterMaterial | undefined }) {
  const material = options.material;
  if (!material) return {};
  return {
    episodes: material.episodes.map((episode) => ({
      title: episode.title,
      kind: episode.kind,
      who: episode.person,
      where: episode.place,
      when: episode.date,
      document: episode.document,
      why: episode.why
    })),
    ...(material.reservedCases?.length
      ? {
          reservedCases: material.reservedCases.map((entry) => ({
            chapterIndex: entry.chapterIndex,
            episodes: entry.episodes.map(({ title, person, place, date, document }) => ({ title, person, place, date, document }))
          }))
        }
      : {}),
    ...(material.evidencePackets?.length ? { caseEvidence: material.evidencePackets } : {}),
    ...(material.excerpts.length > 0
      ? {
          dossier: material.excerpts.map((excerpt) => ({
            id: excerpt.id,
            document: excerpt.documentTitle,
            ...(excerpt.author ? { author: excerpt.author } : {}),
            ...(excerpt.year ? { year: excerpt.year } : {}),
            ...(excerpt.speaker ? { speaker: excerpt.speaker } : {}),
            text: excerpt.text
          }))
        }
      : {}),
    ...(material.scene ? { openingScene: material.scene.text } : {})
  };
}
