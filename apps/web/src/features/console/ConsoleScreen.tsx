import { useState } from "react";
import type { useAuth } from "../auth/useAuth.js";
import {
  CREATE_PROJECT_ACTION_KEY,
  planApproveActionKey,
  planningRecoveryJobTypes,
  planRevisionActionKey,
  projectCoverActionKey,
  projectPlanActionKey,
  projectResumeActionKey,
  projectStopActionKey,
  generationRecoveryJobTypes
} from "../projects/actionKeys.js";
import { DEFAULT_GENERATION_STRATEGY_ID, resolveGenerationStrategy } from "../projects/draft.js";
import { ProjectHoverPopover, ProjectSidebar } from "../projects/ProjectSidebar.js";
import { ProjectWorkspace } from "../projects/ProjectWorkspace.js";
import type { ProjectHoverState } from "../projects/projectDisplay.js";
import { useProjectActions } from "../projects/useProjectActions.js";
import { useProjectConsoleData } from "../projects/useProjectConsoleData.js";
import { useProjectDraft } from "../projects/useProjectDraft.js";
import { usePlanQuestions } from "../planning/usePlanQuestions.js";
import { useBusyActions } from "../shared/useBusyActions.js";
import { useVoiceCalls } from "../voice/useVoiceCalls.js";

/**
 * The project console: everything that used to be `App` below the auth gate.
 *
 * `useVoiceCalls` lives here rather than above the router, so navigating to the
 * pricing dashboard ends an in-progress browser voice call. That is the accepted
 * trade for keeping the split small — hoisting the call would mean hoisting
 * `setError` and the console data hook with it.
 */
