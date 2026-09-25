import { z } from "zod";
import type { GenerateJsonOptions } from "../adapters/types.js";
import type { CreateProjectInput, PageDraft, PageQualityReport } from "../schemas/book.js";
import { kidsReadingGuidanceForInput } from "../prompting/readingLevel.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { applyPagePatches, pagePatchSchema } from "./pagePatchEdit.js";
import { countReadableWords, splitSentences } from "./proseShape.js";
import { pageQaProviderCallMetadata } from "./pageQaRewriteTelemetry.js";
import type { ReviewPageOptions, RevisePageOptions } from "./pagesReview.js";

/** Immutable meaning baseline for a local syntax repair; never an approval override. */
export type SentenceLengthRepair = { originalMarkdown: string; issues: string[] };

const sentenceIssue = /^(?:Page \d+: )?(?:Fix: )?Sentences are too long for ages [246]-[468] \(average [\d.]+ words, longest \d+; target average <= \d+, longest <= \d+\)\.$/;

export function sentenceLengthRepairFor(input: CreateProjectInput, draft: Pick<PageDraft, "markdown">, report: PageQualityReport): SentenceLengthRepair | undefined {
  const issues = [...report.issues, ...report.requiredRevisions];
  if (!kidsReadingGuidanceForInput(input) || report.approved || issues.length === 0 ||
    report.unsupportedClaims.length > 0 || issues.some((issue) => !sentenceIssue.test(issue.trim()))) return undefined;
  return { originalMarkdown: draft.markdown, issues: [...new Set(report.issues)] };
}

const responseSchema = z.object({ patches: z.array(pagePatchSchema).max(12) }).strict();

// Require an explicit verdict and complete checks. The general review schema
// recovers partial provider responses and can infer approval from a score.
const sentenceReviewSchema = z.object({
  approved: z.boolean(),
  score: z.number().int().min(0).max(100),
  issues: z.array(z.string()),
  requiredRevisions: z.array(z.string()),
  notes: z.string(),
  groundedOk: z.boolean().default(true),
  unsupportedClaims: z.array(z.string()).default([]),
  checks: z.object({
    placeholderFree: z.boolean(), promptLeakFree: z.boolean(), titleClean: z.boolean(),
    repetitionOk: z.boolean(), progressionOk: z.boolean(), styleNatural: z.boolean()
  })
});

/** Judge the edit against its meaning baseline; manuscript review owns existing story defects. */
export function buildSentenceRepairReviewPrompt(options: ReviewPageOptions): GenerateJsonOptions<PageQualityReport> {
  return {
    purpose: "review-page",
    ...(options.signal ? { signal: options.signal } : {}),
    temperature: 0.15,
    maxTokens: 1800,
    schema: sentenceReviewSchema,
    messages: [
      { role: "system", content: [
        "Review only the sentence-length repair by comparing draft with sentenceRepair.originalMarkdown.",
        "Approve only when sentences read naturally at the supplied reading level and preserve every event, character, reader-facing name, object, quantity, location, causal order, negation, uncertainty, dialogue meaning and handoff in the original prose.",
        "Reject introduced repetition, contradictions, fragments, unnatural rhythm, lost meaning or added filler. Quote original and candidate evidence for each rejection. Meeting a word-count limit alone is not approval.",
        "Existing story beats are the meaning baseline. Do not reject this syntax repair for repetition or other story defects already present in the original; the manuscript review owns those defects. Do not request fresh actions, props, stronger progression, a new ending or changes to the page assignment.",
        "Use neighboring prose only to check whether the edit introduces a continuity regression. Judge all checks relative to the original; keep issues and requiredRevisions confined to defects introduced or left unresolved by this sentence repair.",
        "Return approved, score (0-100), issues, requiredRevisions, notes, and checks with placeholderFree, promptLeakFree, titleClean, repetitionOk, progressionOk and styleNatural. A rejection must set approved=false."
      ].join(" ") },
      { role: "user", content: JSON.stringify({
        language: targetLanguagePayload(options.input.language),
        readingLimits: kidsReadingGuidanceForInput(options.input),
        pageIndex: options.pageIndex,
        sentenceRepair: options.sentenceRepair,
        draft: { title: options.draft.title, markdown: options.draft.markdown },
        previousPage: options.previousPages.at(-1), followingPage: options.nextPages?.[0]
      }) }
    ]
  };
}

