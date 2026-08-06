/**
 * The one definition of what a "rebuild this book differently" request changes.
 *
 * A structural edit ("make it 3 pages without illustrations") names generation
 * settings, not prose. Those settings have to be resolved once and then agree in
 * four places that run at different times and in different processes: the quote
 * the user is shown, the charge, the copied project row, and the plan the worker
 * revises. When they disagreed, the request was priced as the old book and
 * planned as the old book while only the images half landed.
 *
 * Hence one applier here, in the leaf package both `apps/api` and `apps/worker`
 * can import — `apps/api` cannot import the worker, and the worker must not be
 * the first place a setting takes effect.
 */

import { mediaSettingsSchema, type CreateProjectInput, type MediaSettings } from "../schemas/book.js";

/**
 * Generation settings a replan request asked to change. Every field is optional
 * and absent means "keep what the book already has" — a replan that only
 * changes the premise must not quietly resize or de-illustrate the book.
 */
export type ReplanSettings = {
  targetPages?: number | undefined;
  fullIllustrations?: boolean | undefined;
  includeCover?: boolean | undefined;
};

export type NegativeMediaPreference = {
  disableIllustrations: boolean;
  disableCover: boolean;
};

/**
 * Reads "no pictures" out of a request. One-way by design: there is no positive
 * form, because turning images back on changes what a book costs and that
 * belongs to an explicit settings change rather than to a sentence.
 */
export function negativeMediaPreferenceFromMessage(message: string): NegativeMediaPreference | null {
  const normalized = message.replace(/\s+/g, " ").trim();
  const negativeMedia = /\b(?:i\s+(?:do\s+not|don't|dont)\s+want|no|without|skip|remove|disable|turn\s+off)\b.{0,80}\b(?:images?|covers?|visuals?|illustrations?|artwork|pictures?)\b/i.test(
    normalized
  );
  if (!negativeMedia) {
    return null;
  }

  const cover = /\bcovers?\b/i.test(normalized);
  const broadImages = /\b(?:images?|visuals?|artwork|pictures?)\b/i.test(normalized);
  const illustrations = /\billustrations?\b/i.test(normalized);
  return {
    disableIllustrations: broadImages || illustrations,
    disableCover: cover || broadImages
  };
}

/** The same reader as {@link negativeMediaPreferenceFromMessage}, as settings. */
export function replanSettingsFromMessage(message: string): ReplanSettings {
  const preference = negativeMediaPreferenceFromMessage(message);
  if (!preference) {
    return {};
  }
  return {
    ...(preference.disableIllustrations ? { fullIllustrations: false } : {}),
    ...(preference.disableCover ? { includeCover: false } : {})
  };
}

const TARGET_PAGE_PATTERNS = [
  /\b(\d{1,3})\s*[- ]?\s*(?:page|pages|pg|pgs)\s*(?:book|ebook|story|guide|workbook|project|plan)?\b/gi,
  /\b(?:make|create|write|build|draft|set|keep|turn)\s+(?:it|this|the\s+book|the\s+story|the\s+guide)?\s*(?:to|at|as)?\s*(\d{1,3})\s*(?:page|pages|pg|pgs)\b/gi,
  /\b(?:page|pages|pg|pgs)\s*(?:count|length)?\s*(?:is|=|:|to|should\s+be)?\s*(\d{1,3})\b/gi
];

/**
 * The book length a piece of prose asks for, or undefined.
 *
 * Shared between the creation chat, which sizes a book before it exists, and the
 * book-edit chat, which routes "make it 3 pages" as a whole-book replan. The two
 * have to agree on what a length request looks like, or the same sentence sizes
 * a book on the way in and is ignored forever after.
 *
 * The last match wins: a message that revises itself ("8 pages, actually make it
 * 3 pages") means the number it ended on.
 */
export function explicitTargetPagesFromText(text: string): number | undefined {
  const matches = TARGET_PAGE_PATTERNS.flatMap((pattern) => capturePageCounts(text, pattern));
  for (const value of matches.reverse()) {
    if (Number.isInteger(value) && value >= 1 && value <= 600) {
      return value;
    }
  }
  return undefined;
}

function capturePageCounts(text: string, pattern: RegExp): number[] {
  const matches: number[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(value)) {
      matches.push(value);
    }
  }
  return matches;
}

export function isEmptyReplanSettings(settings: ReplanSettings | null | undefined): boolean {
  return (
    !settings ||
    (settings.targetPages === undefined &&
      settings.fullIllustrations === undefined &&
      settings.includeCover === undefined)
  );
}

/**
 * Applies a replan's settings to a media-settings object.
 *
 * `mobile.imagesEnabled` is derived rather than passed in: the mobile metadata
 * has a single flag for what the settings sheet draws, so it stays true when a
 * cover survives a "no illustrations" request.
 *
 * `targetPages` is written into that metadata too, alongside the mode and source
 * the creation flow writes for a chat-chosen count — the app reads its length
 * from `mobile.targetPages`, so a book left holding the old number would go on
 * describing itself as the length nobody asked for.
 */
export function mediaSettingsWithReplanSettings(
  mediaSettings: MediaSettings,
  settings: ReplanSettings | null | undefined
): MediaSettings {
  if (isEmptyReplanSettings(settings) || !settings) {
    return mediaSettings;
  }
  const fullIllustrations = settings.fullIllustrations ?? mediaSettings.fullIllustrations;
  const includeCover = settings.includeCover ?? mediaSettings.includeCover;
  return mediaSettingsSchema.parse({
    ...mediaSettings,
    fullIllustrations,
    includeCover,
    // Only restate the source when the request actually spoke about the cover:
    // "no cover" means a free designed one, but a replan that never mentioned it
    // must not promote an operator's explicit "none" back into a cover.
    ...(settings.includeCover === undefined ? {} : { coverArtSource: includeCover ? "ai" : "design" }),
    illustrationCadence: fullIllustrations ? mediaSettings.illustrationCadence : "manual",
    ...(mediaSettings.mobile === undefined
      ? {}
      : {
          mobile: {
            ...jsonRecord(mediaSettings.mobile),
            imagesEnabled: fullIllustrations || includeCover,
            ...(settings.targetPages === undefined
              ? {}
              : {
                  targetPages: settings.targetPages,
                  lengthPreset: "custom",
                  pageCountMode: "custom",
                  pageCountSource: "chat"
                })
          }
        })
  });
}

/** The same settings applied to the input the planner and the cost estimate read. */
export function inputWithReplanSettings(
  input: CreateProjectInput,
  settings: ReplanSettings | null | undefined
): CreateProjectInput {
  if (isEmptyReplanSettings(settings) || !settings) {
    return input;
  }
  return {
    ...input,
    ...(settings.targetPages === undefined ? {} : { targetPages: settings.targetPages }),
    mediaSettings: mediaSettingsWithReplanSettings(input.mediaSettings, settings)
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
