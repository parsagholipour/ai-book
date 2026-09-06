import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import { bookDossierSchema, bookEpisodesSchema, type BookDossier, type BookEpisodes, type ChapterEpisode } from "../schemas/episodes.js";
import type { AuthorStance } from "../schemas/plan.js";
import { isNarrativeWritingMode } from "./authorStance.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { applyFocusContract, episodeCollisions, focusContractIssues, focusFeedbackLines } from "./planContract.js";
import { inferWritingMode } from "./styleContract.js";

/**
 * Material-first, step one: the episodes. One call plans two or three
 * episodes per chapter — a person, a place, a date and a document from the
 * record — before any prose exists, so that every chapter has something to
 * put on the page and the argument is found in the material rather than the
 * material illustrating the argument (opinion-fable-5 §3).
 */
export const PLAN_EPISODES_PURPOSE = "plan-episodes";

export {
  EPISODE_KINDS,
  bookDossierSchema,
  bookEpisodesSchema,
  chapterEpisodeSchema,
  chapterFocusSchema,
  dossierExcerptSchema,
  type BookDossier,
  type BookEpisodes,
  type ChapterEpisode,
  type ChapterFocus,
  type DossierExcerpt,
  type EpisodeKind
} from "../schemas/episodes.js";

/**
 * The focus, for the books that argue: each chapter investigates its own
 * question with its own material, so the book covers different causal
 * questions instead of reenacting one thesis through different cases. A
 * narrative book plans no focus.
 */
const CHAPTER_FOCUS_RULES = [
  "focus is the chapter's explanatory assignment, answered from its assigned episodes. question asks one distinct explanatory question and names the assigned material. investigation lists two to five concrete things the chapter works out in full: a sequence of decisions, resources and logistics, incentives, the alternatives open at the time, costs, aftermath, how an inference is made from the record. contribution states, as one claim about the chapter's material, what the reader will know happened and why — never a distinction between two ways of reading evidence, and never a sentence built on 'rather than', 'distinguish', 'separate … from' or 'what X can and cannot establish'. alreadyEstablished names the answers earlier chapters have settled, which this chapter need not argue again.",
  "Across the book the focuses cover different causal questions drawn from the user's request; do not turn every chapter into proof of the same thesis or a reminder that a source is limited. A later chapter changes, refines or tests an earlier chapter's explanation with its new material. A focus is a subject assignment, never a compulsory order of scene, comparison or recap. Where the stance's positions would have a chapter repeat a claim, the focus decides what the chapter investigates, within the scope the user asked for.",
  "Write investigation as concrete questions whose answers require new events, decisions, quantities, consequences or close examination of a particular passage. General reminders that institutions matter, choices existed, categories overlap or sources are limited are already-established knowledge, not investigation topics. Some chapters follow one case through a consequential sequence; others need a genuine comparison or a worked explanation. Let the material choose. question asks what happened or why, about the assigned material; it never asks what the evidence can or cannot establish."
];

