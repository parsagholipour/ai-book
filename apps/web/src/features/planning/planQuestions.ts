import { firstString, firstStringArray } from "../shared/formatters.js";

export type NormalizedPlanQuestion = {
  id: string;
  prompt: string;
  options: string[];
  allowCustom: boolean;
};

export type QuestionResponse = {
  status: "answered" | "skipped";
  answer?: string;
};

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
  const allowCustom = typeof record.allowCustom === "boolean" ? record.allowCustom : true;
  return makeNormalizedPlanQuestion(index, prompt, options, allowCustom);
}

export function makeNormalizedPlanQuestion(
  index: number,
  prompt: string,
  options: string[],
  allowCustom: boolean
): NormalizedPlanQuestion {
  return {
    id: `${index}-${prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}`,
    prompt,
    options: [...new Set(options.map((option) => option.trim()).filter(Boolean))],
    allowCustom
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
