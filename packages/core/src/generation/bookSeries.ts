/**
 * A book that belongs to a series: a continuation of one of the reader's own
 * finished books, or a new story inspired by one.
 *
 * The link is a copy, never a foreign key, exactly as a library character is:
 * at Build the API snapshots what the new book needs from the earlier one —
 * its cast, places, rules, voice, look, the facts its chapters fixed and how
 * it ended — into `mediaSettings.mobile.series`, and everything downstream
 * reads that copy off the input snapshot. Deleting the earlier book therefore
 * cannot break the later one, and editing it after Build changes nothing the
 * later one was planned against.
 *
 * Who reads what, and why so little reaches the writers:
 * - the planner gets the whole record (`planSeriesGuidance`), because the plan
 *   is where continuity is decided — returning cast, chapter summaries that
 *   start after the old ending, rules that still hold;
 * - every writer of a continuation gets the earlier book's facts as a
 *   consistency list and nothing to retell (`seriesWriterFields`), and only
 *   the call that writes the opening gets the old ending. Handing writers the
 *   earlier text itself was measured inside one book (E7: earlier chapters in
 *   full halved contradictions and lost on taste), and a field present in every
 *   chapter is performed, so the recap is what an over-generous block buys;
 * - `reconcilePlanSeries` holds the first plan to the two things that must not
 *   drift whatever the model wrote: the illustration style and a returning
 *   character's look. A revision is the reader asking for a change, so it is
 *   told to keep both unless asked and is never reverted by code.
 */

import { z } from "zod";
import type { BookPlan } from "../schemas/book.js";
import { jsonRecord, mediaSettingsMobileRecord } from "../schemas/jsonCoercion.js";
import { chapterFactLines, storedChapterFact, type ChapterFact } from "./chapterFacts.js";
import { figureFreeProse } from "./figures/figureBlocks.js";
import { foldCharacterName } from "./libraryCharacters.js";

/** How a new book relates to the earlier one it was linked to. */
export const BOOK_SERIES_MODES = ["continuation", "inspired"] as const;
export type BookSeriesMode = (typeof BOOK_SERIES_MODES)[number];

/** What a creation chat may answer; "standalone" is the answer that links nothing. */
export const SERIES_CHOICE_MODES = ["continuation", "inspired", "standalone"] as const;
export type SeriesChoiceMode = (typeof SERIES_CHOICE_MODES)[number];

export function isSeriesChoiceMode(value: unknown): value is SeriesChoiceMode {
  return typeof value === "string" && (SERIES_CHOICE_MODES as readonly string[]).includes(value);
}

/**
 * Every bound of the snapshot. It rides `mediaSettings` on the project row and
 * every plan version's input snapshot, and the planner reads all of it, so each
 * field is capped where it is built rather than trusted to be small.
 */
export const BOOK_SERIES_LIMITS = {
  name: 160,
  premise: 1200,
  synopsisLines: 24,
  synopsisLine: 360,
  characters: 12,
  characterName: 80,
  characterRole: 120,
  characterDescription: 500,
  visualRules: 6,
  visualRule: 300,
  locations: 8,
  locationDescription: 400,
  rules: 12,
  rule: 300,
  voiceGuide: 8,
  illustrationStyle: 600,
  facts: 160,
  /** The planner's and the opening writer's view of how the earlier book ended. */
  ending: 2400,
  /** A short book is carried whole: a picture book is shorter than most endings plus synopsis. */
  fullText: 9000,
  /** The earlier book's last chapter, read once for the facts its own ledger never took. */
  finalChapter: 12000,
  maxBookNumber: 99
} as const;

/** The planner's budget for the earlier book's facts, a share of the composed ledger's own 6,000. */
const PLANNER_FACTS_MAX_CHARACTERS = 4000;
/** A writer's budget: the facts sit beside this book's own ledger and must not crowd it out. */
const WRITER_FACTS_MAX_CHARACTERS = 2500;

