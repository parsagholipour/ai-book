import { useEffect, useMemo, useState } from "react";
import {
  buildQuestionResponseMessage,
  normalizePlanQuestions,
  pruneQuestionResponses,
  type QuestionResponse
} from "./planQuestions.js";

export function usePlanQuestions(args: {
  selectedId: string | null;
  questions: unknown;
  latestPlanRevisionStatus?: string | undefined;
  hasActivePlanRevision: boolean;
  revisePlanWithMessage: (
    message: string,
    onSuccess?: () => void,
    respondedQuestionPrompts?: string[]
  ) => Promise<void>;
}) {
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [questionResponses, setQuestionResponses] = useState<Record<string, QuestionResponse>>({});
  const [submittedQuestionResponseMessage, setSubmittedQuestionResponseMessage] = useState("");
  const [customQuestionAnswer, setCustomQuestionAnswer] = useState("");
  const planQuestions = useMemo(() => normalizePlanQuestions(args.questions), [args.questions]);
  const activeQuestion = planQuestions[activeQuestionIndex];
  const questionResponseMessage = useMemo(
    () => buildQuestionResponseMessage(planQuestions, questionResponses),
    [planQuestions, questionResponses]
  );
  const hasQuestionResponses = planQuestions.some((question) => questionResponses[question.id]);
  const submittedQuestionResponses =
    hasQuestionResponses &&
    args.latestPlanRevisionStatus !== "FAILED" &&
    submittedQuestionResponseMessage === questionResponseMessage;

  useEffect(() => {
    setActiveQuestionIndex(0);
    setQuestionResponses({});
    setSubmittedQuestionResponseMessage("");
    setCustomQuestionAnswer("");
  }, [args.selectedId]);

  useEffect(() => {
    setQuestionResponses((current) => pruneQuestionResponses(planQuestions, current));
  }, [planQuestions]);

  useEffect(() => {
    if (planQuestions.length === 0 && activeQuestionIndex !== 0) {
      setActiveQuestionIndex(0);
      return;
    }
    if (activeQuestionIndex >= planQuestions.length) {
      setActiveQuestionIndex(Math.max(0, planQuestions.length - 1));
    }
  }, [activeQuestionIndex, planQuestions.length]);

  function goToPlanQuestion(index: number) {
    const boundedIndex = Math.min(Math.max(index, 0), Math.max(0, planQuestions.length - 1));
    const nextQuestion = planQuestions[boundedIndex];
    const response = nextQuestion ? questionResponses[nextQuestion.id] : undefined;
    const isCustomAnswer =
      nextQuestion && response?.status === "answered" && !nextQuestion.options.includes(response.answer ?? "");

    setActiveQuestionIndex(boundedIndex);
    setCustomQuestionAnswer(isCustomAnswer ? response?.answer ?? "" : "");
  }

  function answerActiveQuestion(answer: string) {
    if (!activeQuestion) return;
    const trimmedAnswer = answer.trim();
    if (!trimmedAnswer) return;

    setQuestionResponses((current) => ({
      ...current,
      [activeQuestion.id]: { status: "answered", answer: trimmedAnswer }
    }));
    const nextIndex = activeQuestionIndex + 1;
    setCustomQuestionAnswer("");
    if (nextIndex < planQuestions.length) {
      setActiveQuestionIndex(nextIndex);
    }
  }

  function skipActiveQuestion() {
    if (!activeQuestion) return;

    setQuestionResponses((current) => ({
      ...current,
      [activeQuestion.id]: { status: "skipped" }
    }));
    const nextIndex = activeQuestionIndex + 1;
    setCustomQuestionAnswer("");
    if (nextIndex < planQuestions.length) {
      setActiveQuestionIndex(nextIndex);
    }
  }

  async function submitQuestionResponses() {
    if (planQuestions.length === 0) return;
    const respondedQuestions = planQuestions.filter((question) => questionResponses[question.id]);
    if (respondedQuestions.length === 0 || submittedQuestionResponses || args.hasActivePlanRevision) return;

    await args.revisePlanWithMessage(
      questionResponseMessage,
      () => {
        setSubmittedQuestionResponseMessage(questionResponseMessage);
      },
      respondedQuestions.map((question) => question.prompt)
    );
  }

  return {
    planQuestions,
    questionResponses,
    activeQuestionIndex,
    customQuestionAnswer,
    submittedQuestionResponses,
    setCustomQuestionAnswer,
    goToPlanQuestion,
    answerActiveQuestion,
    skipActiveQuestion,
    submitQuestionResponses
  };
}
