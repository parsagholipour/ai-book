import {
  bookSeriesFromMediaSettings,
  extractChapterFacts,
  mediaSettingsWithBookSeries,
  withEndingFacts,
  type BookSeriesSnapshot,
  type CreateProjectInput,
  type TextModelAdapter
} from "@book-maker/core";

import { isStopRequestedError } from "../runtime/jobTypes.js";

/**
 * The series record a plan job enriched with the ending's facts, or undefined
 * when this job took none. The plan job writes it back to the book's row as
 * well as the plan version's snapshot: a chat rebuild copies the row, and a
 * row still carrying the last chapter would pay to read it again.
 */
export function newlyTakenSeriesEndingFacts(before: CreateProjectInput, after: CreateProjectInput): BookSeriesSnapshot | undefined {
  const series = bookSeriesFromMediaSettings(after.mediaSettings);
  if (!series?.endingFactsTaken || bookSeriesFromMediaSettings(before.mediaSettings)?.endingFactsTaken) return undefined;
  return series;
}

/**
 * A continuation's planning input with the facts its earlier book's last
 * chapter fixed.
 *
 * The continuity ledger never reads a book's last chapter — nothing in that
 * book reads its facts — so the snapshot the API copied carries every chapter's
 * facts but the one that ends the story, which is the one a sequel picks up
 * from. Shown the rest as current, a continuation writer keeps a fact the
 * ending changed: E6b's three regressions were exactly that ("held by: Mira"
 * after Sella took the survey). So the planning job reads the chapter once,
 * through the same extraction and the same refusals the ledger uses, and the
 * plan version's input snapshot carries the result to every later job.
 *
 * Best-effort: a failed read plans the book from the facts it has, with the
 * ending excerpt beside them, and a stop travels.
 */
export async function withSeriesEndingFacts(
  input: CreateProjectInput,
  textModel: TextModelAdapter,
  projectId: string
): Promise<CreateProjectInput> {
  const series = bookSeriesFromMediaSettings(input.mediaSettings);
  if (!series || series.mode !== "continuation" || series.endingFactsTaken || !series.finalChapter) {
    return input;
  }
  try {
    const { facts } = await extractChapterFacts({
      title: series.sourceTitle,
      chapterIndex: Math.max(1, series.synopsis.length),
      markdown: series.finalChapter,
      known: series.facts,
      textModel,
      language: input.language
    });
    return { ...input, mediaSettings: mediaSettingsWithBookSeries(input.mediaSettings, withEndingFacts(series, facts)) };
  } catch (error) {
    if (isStopRequestedError(error)) throw error;
    console.warn(`[series] ending facts failed for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    return input;
  }
}
