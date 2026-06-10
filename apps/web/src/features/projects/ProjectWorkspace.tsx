import { AlertTriangle, MessageSquareText } from "lucide-react";
import type {
  CreateVoiceConversationRequest,
  Project,
  ProjectDetails,
  ProjectStatus,
  VoiceCharacter,
  VoiceChatProviderId,
  VoiceConversation,
  VoiceProfile,
  VoiceProviderInfo
} from "../../api.js";
import { JobsSection } from "../jobs/JobsSection.js";
import { PlanSection } from "../planning/PlanSection.js";
import { normalizePlanMessages } from "../planning/planMessages.js";
import type { NormalizedPlanQuestion, QuestionResponse } from "../planning/planQuestions.js";
import { PreviewsSection } from "../previews/PreviewsSection.js";
import { Metric } from "../shared/Metric.js";
import { formatLiveTokenCount } from "../shared/formatters.js";
import { VoiceCallBar, VoiceCharactersPanel, VoiceRoomBar } from "../voice/VoiceComponents.js";
import type { ActiveVoiceCall, ActiveVoiceRoom } from "../voice/types.js";
import { formatProjectCategory, type GenerationStrategyOption } from "./draft.js";

export function ProjectWorkspace(props: {
  mockAi: boolean | undefined;
  error: string | null;
  selectedId: string | null;
  selectedProject: Project | null;
  selectedDetails: ProjectDetails | null;
  selectedStatus: ProjectStatus | null;
  selectedBookMarkdown: string;
  selectedPdfAvailable: boolean;
  selectedPdfPreviewUrl: string;
  selectedVoiceCharacters: VoiceCharacter[];
  selectedVoiceConversations: VoiceConversation[];
  activeVoiceCall: ActiveVoiceCall;
  activeVoiceRoom: ActiveVoiceRoom;
  voiceProviders: VoiceProviderInfo[];
  selectedVoiceProviderId: VoiceChatProviderId;
  selectedVoiceModel: string | null;
  activeGenerationStrategy: GenerationStrategyOption;
  busyActions: Record<string, boolean>;
  draftPrompt: string;
  planMessage: string;
  createPlanBusy: boolean;
  revisionBusy: boolean;
  approveBusy: boolean;
  resumeBusy: boolean;
  stopBusy: boolean;
  coverBusy: boolean;
  approvePlanDisabled: boolean;
  hasActivePlanRevision: boolean;
  canRetryPlanning: boolean;
  canResumeProject: boolean;
  canStopProject: boolean;
  planQuestions: NormalizedPlanQuestion[];
  questionResponses: Record<string, QuestionResponse>;
  activeQuestionIndex: number;
  customQuestionAnswer: string;
  submittedQuestionResponses: boolean;
  onCreatePlan: () => void;
  onApprovePlan: () => void;
  onRevisePlan: () => void;
  onPlanMessageChange: (message: string) => void;
  onResumeProject: () => void;
  onStopProject: () => void;
  onRegenerateCover: () => void;
  onAnswerQuestion: (answer: string) => void;
  onCustomQuestionAnswerChange: (answer: string) => void;
  onGoToQuestion: (index: number) => void;
  onSkipQuestion: () => void;
  onSubmitQuestionResponses: () => void;
  onApproveVoiceCharacter: (character: VoiceCharacter) => void;
  onRejectVoiceCharacter: (character: VoiceCharacter) => void;
  onVoiceProfileChange: (character: VoiceCharacter, patch: Partial<VoiceProfile>) => void;
  onVoiceProviderChange: (providerId: VoiceChatProviderId) => void;
  onVoiceModelChange: (model: string) => void;
  onStartVoiceCall: (character: VoiceCharacter) => void;
  onStartVoiceRoom: (projectId: string, characters: VoiceCharacter[]) => void;
  onCreateVoiceConversation: (projectId: string, payload: CreateVoiceConversationRequest) => Promise<VoiceConversation>;
  onEndVoiceCall: () => void;
  onEndVoiceRoom: () => void;
  onToggleVoiceCallMute: () => void;
  onToggleVoiceRoomMute: () => void;
}) {
  const selectedProject = props.selectedProject;
  const plan = props.selectedDetails?.currentPlan?.planningPackage;
  const planMessages = normalizePlanMessages(props.selectedDetails?.currentPlan?.messages);
  const pageProgress = props.selectedStatus?.progress.pages;
  const progressPercent =
    pageProgress && pageProgress.target > 0 ? Math.round((pageProgress.complete / pageProgress.target) * 100) : 0;
  const qualityProgress = props.selectedStatus?.progress.quality;
  const projectTokens = props.selectedStatus?.progress.tokens ?? selectedProject?.tokens;

  return (
    <section className="workspace">
      {props.mockAi ? (
        <div className="mock-banner">
          <AlertTriangle size={20} aria-hidden />
          <div>
            <strong>MOCK_AI is on.</strong>
            <span> Plans, pages, and images are deterministic placeholders until the API and worker restart without `MOCK_AI=true`.</span>
          </div>
        </div>
      ) : null}
      {props.error ? <div className="error-banner">{props.error}</div> : null}
      {!selectedProject ? (
        <div className="empty-state">Create a project to start planning a book.</div>
      ) : (
        <>
          <header className="workspace-header">
            <div>
              <p className="eyebrow">{formatProjectCategory(selectedProject.category, selectedProject.subcategory)}</p>
              <h2>{selectedProject.title}</h2>
            </div>
            <div className="status-pill">{selectedProject.status}</div>
          </header>
          {selectedProject.prompt ? (
            <section className="prompt-panel">
              <div className="section-title">
                <MessageSquareText size={18} />
                <h3>Original prompt</h3>
              </div>
              <p className="saved-prompt">{selectedProject.prompt}</p>
            </section>
          ) : null}

          <div className="metrics-row">
            <Metric label="Pages" value={`${pageProgress?.complete ?? 0}/${pageProgress?.target ?? selectedProject.targetPages}`} />
            <Metric label="Images" value={String(props.selectedStatus?.progress.images ?? props.selectedDetails?.images.length ?? 0)} />
            <Metric label="Research" value={String(props.selectedStatus?.progress.research ?? props.selectedDetails?.research.length ?? 0)} />
            <Metric label="Input Tokens" value={formatLiveTokenCount(projectTokens, "promptTokens")} />
            <Metric label="Output Tokens" value={formatLiveTokenCount(projectTokens, "outputTokens")} />
            <Metric
              label="QA"
              value={
                qualityProgress
                  ? `${qualityProgress.reviewedPages}/${selectedProject.targetPages}${qualityProgress.blockedPages ? ` blocked ${qualityProgress.blockedPages}` : ""}`
                  : "0"
              }
            />
            <Metric label="Progress" value={`${progressPercent}%`} />
          </div>

          <div className="progress-track">
            <div style={{ width: `${progressPercent}%` }} />
          </div>

          {props.activeVoiceCall ? (
            <VoiceCallBar call={props.activeVoiceCall} onEnd={props.onEndVoiceCall} onToggleMute={props.onToggleVoiceCallMute} />
          ) : null}
          {props.activeVoiceRoom ? (
            <VoiceRoomBar room={props.activeVoiceRoom} onEnd={props.onEndVoiceRoom} onToggleMute={props.onToggleVoiceRoomMute} />
          ) : null}

          {selectedProject.status === "COMPLETE" || props.selectedVoiceCharacters.length > 0 ? (
            <VoiceCharactersPanel
              characters={props.selectedVoiceCharacters}
              selectedStatus={props.selectedStatus}
              busyActions={props.busyActions}
              conversations={props.selectedVoiceConversations}
              activeCallCharacterId={props.activeVoiceCall?.character.id ?? null}
              activeRoomCharacterIds={props.activeVoiceRoom?.characters.map((character) => character.id) ?? []}
              providers={props.voiceProviders}
              selectedProviderId={props.selectedVoiceProviderId}
              selectedModel={props.selectedVoiceModel}
              providerSelectionDisabled={Boolean(props.activeVoiceCall || props.activeVoiceRoom)}
              onApprove={props.onApproveVoiceCharacter}
              onReject={props.onRejectVoiceCharacter}
              onProfileChange={props.onVoiceProfileChange}
              onProviderChange={props.onVoiceProviderChange}
              onModelChange={props.onVoiceModelChange}
              onCall={props.onStartVoiceCall}
              onStartRoom={(characters) => selectedProject ? props.onStartVoiceRoom(selectedProject.id, characters) : undefined}
              onCreateConversation={(payload) =>
                selectedProject
                  ? props.onCreateVoiceConversation(selectedProject.id, payload)
                  : Promise.reject(new Error("Select a project first."))
              }
            />
          ) : null}

          <div className="main-grid">
            <PlanSection
              plan={plan}
              planMessages={planMessages}
              selectedId={props.selectedId}
              draftPrompt={props.draftPrompt}
              planMessage={props.planMessage}
              createPlanBusy={props.createPlanBusy}
              revisionBusy={props.revisionBusy}
              approveBusy={props.approveBusy}
              hasActivePlanRevision={props.hasActivePlanRevision}
              approvePlanDisabled={props.approvePlanDisabled}
              questions={props.planQuestions}
              responses={props.questionResponses}
              activeQuestionIndex={props.activeQuestionIndex}
              customQuestionAnswer={props.customQuestionAnswer}
              submittedQuestionResponses={props.submittedQuestionResponses}
              onCreatePlan={props.onCreatePlan}
              onApprovePlan={props.onApprovePlan}
              onRevisePlan={props.onRevisePlan}
              onPlanMessageChange={props.onPlanMessageChange}
              onAnswerQuestion={props.onAnswerQuestion}
              onCustomQuestionAnswerChange={props.onCustomQuestionAnswerChange}
              onGoToQuestion={props.onGoToQuestion}
              onSkipQuestion={props.onSkipQuestion}
              onSubmitQuestionResponses={props.onSubmitQuestionResponses}
            />

            <JobsSection
              selectedStatus={props.selectedStatus}
              selectedId={props.selectedId}
              activeGenerationStrategy={props.activeGenerationStrategy}
              canStopProject={props.canStopProject}
              canRetryPlanning={props.canRetryPlanning}
              canResumeProject={props.canResumeProject}
              stopBusy={props.stopBusy}
              resumeBusy={props.resumeBusy}
              onStopProject={props.onStopProject}
              onResumeProject={props.onResumeProject}
            />
          </div>

          <PreviewsSection
            selectedProject={selectedProject}
            selectedDetails={props.selectedDetails}
            selectedBookMarkdown={props.selectedBookMarkdown}
            selectedPdfAvailable={props.selectedPdfAvailable}
            selectedPdfPreviewUrl={props.selectedPdfPreviewUrl}
            coverBusy={props.coverBusy}
            selectedId={props.selectedId}
            onRegenerateCover={props.onRegenerateCover}
          />
        </>
      )}
    </section>
  );
}
