import type { ChapterEpisode, DossierExcerpt } from "../schemas/episodes.js";
import type { WritingMode } from "../schemas/styleContract.js";
import type { SectionForm } from "./chapterFormPalette.js";
import type { ChapterComposition } from "./chapterForms.js";

/**
 * How a history book names its sources: it mostly doesn't. The writer used to
 * get each dossier passage with its `document` and `url` and be told to "name
 * the document" when quoting, so the 2026-09-30 history books narrated their
 * sources instead of stating facts — "The account at usda.gov says…",
 * "according to *Port Newark: How Malcom McLean Changed the World*", "Mayo and
 * Nohria report that…", "The record describes the containers, but not what
 * they carried". A web result's title is its page title or its bare domain (a
 * PDF has no `<title>`), and the scene call had no `speaker` at all, so the
 * domain was the only name it could give. Hand-labelled over both history
 * books, 48 printed sentences: 11 named a document the dossier never fetched
 * (the episode's planned document, or a section told to close-read it), 9 a
 * web-page title, 8 a later writer as the reporter of a plain fact, 11 a real
 * voice framed as "X's account says", 6 were bare "the record…" talk echoing
 * the prompt's own wording, 3 a domain; research-note domain prefixes put none
 * in print.
 *
 * So a history writer gets each passage with one `source` — who wrote or said
 * it — and no page title or address, states the passages' facts in its own
 * voice, and quotes only the people of the history, by name. Replayed on four
 * stored history chapters, scene and compose chained (Luna, fast and balanced
 * routing, 15 old against 20 new): source-narration sentences 5.5 → 0.5 a
 * chapter; domains 3, web titles 23 and "according to <source>" 9 → none;
 * McLean's own "I had to wait most of the day…" kept in every chapter that had
 * it and the Wall Street Journal's "oldest and sickest industries" 1/3 → 4/5.
 * Blind readers preferred an earlier cut of this wording 18 of 24 times. What
 * it costs: the prose loses its narration padding, so drafts land nearer
 * their minimum (length/minimum 1.06 → 1.04, under-minimum 5/15 → 10/20, each
 * one a length retry) and a thin scene falls under the 80-word floor more
 * often. `analytical-history` is also every SCIENCE, SOCIETY and BIOGRAPHY
 * book. Guides, workbooks and reference books keep the old wording, and
 * fiction has no dossier.
 */
export function writesHistorySources(mode: WritingMode): boolean {
  return mode === "analytical-history";
}

/** Replaces the creative contract's "quote them exactly and name the document" line for a history book. */
export const HISTORY_SOURCE_RULE =
  "Let the particulars of the dossier's passages carry the chapter, stated in your own voice as things that happened: write that the mill opened in 1851 with four hundred looms, never that a record, account, report, biography, entry, document, title or website says so, never \"according to\" one, and never what a source does or does not record or establish. Episodes, the plan and search summaries are leads, not quotations; a document they name that has no passage in `dossier`, even one a section is told to read, is where its facts were found, so tell the facts and leave the document out. Beyond them, write as an author who knows this subject. Do not print internal passage IDs or research-process commentary.";

/**
 * Replaces the `dossier` line for a history book. The first wording ("quote
 * only a voice… that no paraphrase could match") stopped all quoting — 0
 * quotations in 12 replayed chapters — so it names who counts as a voice.
 * The examples are off-subject on purpose, like the rhythm exemplar.
 */
export const HISTORY_DOSSIER_RULE =
  "`dossier` holds verbatim passages, each with `source`, who wrote or said it where that is known. Where a passage gives the words of a participant, an official, a witness or a newspaper of the day, and they carry something a paraphrase would lose, quote them exactly and give them, in the same sentence, to whoever said or wrote them, by name, even when the passage's `source` is a later writer quoting them — “The roof will not stand another winter,” the county surveyor, Samuel Hale, wrote in 1872; the Leeds Mercury called the mill “a palace of noise.” A later writer's plain statement of a fact is not quoted but told as fact. These are the only words you put quotation marks around.";

/** The scene call's `dossier` line for a history book. */
export const HISTORY_SCENE_DOSSIER_RULE =
  "`dossier` holds verbatim passages about this episode, each with `source`, who wrote or said it where that is known. Where a passage gives the words of a participant, an official, a witness or a newspaper of the day, quote them exactly and give them, in the same sentence, to whoever said or wrote them, by name; a later writer's plain statement of a fact is told, not quoted, and nothing else goes in quotation marks. Apart from those quotations, never tell the reader what a record, account, report, document or website says or holds, and never write \"according to\" one.";

