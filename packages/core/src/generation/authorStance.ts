import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import { kidsReadingGuidanceLines } from "../prompting/readingLevel.js";
import { authorStanceSchema, type AuthorStance, type BookPlan, type CreateProjectInput } from "../schemas/book.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { inferWritingMode, type WritingMode } from "./styleContract.js";

/**
 * The author the composed-chapters strategy writes as.
 *
 * The per-page pipeline steered prose with a list of prohibitions — about
 * twenty-five system sentences and two dozen plan `antiAiRules`, nearly all
 * "do not". A model told on every page to leap to no conclusion and to use
 * uncertainty only where earned writes the responsible, qualified,
 * mechanism-listing paragraph every time, which is the shape the blind
 * reviewers scored 4.5/10 for naturalness. A stance replaces the list with
 * what a human author brings: a thesis, positions with the alternative they
 * reject, habits refused, and a sample of the voice. Models imitate a sample
 * far better than they obey a negative rule.
 */

export const AUTHOR_STANCE_PURPOSE = "author-stance";

const NARRATIVE_MODES: ReadonlySet<WritingMode> = new Set(["narrative", "children-narrative"]);

export function isNarrativeWritingMode(mode: WritingMode): boolean {
  return NARRATIVE_MODES.has(mode);
}

/** What the planner is asked to put in `authorStance`, mode-agnostic. */
export const PLANNER_AUTHOR_STANCE_GUIDANCE = [
  "Also return authorStance, the author this book is written by: thesis (one sentence the whole book argues about its subject, stated as a fact about the world and never as a rule about how to read evidence, weigh sources or make comparisons — a method is not a thesis, and a writer given one performs it in every paragraph; or for fiction what the story is about underneath its events), positions (three to five plain assertions the author holds about the subject, each a string stating a fact the author is prepared to defend, none of them about method or evidence, with no rejected alternative named), refusals (two to four habits the author refuses, such as ending a section by balancing both sides, listing more than three examples in one sentence, or restating a point already made), and voiceSample (180 to 260 words written as this author on a subject adjacent to the book but not in it).",
  "In the voiceSample every sentence names a particular — a place, a person, a year, an object, a document — and no sentence states a general truth, opens on a common noun with a claim about it, or is built as a negation followed by its correction; paragraphs and sentences are of visibly different lengths. It demonstrates diction and stance for the writer, never text for the book."
];

/** The sample the writer is shown has to be prose about particulars, or its aphorisms become the book's. */
export const VOICE_SAMPLE_RULES = [
  "voiceSample: 180 to 260 words written as this author on a subject adjacent to the book but not in it.",
  "Every sentence of the sample names a particular: a place, a person, a year, an object, a document. No sentence states a general truth. No sentence opens on a common noun with a claim about it (never \"A boundary is easiest to notice when someone crosses it\"). No sentence is built as a negation followed by its correction (never \"did not simply X; it Y\", \"was never only an X\", \"not X but Y\").",
  "Show the rhythm: at least one paragraph under forty words and one over one hundred and twenty; at least one sentence under six words and one over thirty. When the author holds a view it is stated plainly. End on a particular."
];

/** A stance the pass can write from: stands to commit to and a sample long enough to carry a voice. */
export const MIN_STANCE_POSITIONS = 2;
export const MIN_VOICE_SAMPLE_WORDS = 80;

function stanceShapeLines(mode: WritingMode): string[] {
  if (isNarrativeWritingMode(mode)) {
    return [
      "thesis: what the story is about underneath its events, in one sentence a reader would never be told outright.",
      "positions: three to five narrative commitments, each concrete: whose perception the narration lives inside, what it notices and what it withholds, what it never explains, how it treats time, and the strongest conventional choice it rejects.",
      "refusals: two to four habits refused, such as ending a scene on a reflection, letting a character state the theme, opening consecutive scenes on weather or waking, or summarising feelings the scene already showed."
    ];
  }
  return [
    "thesis: the one claim the whole book argues about its subject, in one sentence, stated as a fact about the world — never a rule about how to read evidence, weigh sources or make comparisons, which a writer performs in every paragraph.",
    "positions: three to five plain assertions the author holds about the subject, each stated as a fact the author is prepared to defend, none about method or evidence, without naming a rejected alternative.",
    "refusals: two to four habits refused, such as ending a section by balancing both sides, listing more than three examples in one sentence, restating a distinction already drawn, or reaching for 'institutions', 'mechanisms' or 'arrangements' where a particular thing can be named."
  ];
}

