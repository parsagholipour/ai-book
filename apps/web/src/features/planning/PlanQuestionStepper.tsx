import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Send,
  SkipForward
} from "lucide-react";
import { Button, IconButton } from "../shared/Button.js";
import type { NormalizedPlanQuestion, QuestionResponse } from "./planQuestions.js";

/** A multi-answer question keeps its picks in `picked`; the answer is their join. */
function isOptionSelected(response: QuestionResponse | undefined, option: string): boolean {
  if (response?.status !== "answered") {
    return false;
  }
  return response.picked ? response.picked.includes(option) : response.answer === option;
}

export function PlanQuestionStepper(props: {
  questions: NormalizedPlanQuestion[];
  responses: Record<string, QuestionResponse>;
  activeIndex: number;
  customAnswer: string;
  busy: boolean;
  revisionPending: boolean;
  responsesSubmitted: boolean;
  onAnswer: (answer: string) => void;
  onSelectOption: (option: string) => void;
  onCustomAnswerChange: (answer: string) => void;
  onGoTo: (index: number) => void;
  onSkip: () => void;
  onSubmit: () => void;
}) {
  if (props.questions.length === 0) {
    return null;
  }

  const activeIndex = Math.min(props.activeIndex, props.questions.length - 1);
  const activeQuestion = props.questions[activeIndex]!;
  const activeResponse = props.responses[activeQuestion.id];
  const responseCount = props.questions.filter((question) => props.responses[question.id]).length;
  const answeredCount = props.questions.filter((question) => props.responses[question.id]?.status === "answered").length;
  const skippedCount = props.questions.filter((question) => props.responses[question.id]?.status === "skipped").length;
  const controlsBusy = props.busy || props.revisionPending;
  const submitLabel = props.revisionPending ? "Applying" : props.responsesSubmitted ? "Submitted" : "Apply";

  return (
    <section className="plan-question-stepper" aria-label="Plan questions">
      <div className="question-stepper-header">
        <h4>Plan questions</h4>
        <span>
          {answeredCount} answered / {skippedCount} skipped
        </span>
      </div>
      <div className="question-steps" role="tablist" aria-label="Plan question steps">
        {props.questions.map((question, index) => {
          const response = props.responses[question.id];
          return (
            <button
              key={question.id}
              type="button"
              className={`question-step${index === activeIndex ? " active" : ""}${response ? ` ${response.status}` : ""}`}
              onClick={() => props.onGoTo(index)}
              aria-label={`Question ${index + 1}`}
              aria-selected={index === activeIndex}
            >
              {response?.status === "answered" ? (
                <CheckCircle2 size={14} />
              ) : response?.status === "skipped" ? (
                <SkipForward size={14} />
              ) : (
                <span>{index + 1}</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="question-card">
        <div className="question-card-heading">
          <small>
            Question {activeIndex + 1} of {props.questions.length}
          </small>
          {activeResponse ? <span className={`question-state ${activeResponse.status}`}>{activeResponse.status}</span> : null}
        </div>
        <p>{activeQuestion.prompt}</p>
        {activeQuestion.answerKind === "multi" ? <small className="muted">Pick as many as apply.</small> : null}
        {activeQuestion.options.length > 0 ? (
          <div className="answer-options">
            {activeQuestion.options.map((option) => (
              <button
                key={option}
                type="button"
                className={isOptionSelected(activeResponse, option) ? "answer-option selected" : "answer-option"}
                onClick={() => props.onSelectOption(option)}
                disabled={controlsBusy}
                aria-pressed={activeQuestion.answerKind === "multi" ? isOptionSelected(activeResponse, option) : undefined}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
        {activeQuestion.allowCustom ? (
          <label className="custom-answer">
            Custom answer
            <textarea
              rows={3}
              value={props.customAnswer}
              onChange={(event) => props.onCustomAnswerChange(event.target.value)}
              placeholder="Type a custom answer"
              disabled={controlsBusy}
            />
          </label>
        ) : null}
        <div className="question-actions">
          <IconButton
            label="Previous question"
            size="sm"
            onClick={() => props.onGoTo(activeIndex - 1)}
            disabled={activeIndex === 0 || controlsBusy}
          >
            <ChevronLeft />
          </IconButton>
          <Button size="sm" onClick={props.onSkip} disabled={controlsBusy} startIcon={<SkipForward />}>
            Skip
          </Button>
          <IconButton
            label="Next question"
            size="sm"
            onClick={() => props.onGoTo(activeIndex + 1)}
            disabled={activeIndex === props.questions.length - 1 || controlsBusy}
          >
            <ChevronRight />
          </IconButton>
          {activeQuestion.allowCustom ? (
            <Button
              variant="primary"
              size="sm"
              compact
              onClick={() => props.onAnswer(props.customAnswer)}
              disabled={controlsBusy || !props.customAnswer.trim()}
              startIcon={<Send />}
            >
              Answer
            </Button>
          ) : null}
          <Button
            className="question-submit"
            variant="accent"
            size="sm"
            onClick={props.onSubmit}
            disabled={controlsBusy || props.responsesSubmitted || responseCount === 0}
            loading={props.revisionPending}
            loadingLabel={submitLabel}
            startIcon={<CheckCircle2 />}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}