/** In place of "Use the episode's document and the research notes": the scene call is given no research notes, and the episode's document is the planner's proposal. */
export const HISTORY_SCENE_USE_RULE = "Do not invent named people or documents.";

/**
 * The nonfiction scene instruction for a history book. The old one told the
 * episode "as an account in time… in the order the record gives it" and ended
 * it "on its last recorded event", and the scenes said so ("The voyage's
 * recorded account ends with the ship's departure"). A wording that also told
 * the writer to stop "where the passages stop" and to tell "the people in it"
 * made Luna return an empty scene 2 times in 6 on the Ideal X passages; this
 * one returned none in 13.
 */
export function historySceneTellLine(episodeTitle: string): string {
  return `Tell the documented episode ${episodeTitle} in time: the actors the passages name, what they did, and what followed, in the order the passages give it. Scene-level detail comes only from a supplied passage. If the supplied passages do not describe this episode, return an empty response with no explanation. Do not turn unrelated source context into an account of the requested event. Do not invent dialogue, private thoughts, remembered objects, gestures, weather or sensory effects, and do not write "would have" to license a detail the passages do not hold. Add a contextual fact only where the reader needs it to identify the episode. Tell it — do not argue it, do not explain what it means, do not say what the chapter or the book will make of it. Begin inside the episode and end on the last event the passages give.`;
}

/**
 * `FOCUSED_RECONSTRUCTION_RULE` for a history book, the same limits said so
 * they are not repeated to the reader. Its last sentence, "If the record
 * supports only a short account, write that account", came back as "The
 * account of the venture is brief" and "The record's central event is brief in
 * outline", and its list of things not to invent came back as disclaimers
 * ("It does not license invented conversations or private reactions", "There
 * is little need to embellish the scene"). On the two replayed chapters with a
 * thin scene such sentences ran 5 in 9 chapters under the old rule, 7 in 15
 * with only an added "these limits are for you, not the reader", 3 in 10 with
 * this wording.
 */
export const HISTORY_RECONSTRUCTION_RULE =
  "When narrating a real event, take its scene-level actions and descriptions only from a supplied passage: dialogue, thoughts, remembered objects, gestures and sensory detail appear only where a passage gives them. General historical knowledge can supply contextual facts and explanation, but a plausible detail is not a witnessed fact. Where the passages hold little, tell that little plainly and go on with the chapter’s explanation; the reader is never told what was left out, what was not invented, or how much survives.";

/** The shape rule's evidence-limit sentence, which let "The record shows X. It does not show Y." stand three times a chapter; a history book keeps only its last clause. */
export const HISTORY_QUESTION_RULE = "Rhetorical questions: at most one per section, never a run of them.";

/**
 * The writer's view of the analytical palette: the scene form without "from a
 * named source or site" and "say what it records". The form planner keeps the
 * palette as it is.
 */
const HISTORY_SCENE_FORM =
  "a documented episode narrated in time through people acting; when the passages hold little, tell that little in a paragraph and move on, and never present an unnamed or composite person as witnessed";

export function historyWriterPalette(palette: readonly SectionForm[]): SectionForm[] {
  return palette.map((form) => (form.id === "scene" ? { ...form, rule: HISTORY_SCENE_FORM } : form));
}

/** Parentheses are the extractor's commentary ("(author not named)"); a URL or a domain is never a name. */
function cleanName(value: string): string {
  return value
    .replace(/\([^)]*\)/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(?:www\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:gov|com|org|edu|net|int|io|ai|uk|eu|sg|br|au|info|pub)\b/giu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "");
}

/** A catalogue writes its authors surname first ("Smith, Adam"); the extractor's `speaker` is prose and is left alone. */
function forenameFirst(author: string): string {
  const parts = author.split(",").map((part) => part.trim());
  return parts.length === 2 && parts[0] && parts[1] && !/\d/.test(parts[1]) ? `${parts[1]} ${parts[0]}` : author;
}

/**
 * Who wrote or said a passage, as the writer may name them: the speaker, else
 * the author, then — for a catalogue work (Wikisource, Gutenberg, archive.org),
 * never a web result — the work's title, and a year only when the catalogue
 * gave a four-digit one (Gutendex's is the author's birth year, "b. 1723").
 * A web result's title is its page title or its bare domain, which is the name
 * the scene call printed ("The account at usda.gov says…").
 */
