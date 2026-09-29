import {
  runQuickAuthorAssist,
  withRecoverableNetworkRetry,
  type AuthorAssistBook,
  type QuickAuthorAssistRequest,
  type QuickAuthorAssistResult,
  type StudioKind,
  type TextModelAdapter
} from "@book-maker/core";
import { withTimeout } from "../../withTimeout.js";
import { castAssistCharacters, loadCastCharacters } from "./manuscriptCast.js";
import type { ManuscriptProject } from "./manuscriptDerivation.js";
import { manuscriptSource, parseManuscriptSettings, styleProfileFromMediaSettings } from "./manuscriptStore.js";

/**
 * The Writing Studio's quick assists (spec "Quick assists"): rewrite, fix,
 * continue, describe, what-happens-next and ask. One model call each, run
 * inside the request because the author is waiting on it with a cursor in the
 * text. The route meters it as one chat message; this module only builds what
 * the core runner reads and bounds how long it may take.
 */

/** The request's own ceiling. The app's client timeout is 45 s, so the answer lands first. */
export const QUICK_ASSIST_BUDGET_MS = 40_000;

/**
 * An imported book never chose a Studio kind, so its working copy reads
 * "other"; the runner's voice rules are better served by the category the
 * import filed it under.
 */
function assistKind(project: Pick<ManuscriptProject, "mediaSettings" | "category">, settingsKind: StudioKind): StudioKind {
  if (manuscriptSource(project.mediaSettings) !== "imported") {
    return settingsKind;
  }
  return project.category === "STORY" || project.category === "KIDS" ? "story" : "nonfiction";
}

/** The book as the runners see it: title, kind, language, voice, cast and layout. */
export async function studioAssistBook(project: ManuscriptProject, manuscriptSettings: unknown): Promise<AuthorAssistBook> {
  const settings = parseManuscriptSettings(manuscriptSettings);
  const cast = await loadCastCharacters(project.userId, settings.castCharacterIds);
  const characters = castAssistCharacters(cast);
  return {
    title: project.title,
    kind: assistKind(project, settings.kind),
    language: project.language,
    styleProfile: styleProfileFromMediaSettings(project.mediaSettings),
    ...(characters.length > 0 ? { characters } : {}),
    layout: settings.layout
  };
}

/**
 * One quick assist, time-boxed, with one retry of a network failure.
 *
 * `withTimeout` does not cancel what it races, so the time box also aborts the
 * provider call through the runner's signal: a call nobody will read must not
 * keep a connection (and its tokens) running. Whatever the runner throws is
 * the caller's to map — `AuthorAssistInputError` is the author's (400), every
 * other failure is the service's (503).
 */
export async function runStudioQuickAssist(options: {
  textModel: TextModelAdapter;
  request: QuickAuthorAssistRequest;
  budgetMs?: number;
}): Promise<QuickAuthorAssistResult> {
  const controller = new AbortController();
  const budgetMs = options.budgetMs ?? QUICK_ASSIST_BUDGET_MS;
  const work = withRecoverableNetworkRetry(
    () => runQuickAuthorAssist(options.request, { textModel: options.textModel, signal: controller.signal }),
    { attempts: 2, delayMs: 500, maxDelayMs: 1_000 }
  );
  try {
    return await withTimeout(work, budgetMs, "Writing Studio assist");
  } finally {
    // Settled either way: a no-op after success, the cancellation after a
    // time-out (the abandoned promise's rejection is then nobody's).
    controller.abort();
    work.catch(() => undefined);
  }
}