const factSchema = z.object({
  subject: z.string().min(1),
  attribute: z.string().default(""),
  value: z.string().min(1)
});

const seriesCharacterSchema = z.object({
  name: z.string().trim().min(1).max(BOOK_SERIES_LIMITS.characterName),
  role: z.string().max(BOOK_SERIES_LIMITS.characterRole).default(""),
  description: z.string().max(BOOK_SERIES_LIMITS.characterDescription).default(""),
  visualRules: z.array(z.string().max(BOOK_SERIES_LIMITS.visualRule)).max(BOOK_SERIES_LIMITS.visualRules).default([])
});

const seriesLocationSchema = z.object({
  name: z.string().trim().min(1).max(BOOK_SERIES_LIMITS.characterName),
  description: z.string().max(BOOK_SERIES_LIMITS.locationDescription).default("")
});

export const bookSeriesSnapshotSchema = z.object({
  version: z.literal(1),
  mode: z.enum(BOOK_SERIES_MODES),
  sourceProjectId: z.string().min(1),
  sourceTitle: z.string().trim().min(1).max(BOOK_SERIES_LIMITS.name),
  /** The series' name: the earlier book's own series when it had one, else its title. */
  seriesName: z.string().trim().min(1).max(BOOK_SERIES_LIMITS.name),
  /** A continuation's place in the series; an inspired book is not numbered. */
  bookNumber: z.number().int().min(2).max(BOOK_SERIES_LIMITS.maxBookNumber).optional(),
  premise: z.string().max(BOOK_SERIES_LIMITS.premise).default(""),
  synopsis: z.array(z.string().max(BOOK_SERIES_LIMITS.synopsisLine)).max(BOOK_SERIES_LIMITS.synopsisLines).default([]),
  characters: z.array(seriesCharacterSchema).max(BOOK_SERIES_LIMITS.characters).default([]),
  locations: z.array(seriesLocationSchema).max(BOOK_SERIES_LIMITS.locations).default([]),
  continuityRules: z.array(z.string().max(BOOK_SERIES_LIMITS.rule)).max(BOOK_SERIES_LIMITS.rules).default([]),
  voiceGuide: z.array(z.string().max(BOOK_SERIES_LIMITS.rule)).max(BOOK_SERIES_LIMITS.voiceGuide).default([]),
  /** The style the earlier book's pictures were drawn in; absent when no model drew any. */
  illustrationStyle: z.string().max(BOOK_SERIES_LIMITS.illustrationStyle).optional(),
  facts: z.array(factSchema).max(BOOK_SERIES_LIMITS.facts).default([]),
  ending: z.string().max(BOOK_SERIES_LIMITS.ending).optional(),
  fullText: z.string().max(BOOK_SERIES_LIMITS.fullText).optional(),
  finalChapter: z.string().max(BOOK_SERIES_LIMITS.finalChapter).optional(),
  /** Set once the planning job has read `finalChapter` into `facts`, so a re-plan does not pay again. */
  endingFactsTaken: z.boolean().optional(),
  /** The earlier book's page design, pinned so a picture book's sequel wears the same pages. */
  storyPageDesign: z.string().max(64).optional(),
  /** The earlier book's designed cover, reused so the series' covers match. */
  coverDesignId: z.string().max(64).optional()
});

export type BookSeriesSnapshot = z.infer<typeof bookSeriesSnapshotSchema>;
export type BookSeriesCharacter = z.infer<typeof seriesCharacterSchema>;