export function ConsoleScreen(props: { auth: ReturnType<typeof useAuth> }) {
  const auth = props.auth;
  const data = useProjectConsoleData({ authenticated: auth.authStatus?.authenticated });
  const projectDraft = useProjectDraft({ runtime: data.runtime, selectedProject: data.selectedProject });
  const busy = useBusyActions();
  const voice = useVoiceCalls(data.setError, { authenticated: auth.authStatus?.authenticated });
  const [projectHover, setProjectHover] = useState<ProjectHoverState>(null);
  const [planMessage, setPlanMessage] = useState("");

  const actions = useProjectActions({
    selectedId: data.selectedId,
    selectedDetails: data.selectedDetails,
    draft: projectDraft.draft,
    setSelectedId: data.setSelectedId,
    setError: data.setError,
    refreshAll: data.refreshAll,
    refreshProject: data.refreshProject,
    refreshVoiceCharacters: data.refreshVoiceCharacters,
    runBusyAction: busy.runBusyAction
  });

  const selectedStatus = data.selectedStatus;
  const plan = data.selectedDetails?.currentPlan?.planningPackage;
  const latestPlanRevisionStatus = selectedStatus?.project.jobs.find((job) => job.type === "REVISE_PLAN")?.status;
  const hasActivePlanRevision = latestPlanRevisionStatus === "QUEUED" || latestPlanRevisionStatus === "ACTIVE";
  const currentPlanId = data.selectedDetails?.currentPlan?.id ?? null;
  const hasVisibleFailedGenerationJob =
    selectedStatus?.project.jobs.some((job) => job.status === "FAILED" && generationRecoveryJobTypes.has(job.type)) ?? false;
  const hasFailedPlanningJob =
    selectedStatus?.project.jobs.some((job) => job.status === "FAILED" && planningRecoveryJobTypes.has(job.type)) ?? false;
  const hasActivePlanningJob =
    selectedStatus?.project.jobs.some(
      (job) => planningRecoveryJobTypes.has(job.type) && (job.status === "QUEUED" || job.status === "ACTIVE")
    ) ?? false;
  const planStepStatus = selectedStatus?.progress.pipeline?.find((step) => step.key === "plan")?.status;
  const canRetryPlanning = (planStepStatus ? planStepStatus === "failed" : hasFailedPlanningJob) && !hasActivePlanningJob;
  const canResumeProject = (selectedStatus?.progress.resumableFailedJobs ?? 0) > 0 || hasVisibleFailedGenerationJob;
  const canStopProject =
    selectedStatus?.project.jobs.some((job) => job.status === "QUEUED" || job.status === "ACTIVE") ?? false;
  const createProjectBusy = busy.isActionBusy(CREATE_PROJECT_ACTION_KEY);
  const createPlanBusy = data.selectedId ? busy.isActionBusy(projectPlanActionKey(data.selectedId)) : false;
  const revisionBusy = currentPlanId ? busy.isActionBusy(planRevisionActionKey(currentPlanId)) : false;
  const approveBusy = currentPlanId ? busy.isActionBusy(planApproveActionKey(currentPlanId)) : false;
  const resumeBusy = data.selectedId ? busy.isActionBusy(projectResumeActionKey(data.selectedId)) : false;
  const stopBusy = data.selectedId ? busy.isActionBusy(projectStopActionKey(data.selectedId)) : false;
  const coverBusy = data.selectedId ? busy.isActionBusy(projectCoverActionKey(data.selectedId)) : false;
  const approvePlanDisabled = approveBusy || !plan || hasActivePlanRevision;
  const activeStrategyId =
    selectedStatus?.project.mediaSettings?.generationStrategy ??
    data.selectedProject?.mediaSettings?.generationStrategy ??
    DEFAULT_GENERATION_STRATEGY_ID;
  const activeGenerationStrategy = resolveGenerationStrategy(projectDraft.strategyOptions, activeStrategyId);
  const planQuestions = usePlanQuestions({
    selectedId: data.selectedId,
    questions: plan?.questions,
    latestPlanRevisionStatus,
    hasActivePlanRevision,
    revisePlanWithMessage: actions.revisePlanWithMessage
  });

  function handleLogout() {
    data.setError(null);
    void auth.logout(async () => {
      data.clearProjectData();
      await voice.endVoiceCall();
      await voice.endVoiceRoom();
    });
  }

  function revisePlan() {
    void actions.revisePlanWithMessage(planMessage, () => setPlanMessage(""));
  }

  return (
    <main className="app-shell">
      <ProjectSidebar
        authEnabled={auth.authStatus?.enabled ?? false}
        authBusy={auth.authBusy}
        draft={projectDraft.draft}
        setDraft={projectDraft.setDraft}
        projects={data.projects}
        selectedId={data.selectedId}
        imageModelOptions={projectDraft.imageModelOptions}
        strategyOptions={projectDraft.strategyOptions}
        selectedStrategy={projectDraft.selectedStrategy}
        selectedImageModel={projectDraft.selectedImageModel}
        showImageModelControls={projectDraft.showImageModelControls}
        createProjectBusy={createProjectBusy}
        onLogout={handleLogout}
        onCreateProject={() => void actions.createProject()}
        onRefreshProjects={() => void data.refreshAll()}
        onSelectProject={data.setSelectedId}
        onProjectHoverChange={setProjectHover}
      />
      <ProjectHoverPopover projectHover={projectHover} strategyOptions={projectDraft.strategyOptions} />
      <ProjectWorkspace
        mockAi={data.runtime?.mockAi}
        error={data.error}
        selectedId={data.selectedId}
        selectedProject={data.selectedProject}
        selectedDetails={data.selectedDetails}
        selectedStatus={selectedStatus}
        selectedBookMarkdown={data.selectedBookMarkdown}
        selectedPdfAvailable={data.selectedPdfAvailable}
        selectedPdfPreviewUrl={data.selectedPdfPreviewUrl}
        selectedVoiceCharacters={data.selectedVoiceCharacters}
        selectedVoiceConversations={data.selectedVoiceConversations}
        activeVoiceCall={voice.activeVoiceCall}
        activeVoiceRoom={voice.activeVoiceRoom}
        voiceProviders={voice.voiceProviders}
        selectedVoiceProviderId={voice.selectedVoiceProviderId}
        selectedVoiceModel={voice.selectedVoiceModel}
        activeGenerationStrategy={activeGenerationStrategy}
        busyActions={busy.busyActions}
        draftPrompt={projectDraft.draft.prompt}
        planMessage={planMessage}
        createPlanBusy={createPlanBusy}
        revisionBusy={revisionBusy}
        approveBusy={approveBusy}
        resumeBusy={resumeBusy}
        stopBusy={stopBusy}
        coverBusy={coverBusy}
        approvePlanDisabled={approvePlanDisabled}
        hasActivePlanRevision={hasActivePlanRevision}
        canRetryPlanning={canRetryPlanning}
        canResumeProject={canResumeProject}
        canStopProject={canStopProject}
        planQuestions={planQuestions.planQuestions}
        questionResponses={planQuestions.questionResponses}
        activeQuestionIndex={planQuestions.activeQuestionIndex}
        customQuestionAnswer={planQuestions.customQuestionAnswer}
        submittedQuestionResponses={planQuestions.submittedQuestionResponses}
        onCreatePlan={() => void actions.createPlan()}
        onApprovePlan={() => void actions.approvePlan()}
        onRevisePlan={revisePlan}
        onPlanMessageChange={setPlanMessage}
        onResumeProject={() => void actions.resumeProject()}
        onStopProject={() => void actions.stopProject()}
        onRegenerateCover={() => void actions.regenerateCover()}
        onAnswerQuestion={planQuestions.answerActiveQuestion}
        onSelectQuestionOption={planQuestions.toggleActiveQuestionOption}
        onCustomQuestionAnswerChange={planQuestions.setCustomQuestionAnswer}
        onGoToQuestion={planQuestions.goToPlanQuestion}
        onSkipQuestion={planQuestions.skipActiveQuestion}
        onSubmitQuestionResponses={() => void planQuestions.submitQuestionResponses()}
        onApproveVoiceCharacter={(character) => void actions.approveVoiceCharacter(character)}
        onRejectVoiceCharacter={(character) => void actions.rejectVoiceCharacter(character)}
        onVoiceProfileChange={(character, patch) => void actions.updateVoiceCharacterProfile(character, patch)}
        onVoiceProviderChange={voice.setSelectedVoiceProviderId}
        onVoiceModelChange={voice.setSelectedVoiceModel}
        onStartVoiceCall={(character) => void voice.startVoiceCall(character)}
        onStartVoiceRoom={(projectId, characters) => void voice.startVoiceRoom(projectId, characters)}
        onCreateVoiceConversation={data.createVoiceConversation}
        onEndVoiceCall={() => void voice.endVoiceCall()}
        onEndVoiceRoom={() => void voice.endVoiceRoom()}
        onToggleVoiceCallMute={voice.toggleVoiceCallMute}
        onToggleVoiceRoomMute={voice.toggleVoiceRoomMute}
      />
    </main>
  );
}