export async function generateAuthorStance(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  textModel: TextModelAdapter;
}): Promise<AuthorStance> {
  const mode = inferWritingMode(options.input, options.plan);
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: AUTHOR_STANCE_PURPOSE,
    temperature: Math.min(0.9, Math.max(0.6, options.input.temperature)),
    maxTokens: 2400,
    schema: authorStanceSchema,
    messages: [
      {
        role: "system",
        content: [
          "You are the author of the book described in the payload, deciding before you write what you believe and how you sound.",
          "Return one JSON object with thesis, positions, refusals, and voiceSample.",
          ...stanceShapeLines(mode),
          ...VOICE_SAMPLE_RULES,
          "The sample demonstrates diction and stance for a writer; it must not be a passage of the book, an introduction, or a description of the book.",
          "positions is required and holds at least three entries; a stance with no positions is unusable.",
          "Do not mention AI, prompts, plans, JSON, schemas, or generation.",
          ...targetLanguageGenerationGuidance(options.input.language),
          ...kidsReadingGuidanceLines(options.input)
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            language: targetLanguagePayload(options.input.language),
            book: {
              title: options.plan.title,
              premise: options.plan.premise,
              audience: options.plan.audience,
              category: options.input.category,
              subcategory: options.input.subcategory,
              writingMode: mode,
              writingComplexity: options.plan.writingComplexity,
              voiceGuide: options.plan.voiceGuide,
              chapters: options.plan.chapters.map((chapter) => ({ index: chapter.index, title: chapter.title, summary: chapter.summary })),
              promises: options.plan.promises
            },
            userPrompt: options.input.prompt,
            outputContract: {
              thesis: "One sentence.",
              positions: ["Three to five plain assertions the author holds, each one string, no rejected alternative."],
              refusals: ["Two to four habits refused."],
              voiceSample: "180 to 260 words as the author, on an adjacent subject."
            }
          },
          null,
          2
        )
      }
    ]
  });
  return result.data;
}

/** The stance as prompt lines for the writer and the editor. */
/**
 * A fixed passage, on nothing the book is about, showing how paragraphs and
 * sentences can move: a long narrated stretch, a two-sentence paragraph, a
 * plain assertion, particulars throughout, no sentence that balances two
 * sides. The generated voice sample was a third to a half contrastive
 * antitheses, and the writer imitated the sample's move rather than its
 * diction (composed-1's aphorisms, composed-3's antitheses). Written for this
 * purpose; not a quotation.
 */
export const RHYTHM_EXEMPLAR = [
  "The pump on the green at Little Wenlock was cast in 1836 by a foundry in Coalbrookdale, and for sixty years it was the only water most of the village drank. Women came to it at first light with two pails on a yoke, the older ones in clogs, and waited their turn along the wall of the smithy while the handle rose and fell. The iron was cold enough in January to take the skin off a wet palm. Children were sent for the second pail after school and stopped at the churchyard gate on the way back to look at the sexton's cart, which was always there, because the sexton was also the carrier and kept his horse in the churchyard for want of anywhere else. In summer the flow slowed to a thread by the end of August, and the waiting line grew quiet, and the vicar's wife, who kept a diary, wrote down each year the day the pump first ran dry.",
  "It ran dry on the ninth of September in 1868. The diary says nothing else about that week.",
  "The village had a piped supply by 1897, paid for by a subscription the squire started and the chapel finished, and the pump stayed where it was because nobody would pay to take it away. Its handle is chained now. The chain was put on in 1911 after a boy called Thomas Pryce broke his wrist on it, and the parish minutes record the cost of the chain, one shilling and fourpence, and the name of the man who fitted it.",
  "Nobody recorded the boy's side of it."
].join("\n\n");

/**
 * The position a chapter writes from. Shown all five, every chapter of
 * composed-7 restated all five — the technology-extends-reach line, the
 * economic-insufficiency move, the limits-of-evidence caveat — and the panel
 * named each one as a refrain; one lens per chapter, rotated, is a content
 * assignment rather than a rule about shape.
 */
export function chapterPosition(stance: AuthorStance, chapterIndex: number): string | undefined {
  if (stance.positions.length === 0) {
    return undefined;
  }
  const slot = ((Math.max(1, Math.floor(chapterIndex)) - 1) % stance.positions.length + stance.positions.length) % stance.positions.length;
  return stance.positions[slot];
}

export function authorStancePromptLines(
  stance: AuthorStance,
  mode: WritingMode,
  options: { chapterIndex?: number | undefined } = {}
): string[] {
  const kind = isNarrativeWritingMode(mode) ? "story" : "book";
  const position = options.chapterIndex === undefined ? undefined : chapterPosition(stance, options.chapterIndex);
  return [
    `You are this ${kind}'s author. What it argues underneath everything, which the prose never states outright: ${stance.thesis}`,
    ...(position
      ? [`What you hold to be true, and write this chapter from, without stating it as a sentence of its own: ${position}`]
      : stance.positions.length > 0
        ? [`What you hold to be true, and write from: ${stance.positions.join(" | ")}`]
        : []),
    `A passage unrelated to this book, showing how paragraphs and sentences can move — a long narrated stretch, a two-sentence paragraph, a plain assertion, particulars throughout. Take its movement, never its subject or its sentences: "${RHYTHM_EXEMPLAR}"`
  ];
}

export function planAuthorStance(plan: BookPlan): AuthorStance | undefined {
  const stance = plan.authorStance;
  if (!isRecord(stance)) {
    return undefined;
  }
  const parsed = authorStanceSchema.safeParse(stance);
  if (!parsed.success) {
    return undefined;
  }
  // The first composed book's plan came with `positions: []` and a sample made
  // of aphorisms; the writer, with nothing else to imitate, imitated the
  // aphorisms. A stance the pass cannot write from is regenerated instead.
  if (parsed.data.positions.length < MIN_STANCE_POSITIONS) {
    return undefined;
  }
  if (parsed.data.voiceSample.trim().split(/\s+/).length < MIN_VOICE_SAMPLE_WORDS) {
    return undefined;
  }
  return parsed.data;
}