/**
 * A syntax-only failure cannot authorize a new title, summary, illustration or
 * page beat. Apply exact unique sentence replacements atomically, then let the
 * configured gates and the comparison against the original judge the candidate.
 */
export async function reviseSentenceLength(options: RevisePageOptions): Promise<PageDraft> {
  const guidance = kidsReadingGuidanceForInput(options.input)!;
  const eligibleSentences = rawSentences(options.draft.markdown)
    .filter((sentence) => countReadableWords(sentence) > guidance.maxAverageSentenceWords);
  if (eligibleSentences.length === 0) return options.draft;
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "revise-page",
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.qaCandidateNumber !== undefined ? { providerCallMetadata: pageQaProviderCallMetadata({ report: options.report, candidateNumber: options.qaCandidateNumber }) } : {}),
    temperature: Math.min(0.3, options.input.temperature),
    maxTokens: 3200,
    schema: responseSchema,
    messages: [
      { role: "system", content: [
        "Repair only sentence length in existing book prose using exact sentence replacements.",
        "Split or simplify the fewest eligible sentences needed to meet the supplied reading limits. Every find must be one complete eligible sentence copied verbatim from pageMarkdown and occurring exactly once. Return patches only; all other bytes and page metadata stay unchanged.",
        "Preserve every event, character, object, location, order, causal link, negation, uncertainty and dialogue meaning. Do not add a scene, prop, action, explanation, atmospheric filler or repeated short sentence to lower the average. Do not replace a planned beat or re-perform a future beat. A sentence may split into natural complete sentences, never fragments or a punctuation-only trick.",
        "The page's existing prose is the meaning baseline. This task does not ask for a fresh opening, stronger progression, added sensory detail, or a new ending. Return an empty patches array if no safe local repair is possible.",
        ...targetLanguageGenerationGuidance(options.input.language)
      ].join(" ") },
      { role: "user", content: JSON.stringify({
        pageIndex: options.pageIndex, pageMarkdown: options.draft.markdown,
        originalMarkdown: options.sentenceRepair?.originalMarkdown,
        issues: options.report.issues, eligibleSentences,
        readingLimits: { maxAverageSentenceWords: guidance.maxAverageSentenceWords, maxSentenceWords: guidance.maxSentenceWords },
        previousPage: options.previousPages.at(-1), followingPage: options.nextPages?.[0]
      }) }
    ]
  });
  const patches = responseSchema.parse(result.data).patches;
  // Match the original snapshot, not text introduced by an earlier patch. A
  // duplicate or broad paragraph patch cannot quietly rewrite protected prose.
  const seen = new Set<string>();
  for (const patch of patches) {
    if (!eligibleSentences.includes(patch.find) || !patch.replace.trim() || seen.has(patch.find)) return options.draft;
    const first = options.draft.markdown.indexOf(patch.find);
    if (first < 0 || options.draft.markdown.indexOf(patch.find, first + patch.find.length) >= 0) return options.draft;
    seen.add(patch.find);
  }
  const applied = applyPagePatches(options.draft.markdown, patches);
  return applied.failures.length ? options.draft : { ...options.draft, markdown: applied.markdown };
}

/** Reuse the QA boundaries while retaining exact source bytes for a patch find. */
function rawSentences(markdown: string): string[] {
  const sentences: string[] = [];
  let cursor = 0;
  for (const normalized of splitSentences(markdown)) {
    // The shared splitter collapses whitespace for measurement. Match those
    // normalized words back onto the source in order; never hand the writer a
    // normalized find that cannot occur in a soft-wrapped paragraph.
    const pattern = normalized.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const match = new RegExp(pattern, "u").exec(markdown.slice(cursor));
    if (!match) return [];
    sentences.push(match[0]);
    cursor += match.index + match[0].length;
  }
  return sentences;
}