/** The episodes a plan stores, or nothing. */
export function planEpisodesFromPlan(plan: BookPlan): BookEpisodes | undefined {
  const stored = (plan as { episodes?: unknown }).episodes;
  if (!isRecord(stored)) return undefined;
  const parsed = bookEpisodesSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

/** The dossier a plan stores, or nothing. */
export function planDossierFromPlan(plan: BookPlan): BookDossier | undefined {
  const stored = (plan as { dossier?: unknown }).dossier;
  if (!isRecord(stored)) return undefined;
  const parsed = bookDossierSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

export function episodesForChapter(episodes: BookEpisodes | undefined, chapterIndex: number): ChapterEpisode[] {
  return episodes?.chapters.find((chapter) => chapter.index === chapterIndex)?.episodes ?? [];
}

/**
 * What the plan contract found and did. The re-ask is one extra call at most,
 * and nothing here may fail a book: a contract that cannot be satisfied is
 * recorded and the plan proceeds.
 */
export type EpisodePlanContract = {
  reasked: boolean;
  issuesBefore: number;
  collisionsBefore: number;
  issuesAfter: number;
  collisionsAfter: number;
  dropped: Array<{ chapterIndex: number; title: string; reason: string }>;
  blanked: Array<{ chapterIndex: number; kind: "question" | "contribution" | "investigation" }>;
};

export type PlanEpisodesResult = {
  episodes?: BookEpisodes | undefined;
  failure?: string | undefined;
  contract?: EpisodePlanContract | undefined;
};

export async function planEpisodes(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  textModel: TextModelAdapter;
  evidenceRequired?: boolean | undefined;
  feedback?: string[] | undefined;
  /**
   * Whether the chapter focus is planned at all (the `chapterFocus` gate).
   * `false` plans none — the writer then composes the rung-5 way, from the
   * stance and the chapter's episodes. Absent or `true` is today's rule: a
   * focus for every book that argues.
   */
  focus?: boolean | undefined;
}): Promise<PlanEpisodesResult> {
  const focused = options.focus !== false && !isNarrativeWritingMode(inferWritingMode(options.input, options.plan));
  const ask = async (feedback: string[] | undefined): Promise<BookEpisodes | undefined> => {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: PLAN_EPISODES_PURPOSE,
      temperature: Math.min(0.6, options.input.temperature),
      maxTokens: 12_000,
      schema: bookEpisodesSchema,
      messages: [
        {
          role: "system",
          content: [
            focused
              ? `You are the author of "${options.plan.title}", filling the shoebox before writing a word: for every chapter of the plan, the distinct documented episodes the chapter will be made from. Choose one to four documented episodes per chapter according to the question and available material. One well-documented episode may carry most of a chapter; another may be a short comparison. Vary the number and the depth of treatment across the book. Do not build a repeated three-case survey. In why, state what work the episode does and whether it needs sustained treatment or a brief supporting use.`
              : `You are the author of "${options.plan.title}", filling the shoebox before writing a word: for every chapter of the plan, the distinct documented episodes the chapter will be made from — three or four for a chapter of eight or more pages, two or three for a shorter one.`,
            "An episode is a particular documented case, event, worked result or text relevant to this book. It is never a theme, a period or a generalisation. Identify a document the reader could consult. Prefer accessible original records or authoritative expositions; do not force historical anecdotes into an instructional or technical book. Public repositories include Wikisource, Project Gutenberg and the Internet Archive.",
            "kind says what the chapter will do with it: scene (an event told in time), document (a text read closely), figure (a number or a table worked through), dispute (two named people or works that disagree about it), portrait (one person followed). Choose the treatment the evidence supports. A scene is optional.",
            ...(options.evidenceRequired ? ["Every central case must subsequently pass source verification. Select cases with accessible substantive documentation, not famous names used as decoration. If feedback names unavailable cases, choose different documented material serving the same requested coverage."] : []),
            "searchQueries: two or three searches that would find the document's own text in a library catalogue — its title, its author, a distinctive phrase — never a topic. why: one sentence on what the episode lets the chapter show.",
            "Select each case for one chapter only: its full account belongs where it makes the strongest contribution. When neighboring chapter scopes overlap, give them different documented episodes. The why field names a concrete question or mechanism this episode adds that the other chapters do not already explain; avoid another illustration of the book's general thesis. The final chapter needs fresh material that tests the earlier explanation, rather than a tour of the preceding cases.",
            ...(focused ? CHAPTER_FOCUS_RULES : []),
            "Return one JSON object shaped exactly like outputContract, with one entry per chapter of the plan in the plan's order and the plan's index numbers.",
            ...targetLanguageGenerationGuidance(options.input.language)
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              language: targetLanguagePayload(options.input.language),
              userPrompt: options.input.prompt,
              book: { title: options.plan.title, premise: options.plan.premise, audience: options.plan.audience },
              stance: { thesis: options.stance.thesis, positions: options.stance.positions },
              ...(feedback?.length ? { feedback } : {}),
              chapters: options.plan.chapters.map((chapter) => ({
                index: chapter.index,
                title: chapter.title,
                summary: chapter.summary,
                keyBeats: chapter.keyBeats,
                targetPages: chapter.targetPages
              })),
              outputContract: {
                chapters: [
                  {
                    index: 1,
                    episodes: [
                      {
                        title: "",
                        kind: "scene",
                        person: "",
                        place: "",
                        date: "",
                        document: "",
                        why: "",
                        searchQueries: ["", ""]
                      }
                    ],
                    ...(focused ? { focus: { question: "", investigation: ["", ""], contribution: "", alreadyEstablished: [] } } : {})
                  }
                ]
              }
            },
            null,
            2
          )
        }
      ]
    });
    const known = new Set(options.plan.chapters.map((chapter) => chapter.index));
    const chapters = result.data.chapters.filter((chapter) => known.has(chapter.index));
    return chapters.length === 0 ? undefined : { chapters };
  };
  try {
    const first = await ask(options.feedback);
    if (!first) {
      return { failure: "no chapter of the plan received episodes" };
    }
    // One re-ask, with the offending fields and the colliding chapters named,
    // then a deterministic clean-up of whatever comes back. A distinction
    // assigned as a chapter's payoff is performed in every paragraph of it.
    const issues = focusContractIssues(first);
    const collisions = episodeCollisions(first);
    let episodes = first;
    let reasked = false;
    if (issues.length > 0 || collisions.length > 0) {
      reasked = true;
      try {
        const second = await ask([...(options.feedback ?? []), ...focusFeedbackLines(issues, collisions)]);
        if (second) episodes = second;
      } catch (error) {
        if (error instanceof Error && /stop|abort/i.test(error.name + error.message)) {
          throw error;
        }
      }
    }
    const applied = applyFocusContract(episodes);
    return {
      episodes: applied.episodes,
      contract: {
        reasked,
        issuesBefore: issues.length,
        collisionsBefore: collisions.length,
        issuesAfter: focusContractIssues(applied.episodes).length,
        collisionsAfter: episodeCollisions(applied.episodes).length,
        dropped: applied.dropped,
        blanked: applied.blanked
      }
    };
  } catch (error) {
    if (error instanceof Error && /stop|abort/i.test(error.name + error.message)) {
      throw error;
    }
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}
