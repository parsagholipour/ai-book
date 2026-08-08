import { firstString, firstStringArray } from "../shared/formatters.js";

export type NormalizedPlanQuestion = {
  id: string;
  prompt: string;
  options: string[];
  /** "multi" means several options can be sent together as one answer. */
  answerKind: "choice" | "multi" | "open";
  allowCustom: boolean;
};

export type QuestionResponse = {
  status: "answered" | "skipped";
  answer?: string;
  /** Options tapped on a multi-answer question; `answer` is their joined form. */
  picked?: string[];
};

/** Arabic, Arabic Supplement and the presentation forms: Persian, Arabic, Urdu. */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Joins the picks of a multi-answer question into the single answer line the
 * plan revision reads. The separator follows the script of the answers, because
 * a Persian or Arabic list strung together with a Latin comma reads as broken
 * text in the language the plan was written in.
 */
export function joinQuestionAnswers(answers: string[]): string {
  const picked = answers.map((answer) => answer.trim()).filter(Boolean);
  const separator = picked.some((answer) => ARABIC_SCRIPT.test(answer)) ? "\u060c " : ", ";
  return picked.join(separator);
}

export function normalizePlanQuestions(questions: unknown): NormalizedPlanQuestion[] {
  if (!Array.isArray(questions)) {
    return [];
  }

  return questions.flatMap((question, index) => {
    const normalized = normalizePlanQuestion(question, index);
    return normalized ? [normalized] : [];
  });
}

export function normalizePlanQuestion(question: unknown, index: number): NormalizedPlanQuestion | null {
  if (typeof question === "string") {
    const prompt = question.trim();
    return prompt ? makeNormalizedPlanQuestion(index, prompt, [], true) : null;
  }
  if (!question || typeof question !== "object" || Array.isArray(question)) {
    return null;
  }

  const record = question as Record<string, unknown>;
  const prompt = firstString(record.prompt, record.question, record.text);
  if (!prompt) {
    return null;
  }

  const options = firstStringArray(
    record.options,
    record.suggestedAnswers,
    record.answers,
    record.choices,
    record.premadeAnswers
  );
  const allowCustom =
    [record.allowCustom, record.customAnswer, record.custom].find((value) => typeof value === "boolean") as
      | boolean
      | undefined ?? true;
  // The same alias set core's planQuestionSchema accepts: this normalizer reads
  // raw un-normalized records, so dropping an alias silently downgrades a
  // multi question to a single choice.
  const declaredKind = firstString(record.answerKind, record.answerType)?.trim().toLowerCase();
  const multiple =
    [record.multiSelect, record.multiple, record.allowMultiple, record.selectMultiple].some(
      (value) => value === true
    ) ||
    declaredKind === "multi" ||
    declaredKind === "multiple";
  return makeNormalizedPlanQuestion(index, prompt, options, allowCustom, multiple ? "multi" : declaredKind);
}

export function makeNormalizedPlanQuestion(
  index: number,
  prompt: string,
  options: string[],
  allowCustom: boolean,
  answerKind?: unknown
): NormalizedPlanQuestion {
  const distinctOptions = [...new Set(options.map((option) => option.trim()).filter(Boolean))];
  // Fewer than two options is open whatever the plan says: one option is
  // neither a choice nor a set to combine.
  const kind: NormalizedPlanQuestion["answerKind"] =
    distinctOptions.length < 2 ? "open" : answerKind === "multi" ? "multi" : "choice";
  return {
    id: `${index}-${prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}`,
    prompt,
    options: distinctOptions,
    answerKind: kind,
    // An open question without a text box is unanswerable except by Skip.
    allowCustom: kind === "open" ? true : allowCustom
  };
}

export function pruneQuestionResponses(
  questions: NormalizedPlanQuestion[],
  responses: Record<string, QuestionResponse>
): Record<string, QuestionResponse> {
  const questionIds = new Set(questions.map((question) => question.id));
  const entries = Object.entries(responses).filter(([questionId]) => questionIds.has(questionId));
  return entries.length === Object.keys(responses).length ? responses : Object.fromEntries(entries);
}

export function buildQuestionResponseMessage(
  questions: NormalizedPlanQuestion[],
  responses: Record<string, QuestionResponse>
): string {
  const answered = questions
    .map((question) => ({ question, response: responses[question.id] }))
    .filter((entry): entry is { question: NormalizedPlanQuestion; response: QuestionResponse & { answer: string } } =>
      entry.response?.status === "answered" && Boolean(entry.response.answer?.trim())
    );
  const skipped = questions.filter((question) => responses[question.id]?.status === "skipped");

  return [
    "Planning question responses:",
    ...answered.map((entry, index) => `${index + 1}. ${entry.question.prompt}\nAnswer: ${entry.response.answer}`),
    ...(skipped.length > 0
      ? ["Skipped questions with no preference:", ...skipped.map((question) => `- ${question.prompt}`)]
      : [])
  ].join("\n");
}
