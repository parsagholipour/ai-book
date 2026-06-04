import type { AudienceAgeRange, CreateProjectInput } from "../schemas/book.js";

export type KidsReadingGuidance = {
  ageRange: AudienceAgeRange;
  audienceLabel: string;
  targetWordsPerPage: { min: number; max: number };
  maxWordsPerPageWithTolerance: number;
  maxAverageSentenceWords: number;
  maxSentenceWords: number;
  vocabularyRule: string;
  sentenceRule: string;
  complexityRule: string;
};

const DEFAULT_KIDS_AGE_RANGE: AudienceAgeRange = "4-6";

const KIDS_READING_GUIDANCE: Record<AudienceAgeRange, KidsReadingGuidance> = {
  "2-4": {
    ageRange: "2-4",
    audienceLabel: "children ages 2-4 and read-aloud adults",
    targetWordsPerPage: { min: 8, max: 35 },
    maxWordsPerPageWithTolerance: 42,
    maxAverageSentenceWords: 7,
    maxSentenceWords: 12,
    vocabularyRule: "Use familiar concrete words, repeated anchors, and almost no abstract explanation.",
    sentenceRule: "Use very short sentences, one simple action per sentence, and a small amount of dialogue.",
    complexityRule:
      "Writing complexity can add warmth, rhythm, or sensory detail only inside the age 2-4 limits; never add denser vocabulary or longer sentences."
  },
  "4-6": {
    ageRange: "4-6",
    audienceLabel: "children ages 4-6 and read-aloud adults",
    targetWordsPerPage: { min: 20, max: 65 },
    maxWordsPerPageWithTolerance: 78,
    maxAverageSentenceWords: 9,
    maxSentenceWords: 16,
    vocabularyRule: "Use simple picture-book vocabulary with a few expressive words that are clear from context.",
    sentenceRule: "Keep sentences short and direct, with one clear visual or emotional beat per page.",
    complexityRule:
      "Writing complexity can make the prose more musical or specific inside the age 4-6 band; never exceed the band with chapter-book density."
  },
  "6-8": {
    ageRange: "6-8",
    audienceLabel: "children ages 6-8 and read-aloud or early-reader adults",
    targetWordsPerPage: { min: 35, max: 100 },
    maxWordsPerPageWithTolerance: 120,
    maxAverageSentenceWords: 12,
    maxSentenceWords: 22,
    vocabularyRule: "Use early-reader vocabulary; richer words are allowed when the surrounding action explains them.",
    sentenceRule: "Use mostly short sentences with occasional medium sentences for rhythm and clarity.",
    complexityRule:
      "Writing complexity can add richer detail or slightly more varied rhythm inside the age 6-8 band; never exceed early-reader clarity."
  }
};

export function resolveKidsAudienceAgeRange(input: CreateProjectInput): AudienceAgeRange | undefined {
  if (input.category !== "KIDS") {
    return undefined;
  }
  return input.mediaSettings.audienceAgeRange ?? DEFAULT_KIDS_AGE_RANGE;
}

export function kidsReadingGuidanceForInput(input: CreateProjectInput): KidsReadingGuidance | undefined {
  const ageRange = resolveKidsAudienceAgeRange(input);
  return ageRange ? KIDS_READING_GUIDANCE[ageRange] : undefined;
}

export function kidsAudienceLabelForInput(input: CreateProjectInput): string | undefined {
  return kidsReadingGuidanceForInput(input)?.audienceLabel;
}

export function kidsReadingGuidancePayload(input: CreateProjectInput): KidsReadingGuidance | undefined {
  return kidsReadingGuidanceForInput(input);
}

export function kidsReadingGuidanceLines(input: CreateProjectInput): string[] {
  const guidance = kidsReadingGuidanceForInput(input);
  if (!guidance) {
    return [];
  }

  return [
    `Kids reading level: ${guidance.ageRange}. Target ${guidance.targetWordsPerPage.min}-${guidance.targetWordsPerPage.max} words per page.`,
    `${guidance.sentenceRule} Keep average sentence length at or below ${guidance.maxAverageSentenceWords} words and avoid sentences over ${guidance.maxSentenceWords} words.`,
    guidance.vocabularyRule,
    guidance.complexityRule
  ];
}