/** The tolerant read: a book with no series, or one stored by a newer shape, is a book with none. */
export function bookSeriesFromMediaSettings(mediaSettings: unknown): BookSeriesSnapshot | undefined {
  const raw = mediaSettingsMobileRecord(mediaSettings).series;
  if (raw === undefined) return undefined;
  const parsed = bookSeriesSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** `mediaSettings` with `mobile.series` replaced: the planning job's in-memory input once the ending's facts are read. */
export function mediaSettingsWithBookSeries<T>(mediaSettings: T, series: BookSeriesSnapshot): T {
  const record = jsonRecord(mediaSettings);
  return { ...record, mobile: { ...jsonRecord(record.mobile), series } } as T;
}

/**
 * The same input without the series record, for prompts that serialize the
 * whole input as JSON (`userInput`): those prompts get the record from
 * `planSeriesGuidance` in readable form, and sending it twice buys nothing.
 */
export function withoutBookSeriesRecord<T extends { mediaSettings: unknown }>(input: T): T {
  const record = jsonRecord(input.mediaSettings);
  const mobile = jsonRecord(record.mobile);
  if (!("series" in mobile)) return input;
  const { series: _series, ...rest } = mobile;
  return { ...input, mediaSettings: { ...record, mobile: rest } };
}

// ---------------------------------------------------------------------------
// Building the snapshot (pure; the API loads the rows)
// ---------------------------------------------------------------------------

export type BookSeriesSource = {
  projectId: string;
  title: string;
  mode: BookSeriesMode;
  /** The earlier book's own series record, when it was itself part of one. */
  sourceSeries?: BookSeriesSnapshot | undefined;
  plan: Pick<BookPlan, "premise" | "chapters" | "characters" | "locations" | "continuityRules" | "voiceGuide" | "illustrationPlan">;
  /** Whether a model drew any of the earlier book's pictures (its cover or its pages). */
  drewPictures: boolean;
  /** The printed chapters, in order: their titles and summaries, and the facts the ledger stored for each. */
  chapters: ReadonlyArray<{ title: string; summary: string; facts?: unknown }>;
  /** The page texts in reading order. */
  pages: readonly string[];
  /** The final chapter's page texts, when the book is divided into chapters. */
  finalChapterPages?: readonly string[] | undefined;
  storyPageDesign?: string | undefined;
  coverDesignId?: string | undefined;
};

export function buildBookSeriesSnapshot(source: BookSeriesSource): BookSeriesSnapshot {
  const continuation = source.mode === "continuation";
  const title = clip(source.title, BOOK_SERIES_LIMITS.name) || "Untitled";
  // Only a continuation joins its source's line: a book that was itself only
  // inspired by another starts a series of its own when it is continued.
  const inherited = source.sourceSeries?.mode === "continuation" ? source.sourceSeries : undefined;
  const seriesName = clip(inherited?.seriesName ?? title, BOOK_SERIES_LIMITS.name) || title;
  const previousNumber = inherited ? inherited.bookNumber ?? 2 : 1;
  const text = source.pages.map(pageProse).filter(Boolean);
  const wholeText = text.join("\n\n");
  const finalChapterText = (source.finalChapterPages ?? []).map(pageProse).filter(Boolean).join("\n\n");
  const synopsis = (source.chapters.length > 0 ? source.chapters : source.plan.chapters)
    .map((chapter) => [cleanLine(chapter.title), cleanLine(chapter.summary)].filter(Boolean).join(": "))
    .filter(Boolean)
    .slice(0, BOOK_SERIES_LIMITS.synopsisLines)
    .map((line) => clip(line, BOOK_SERIES_LIMITS.synopsisLine));
  const facts = continuation
    ? source.chapters.flatMap((chapter) =>
        (Array.isArray(chapter.facts) ? chapter.facts : []).flatMap((raw) => {
          const fact = storedChapterFact(raw);
          return fact && fact.subject.trim() && fact.value.trim() ? [fact] : [];
        })
      )
    : [];
  const carriesWholeText = continuation && wholeText.length > 0 && wholeText.length <= BOOK_SERIES_LIMITS.fullText;
  const style = source.drewPictures ? clip(source.plan.illustrationPlan.globalStyle, BOOK_SERIES_LIMITS.illustrationStyle) : "";
  return bookSeriesSnapshotSchema.parse({
    version: 1,
    mode: source.mode,
    sourceProjectId: source.projectId,
    sourceTitle: title,
    seriesName,
    ...(continuation ? { bookNumber: Math.min(BOOK_SERIES_LIMITS.maxBookNumber, previousNumber + 1) } : {}),
    premise: clip(source.plan.premise, BOOK_SERIES_LIMITS.premise),
    // An inspired book does not continue the earlier one's events, so it is
    // handed none of them.
    synopsis: continuation ? synopsis : [],
    characters: source.plan.characters.slice(0, BOOK_SERIES_LIMITS.characters).map((character) => ({
      name: clip(character.name, BOOK_SERIES_LIMITS.characterName) || "Unnamed character",
      role: clip(character.role, BOOK_SERIES_LIMITS.characterRole),
      description: clip(character.description, BOOK_SERIES_LIMITS.characterDescription),
      visualRules: character.visualRules
        .map((rule) => clip(rule, BOOK_SERIES_LIMITS.visualRule))
        .filter(Boolean)
        .slice(0, BOOK_SERIES_LIMITS.visualRules)
    })),
    locations: source.plan.locations.slice(0, BOOK_SERIES_LIMITS.locations).map((location) => ({
      name: clip(location.name, BOOK_SERIES_LIMITS.characterName) || "Unnamed place",
      description: clip(location.description, BOOK_SERIES_LIMITS.locationDescription)
    })),
    continuityRules: boundedRules(source.plan.continuityRules, BOOK_SERIES_LIMITS.rules),
    voiceGuide: boundedRules(source.plan.voiceGuide, BOOK_SERIES_LIMITS.voiceGuide),
    ...(style ? { illustrationStyle: style } : {}),
    facts: facts.slice(-BOOK_SERIES_LIMITS.facts),
    ...(continuation && wholeText ? { ending: tail(wholeText, BOOK_SERIES_LIMITS.ending) } : {}),
    ...(carriesWholeText ? { fullText: wholeText } : {}),
    // The ledger never reads a book's last chapter (nothing in that book reads
    // its facts), so a continuation would otherwise know nothing its ending
    // changed — E6b's stale-fact failure. A book short enough to travel whole
    // needs no extraction: the planner reads the whole of it.
    ...(continuation && !carriesWholeText && finalChapterText
      ? { finalChapter: tail(finalChapterText, BOOK_SERIES_LIMITS.finalChapter) }
      : {}),
    ...(source.storyPageDesign ? { storyPageDesign: source.storyPageDesign } : {}),
    ...(source.coverDesignId ? { coverDesignId: source.coverDesignId } : {})
  });
}

/** The snapshot after the planning job read the earlier book's last chapter: its facts appended, the text dropped. */
export function withEndingFacts(series: BookSeriesSnapshot, facts: readonly ChapterFact[]): BookSeriesSnapshot {
  const { finalChapter: _finalChapter, ...rest } = series;
  return {
    ...rest,
    facts: [...series.facts, ...facts.map((fact) => ({ ...fact }))].slice(-BOOK_SERIES_LIMITS.facts),
    endingFactsTaken: true
  };
}

// ---------------------------------------------------------------------------
// The project prompt
// ---------------------------------------------------------------------------

/**
 * One line for the book's prompt. The prompt is what every writer reads as the
 * reader's request, so this is the one place a writer that gets no series
 * block still learns that the book is a sequel — and is told not to recap.
 */
export function seriesPromptLine(series: BookSeriesSnapshot): string {
  if (series.mode === "inspired") {
    return `Series: this is a new, standalone story inspired by the user's earlier book "${series.sourceTitle}" — the same world, tone and look, with its returning characters — and it does not continue that book's events.`;
  }
  const place = series.bookNumber ? `book ${series.bookNumber} of the series "${series.seriesName}"` : `part of the series "${series.seriesName}"`;
  return `Series: this is ${place}. It continues the user's earlier book "${series.sourceTitle}", which its readers have read: keep its characters, world and established facts, pick up after its ending, and never recap it.`;
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/**
 * The planner-facing rules and the earlier book's record, inline for the same
 * reason the library characters are: a revision's payload carries no input,
 * so a pointer into `userInput` would point a replan at nothing.
 */
export function planSeriesGuidance(
  series: BookSeriesSnapshot | undefined,
  options: { revision?: boolean } = {}
): string[] {
  if (!series) return [];
  const record = seriesRecordLines(series, { facts: series.mode === "continuation" });
  // The first plan is held to the style and the looks by code; a revision is
  // the reader's own request, so it keeps them only where the reader did not
  // ask otherwise.
  const style = !series.illustrationStyle
    ? []
    : options.revision
      ? ["Keep illustrationPlan.globalStyle and each returning character's look as the earlier book had them, unless the user's message asks to change them."]
      : ["Set illustrationPlan.globalStyle to the illustration style above, word for word."];
  if (series.mode === "inspired") {
    return [
      `The user wants this book inspired by their earlier book "${series.sourceTitle}": a new, standalone story in the same world and spirit — the same tone and voice, setting and look, with the returning characters below — that neither continues nor depends on that book's events. Its record:`,
      ...record,
      "Keep every returning character's name exactly as written and their look as recorded; keep the world's places and the earlier book's voice unless the user asked for a change. Do not retell or summarize the earlier book's plot anywhere in the plan. New characters, places and a new conflict are expected.",
      ...style
    ];
  }
  const numbered = series.bookNumber ? `book ${series.bookNumber} of the series "${series.seriesName}"` : `a book of the series "${series.seriesName}"`;
  return [
    `This is ${numbered}: it continues the user's earlier book "${series.sourceTitle}", which its readers have read. The earlier book's record:`,
    ...record,
    "Plan a new story that follows on from where that book ended. Keep every returning character's name exactly as written, with their relations, history and look; keep the world's places and rules; respect every established fact unless this book's own events change it, and let the earlier book's ending decide where each character now stands.",
    "Do not retell or recap the earlier book's plot in any chapter summary or the openingHook: page 1 opens in this book's story, and later chapters refer back only where the new story needs it. Keep the earlier book's voice and tone unless the user asked for a change. New characters, places and a new conflict are expected.",
    ...style,
    `Unless the user gave a subtitle, set subtitle to name the series and this book's place in it, written in the book's language (for example "${series.seriesName}, Book ${series.bookNumber ?? 2}").`
  ];
}

function seriesRecordLines(series: BookSeriesSnapshot, options: { facts: boolean }): string[] {
  const lines: string[] = [];
  if (series.premise) lines.push(`Premise: ${series.premise}`);
  if (options.facts && series.fullText) {
    lines.push(`The whole earlier book:\n${series.fullText}`);
  } else if (options.facts && series.synopsis.length > 0) {
    lines.push(`What happened, chapter by chapter: ${series.synopsis.join(" | ")}`);
  }
  if (series.characters.length > 0) {
    lines.push(
      `Cast: ${series.characters
        .map((character) => {
          const look = character.visualRules.length > 0 ? ` Look: ${character.visualRules.join("; ")}.` : "";
          return `"${character.name}" — ${[character.role, character.description].filter(Boolean).join(": ")}.${look}`;
        })
        .join(" ")}`
    );
  }
  if (series.locations.length > 0) {
    lines.push(`Places: ${series.locations.map((location) => [location.name, location.description].filter(Boolean).join(": ")).join(" | ")}`);
  }
  if (series.continuityRules.length > 0) lines.push(`World and continuity rules: ${series.continuityRules.join(" | ")}`);
  if (series.voiceGuide.length > 0) lines.push(`Voice: ${series.voiceGuide.join(" | ")}`);
  if (series.illustrationStyle) lines.push(`Illustration style: ${series.illustrationStyle}`);
  if (options.facts) {
    const facts = chapterFactLines(series.facts, { maxCharacters: PLANNER_FACTS_MAX_CHARACTERS });
    if (facts.length > 0) lines.push(`Established facts: ${facts.join(" ")}`);
    if (series.ending && !series.fullText) lines.push(`How it ended:\n${series.ending}`);
  }
  return lines;
}

/**
 * What must not drift whatever the planner wrote, applied to the first plan
 * and before the library reconcile — a saved character's own record outranks
 * the earlier book's, because the library is the reader's latest word on them.
 * Not applied to a revision: "make the art watercolor" is the reader's call,
 * and code reverting it would be the stale-answer bug in another field.
 */
export function reconcilePlanSeries(plan: BookPlan, series: BookSeriesSnapshot | undefined): BookPlan {
  if (!series) return plan;
  const looks = new Map(
    series.characters
      .filter((character) => character.visualRules.length > 0)
      .map((character) => [foldCharacterName(character.name), character.visualRules] as const)
  );
  const characters = plan.characters.map((character) => {
    const look = looks.get(foldCharacterName(character.name));
    return look ? { ...character, visualRules: [...look] } : character;
  });
  const style = series.illustrationStyle?.trim();
  return {
    ...plan,
    characters,
    illustrationPlan: style ? { ...plan.illustrationPlan, globalStyle: style } : plan.illustrationPlan
  };
}

// ---------------------------------------------------------------------------
// The writers
// ---------------------------------------------------------------------------

/** Every writer's line about the earlier book's facts. */
export const SERIES_WRITER_RULE =
  "previousBook is the earlier book this one continues; its readers have read it. previousBook.facts is what that book fixed, one line per person, place or thing. It is for consistency, not material: wherever this text touches one of them, keep it as listed — the same name, role, relation, age, place and event. Never bring a fact in because it is listed, never recap the earlier book or retell its events, and refer back to it in a clause only where this story needs it. A returning character is never introduced again.";

/** The opening writer's line about where the earlier book left off. */
export const SERIES_OPENING_RULE =
  "previousBook.ending is how the earlier book ended. This book opens after it and agrees with it — where a character is, what they know, what has changed — without retelling or summarizing it.";

export type SeriesWriterPayload = {
  previousBook?: { title: string; facts: string[]; ending?: string };
};

/**
 * The block a writer of a continuation gets, or nothing. `opening` is true for
 * the call that writes the book's first page; `mentionText` keeps the facts
 * about whoever this call names when the list has to be cut.
 */
export function seriesWriterFields(
  input: { mediaSettings: unknown },
  options: { opening: boolean; mentionText?: string | undefined }
): { rules: string[]; payload: SeriesWriterPayload } {
  const series = bookSeriesFromMediaSettings(input.mediaSettings);
  if (!series || series.mode !== "continuation") return { rules: [], payload: {} };
  const facts = chapterFactLines(series.facts, { mentionText: options.mentionText, maxCharacters: WRITER_FACTS_MAX_CHARACTERS });
  const ending = options.opening ? series.ending : undefined;
  return {
    rules: [SERIES_WRITER_RULE, ...(ending ? [SERIES_OPENING_RULE] : [])],
    payload: { previousBook: { title: series.sourceTitle, facts, ...(ending ? { ending } : {}) } }
  };
}

// ---------------------------------------------------------------------------

function pageProse(markdown: string): string {
  return figureFreeProse(markdown)
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function boundedRules(rules: readonly string[], max: number): string[] {
  return rules.map((rule) => clip(rule, BOOK_SERIES_LIMITS.rule)).filter(Boolean).slice(0, max);
}

function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string | undefined, max: number): string {
  const line = cleanLine(value ?? "");
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** The last `max` characters, cut forward to a paragraph or sentence start so the excerpt does not open mid-word. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const paragraph = cut.indexOf("\n\n");
  if (paragraph >= 0 && paragraph < max / 3) return cut.slice(paragraph + 2).trim();
  const sentence = cut.search(/[.!?…]\s/);
  return (sentence >= 0 && sentence < max / 3 ? cut.slice(sentence + 1) : cut).trim();
}
