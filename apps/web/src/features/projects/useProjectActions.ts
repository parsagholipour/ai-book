import { apiPatch, apiPost, type Project, type ProjectDetails, type VoiceCharacter, type VoiceProfile } from "../../api.js";
import { readError } from "../shared/formatters.js";
import {
  CREATE_PROJECT_ACTION_KEY,
  planApproveActionKey,
  planRevisionActionKey,
  projectCoverActionKey,
  projectPlanActionKey,
  projectResumeActionKey,
  projectStopActionKey,
  voiceCharacterActionKey
} from "./actionKeys.js";
import { projectInputFromDraft, type DraftProject, type TextModelOption } from "./draft.js";

type RunBusyAction = (key: string, action: () => Promise<void>) => Promise<void>;

export function useProjectActions(args: {
  selectedId: string | null;
  selectedDetails: ProjectDetails | null;
  draft: DraftProject;
  textModelOptions: TextModelOption[];
  setSelectedId: (projectId: string | null) => void;
  setError: (error: string | null) => void;
  refreshAll: () => Promise<void>;
  refreshProject: (projectId: string) => Promise<void>;
  refreshVoiceCharacters: (projectId: string) => Promise<void>;
  runBusyAction: RunBusyAction;
}) {
  async function createProject() {
    await args.runBusyAction(CREATE_PROJECT_ACTION_KEY, async () => {
      args.setError(null);
      try {
        const project = await apiPost<Project>("/api/projects", projectInputFromDraft(args.draft, args.textModelOptions));
        await apiPost(`/api/projects/${project.id}/plan`);
        await args.refreshAll();
        args.setSelectedId(project.id);
      } catch (createError) {
        args.setError(readError(createError));
      }
    });
  }

  async function createPlan() {
    const projectId = args.selectedId;
    if (!projectId) return;
    await args.runBusyAction(projectPlanActionKey(projectId), async () => {
      try {
        await apiPost(`/api/projects/${projectId}/plan`, projectInputFromDraft(args.draft, args.textModelOptions));
        await args.refreshProject(projectId);
      } catch (planError) {
        args.setError(readError(planError));
      }
    });
  }

  async function revisePlanWithMessage(message: string, onSuccess?: () => void) {
    const planId = args.selectedDetails?.currentPlan?.id;
    const projectId = args.selectedDetails?.id;
    const trimmedMessage = message.trim();
    if (!planId || !projectId || !trimmedMessage) return;
    await args.runBusyAction(planRevisionActionKey(planId), async () => {
      try {
        await apiPost(`/api/plans/${planId}/messages`, { message: trimmedMessage });
        onSuccess?.();
        await args.refreshProject(projectId);
      } catch (revisionError) {
        args.setError(readError(revisionError));
      }
    });
  }

  async function approvePlan() {
    const planId = args.selectedDetails?.currentPlan?.id;
    const projectId = args.selectedDetails?.id;
    if (!planId || !projectId) return;
    await args.runBusyAction(planApproveActionKey(planId), async () => {
      try {
        await apiPost(`/api/plans/${planId}/approve`);
        await args.refreshProject(projectId);
      } catch (approveError) {
        args.setError(readError(approveError));
      }
    });
  }

  async function resumeProject() {
    const projectId = args.selectedId;
    if (!projectId) return;
    await args.runBusyAction(projectResumeActionKey(projectId), async () => {
      args.setError(null);
      try {
        await apiPost(`/api/projects/${projectId}/resume`);
        await args.refreshProject(projectId);
      } catch (resumeError) {
        args.setError(readError(resumeError));
      }
    });
  }

  async function stopProject() {
    const projectId = args.selectedId;
    if (!projectId) return;
    await args.runBusyAction(projectStopActionKey(projectId), async () => {
      args.setError(null);
      try {
        await apiPost(`/api/projects/${projectId}/stop`);
        await args.refreshProject(projectId);
      } catch (stopError) {
        args.setError(readError(stopError));
      }
    });
  }

  async function regenerateCover() {
    const projectId = args.selectedId;
    if (!projectId) return;
    await args.runBusyAction(projectCoverActionKey(projectId), async () => {
      args.setError(null);
      try {
        await apiPost(`/api/projects/${projectId}/cover`);
        await args.refreshProject(projectId);
      } catch (coverError) {
        args.setError(readError(coverError));
      }
    });
  }

  async function approveVoiceCharacter(character: VoiceCharacter) {
    await args.runBusyAction(voiceCharacterActionKey(character.id, "approve"), async () => {
      args.setError(null);
      try {
        await apiPost(`/api/projects/${character.projectId}/voice-characters/${character.id}/approve`);
        await args.refreshVoiceCharacters(character.projectId);
        await args.refreshProject(character.projectId);
      } catch (voiceError) {
        args.setError(readError(voiceError));
      }
    });
  }

  async function rejectVoiceCharacter(character: VoiceCharacter) {
    await args.runBusyAction(voiceCharacterActionKey(character.id, "reject"), async () => {
      args.setError(null);
      try {
        await apiPost(`/api/projects/${character.projectId}/voice-characters/${character.id}/reject`);
        await args.refreshVoiceCharacters(character.projectId);
      } catch (voiceError) {
        args.setError(readError(voiceError));
      }
    });
  }

  async function updateVoiceCharacterProfile(character: VoiceCharacter, patch: Partial<VoiceProfile>) {
    await args.runBusyAction(voiceCharacterActionKey(character.id, "voice-profile"), async () => {
      args.setError(null);
      try {
        await apiPatch(`/api/projects/${character.projectId}/voice-characters/${character.id}/voice-profile`, patch);
        await args.refreshVoiceCharacters(character.projectId);
      } catch (voiceError) {
        args.setError(readError(voiceError));
      }
    });
  }

  return {
    createProject,
    createPlan,
    revisePlanWithMessage,
    approvePlan,
    resumeProject,
    stopProject,
    regenerateCover,
    approveVoiceCharacter,
    rejectVoiceCharacter,
    updateVoiceCharacterProfile
  };
}
