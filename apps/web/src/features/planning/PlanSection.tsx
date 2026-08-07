import { Loader2, MessageSquareText, Play, RefreshCcw, Send } from "lucide-react";
import type { BookPlan } from "../../api.js";
import { PlanQuestionStepper } from "./PlanQuestionStepper.js";
import type { NormalizedPlanQuestion, QuestionResponse } from "./planQuestions.js";

export function PlanSection(props: {
  plan: BookPlan | null | undefined;
  planMessages: Array<{ role: string; content: string; at?: string }>;
  selectedId: string | null;
  draftPrompt: string;
  planMessage: string;
  createPlanBusy: boolean;
  revisionBusy: boolean;
  approveBusy: boolean;
  hasActivePlanRevision: boolean;
  approvePlanDisabled: boolean;
  questions: NormalizedPlanQuestion[];
  responses: Record<string, QuestionResponse>;
  activeQuestionIndex: number;
  customQuestionAnswer: string;
  submittedQuestionResponses: boolean;
  onCreatePlan: () => void;
  onApprovePlan: () => void;
  onRevisePlan: () => void;
  onPlanMessageChange: (message: string) => void;
  onAnswerQuestion: (answer: string) => void;
  onSelectQuestionOption: (option: string) => void;
  onCustomQuestionAnswerChange: (answer: string) => void;
  onGoToQuestion: (index: number) => void;
  onSkipQuestion: () => void;
  onSubmitQuestionResponses: () => void;
}) {
  return (
    <section className="work-section">
      <div className="section-title">
        <MessageSquareText size={18} />
        <h3>Plan</h3>
        <button
          className="icon-text-button"
          onClick={props.onCreatePlan}
          disabled={props.createPlanBusy || !props.selectedId || props.draftPrompt.length < 10}
        >
          {props.createPlanBusy ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
          Regenerate
        </button>
        <button className="icon-text-button accent" onClick={props.onApprovePlan} disabled={props.approvePlanDisabled}>
          {props.approveBusy || props.hasActivePlanRevision ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
          {props.approveBusy || props.hasActivePlanRevision ? "Loading" : "Approve"}
        </button>
      </div>
      {props.plan ? (
        <div className="plan-grid">
          <div>
            <h4>{props.plan.title}</h4>
            <p>{props.plan.premise}</p>
            <p className="muted">{props.plan.audience}</p>
          </div>
          <div>
            <h4>Voice</h4>
            <ul>{props.plan.voiceGuide.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
          <div>
            <h4>Illustrations</h4>
            <p>{props.plan.illustrationPlan.globalStyle}</p>
          </div>
        </div>
      ) : (
        <p className="muted">No plan yet. Generate a plan to begin the approval workflow.</p>
      )}
      <PlanQuestionStepper
        questions={props.questions}
        responses={props.responses}
        activeIndex={props.activeQuestionIndex}
        customAnswer={props.customQuestionAnswer}
        busy={props.revisionBusy}
        revisionPending={props.hasActivePlanRevision}
        responsesSubmitted={props.submittedQuestionResponses}
        onAnswer={props.onAnswerQuestion}
        onSelectOption={props.onSelectQuestionOption}
        onCustomAnswerChange={props.onCustomQuestionAnswerChange}
        onGoTo={props.onGoToQuestion}
        onSkip={props.onSkipQuestion}
        onSubmit={props.onSubmitQuestionResponses}
      />
      <div className="chapter-list">
        {props.plan?.chapters.map((chapter) => (
          <article key={chapter.index}>
            <span>{chapter.index}</span>
            <div>
              <h4>{chapter.title}</h4>
              <p>{chapter.summary}</p>
            </div>
            <small>{chapter.targetPages} pages</small>
          </article>
        ))}
      </div>
      {props.planMessages.length > 0 ? (
        <div className="plan-messages">
          <h4>Revision history</h4>
          <ul>
            {props.planMessages.map((message, index) => (
              <li key={`${message.at ?? "message"}-${index}`}>
                <small>{message.at ? new Date(message.at).toLocaleString() : "Saved revision"}</small>
                <p>{message.content}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="revision-row">
        <textarea
          rows={3}
          value={props.planMessage}
          onChange={(event) => props.onPlanMessageChange(event.target.value)}
          placeholder="Ask for outline, character, style, or illustration changes before approval."
        />
        <button className="primary-button compact" onClick={props.onRevisePlan} disabled={props.revisionBusy || !props.planMessage.trim()}>
          {props.revisionBusy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
          Send
        </button>
      </div>
    </section>
  );
}
