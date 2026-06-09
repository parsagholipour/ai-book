export const CREATE_PROJECT_ACTION_KEY = "create-project";
export const resumableJobTypes = new Set(["GENERATE_BOOK", "GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT"]);
export const VOICE_CHARACTER_JOB_TYPES = new Set(["PREPARE_CHARACTER_CANDIDATES", "BUILD_CHARACTER_PERSONA"]);

export function projectPlanActionKey(projectId: string): string {
  return `project:${projectId}:plan`;
}

export function projectResumeActionKey(projectId: string): string {
  return `project:${projectId}:resume`;
}

export function projectStopActionKey(projectId: string): string {
  return `project:${projectId}:stop`;
}

export function projectCoverActionKey(projectId: string): string {
  return `project:${projectId}:cover`;
}

export function voiceCharacterActionKey(characterId: string, action: string): string {
  return `voice-character:${characterId}:${action}`;
}

export function planRevisionActionKey(planId: string): string {
  return `plan:${planId}:revision`;
}

export function planApproveActionKey(planId: string): string {
  return `plan:${planId}:approve`;
}