export function passageSource(excerpt: Pick<DossierExcerpt, "speaker" | "author" | "year" | "documentTitle" | "host">): string {
  const who = cleanName(excerpt.speaker) || cleanName(forenameFirst(excerpt.author));
  const work = excerpt.host === "web" ? "" : cleanName(excerpt.documentTitle);
  const name = [who, work].filter(Boolean).join(", ");
  if (!name) return "";
  const year = excerpt.year.trim();
  return /^\d{4}$/.test(year) ? `${name}, ${year}` : name;
}

/** A history book's dossier as the writer sees it: no title, no address. */
export function historyDossierPayload(excerpts: readonly DossierExcerpt[], options: { ids: boolean }) {
  return excerpts.map((excerpt) => {
    const source = passageSource(excerpt);
    return { ...(options.ids ? { id: excerpt.id } : {}), ...(source ? { source } : {}), text: excerpt.text };
  });
}

const READING_FORMS: ReadonlySet<string> = new Set(["scene", "portrait", "close-reading"]);
/** Share of an owned line's words an episode's title and document must carry for the line to be about it. */
const OWNS_SHARE = 0.6;
const STOP_WORDS: ReadonlySet<string> = new Set([
  "over", "from", "with", "that", "this", "into", "their", "about", "after", "before", "during", "under", "between", "through", "against", "which", "where", "when", "what", "chapter", "episode"
]);

function keyWords(text: string): Set<string> {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  return new Set(words.map((word) => (word.length > 4 ? word.replace(/s$/u, "") : word)));
}

/** How much of the likeliest line of `texts` is about `episode`: a line of fewer than two words says nothing. */
function aboutShare(texts: readonly string[], episode: Pick<ChapterEpisode, "title" | "document">): number {
  const have = keyWords(`${episode.title} ${episode.document}`);
  let best = 0;
  for (const text of texts) {
    const want = [...keyWords(text)];
    if (want.length < 2) continue;
    best = Math.max(best, want.filter((word) => have.has(word)).length / want.length);
  }
  return best;
}

export const UNFETCHED_SECTION_NOTE = "Tell what happened and how it worked, as facts in your own voice, rather than what a document says about it.";

/**
 * A scene, portrait or close reading of an episode no dossier passage came
 * from is told as a mechanism instead, without the owned line that names the
 * document. The form plan is made before the dossier is gathered, so it
 * assigns readings of documents that were never fetched ("What London
 * Docklands redevelopment records reveal…", "UNCTAD's 2021 evidence…"), and
 * the writer performed the assignment by narrating the document ("The London
 * Docklands Development Corporation's records describe…"). Only when the
 * section is more about an unfetched episode than about any fetched one, and
 * only while the chapter has passages at all: without any, `composeChapter`
 * already turns every reading into an argument. Over the eleven stored history
 * chapters it fired on four sections — the LDDC and UNCTAD close readings, a
 * scene of the Alameda Corridor and a portrait of Monden, each an episode with
 * no passage — and on nothing else; replayed on the LDDC chapter, sentences
 * narrating a document went 2.0 → 0.5 a chapter (5 against 10 drafts).
 */
export function withoutUnfetchedReadings(
  composition: ChapterComposition,
  episodes: readonly ChapterEpisode[],
  excerpts: readonly DossierExcerpt[]
): ChapterComposition {
  if (excerpts.length === 0) return composition;
  const fetched = new Set(excerpts.map((excerpt) => excerpt.episodeTitle));
  // A passage filed under a title no episode carries (the extractor misspelled it) may be any episode's: demote nothing.
  if ([...fetched].some((title) => !episodes.some((episode) => episode.title === title))) return composition;
  const unfetched = episodes.filter((episode) => !fetched.has(episode.title));
  if (unfetched.length === 0) return composition;
  const held = episodes.filter((episode) => fetched.has(episode.title));
  let changed = false;
  const sections = composition.sections.map((section) => {
    if (!READING_FORMS.has(section.form)) return section;
    const texts = [section.subject, ...section.owns];
    const missing = Math.max(...unfetched.map((episode) => aboutShare(texts, episode)));
    const present = Math.max(0, ...held.map((episode) => aboutShare(texts, episode)));
    if (missing < OWNS_SHARE || missing <= present) return section;
    changed = true;
    return {
      ...section,
      form: "mechanism",
      owns: section.owns.filter((own) => Math.max(...unfetched.map((episode) => aboutShare([own], episode))) < OWNS_SHARE),
      note: UNFETCHED_SECTION_NOTE
    };
  });
  return changed ? { ...composition, sections } : composition;
}
