/**
 * Jobs that produce optional experiences from an existing book rather than
 * changing the book itself. Their durable rows own their lifecycle; they must
 * never move Project.status.
 *
 * The allowlist is intentionally narrow. An unknown future job defaults to the
 * book lifecycle until its independent owner and failure handling are explicit.
 */
export const DERIVATIVE_GENERATION_JOBS = {
  PREPARE_CHARACTER_CANDIDATES: "prepare-character-candidates",
  BUILD_CHARACTER_PERSONA: "build-character-persona",
  GENERATE_AUDIOBOOK: "generate-audiobook"
} as const;

export type DerivativeGenerationJobType = keyof typeof DERIVATIVE_GENERATION_JOBS;
export type DerivativeWorkerJobName = (typeof DERIVATIVE_GENERATION_JOBS)[DerivativeGenerationJobType];

const derivativeJobTypes = new Set<string>(Object.keys(DERIVATIVE_GENERATION_JOBS));
const derivativeWorkerJobNames = new Set<string>(Object.values(DERIVATIVE_GENERATION_JOBS));

export function isDerivativeGenerationJobType(type: string): type is DerivativeGenerationJobType {
  return derivativeJobTypes.has(type);
}

export function isDerivativeWorkerJobName(name: string): name is DerivativeWorkerJobName {
  return derivativeWorkerJobNames.has(name);
}

export function generationJobControlsProjectStatus(type: string): boolean {
  return !isDerivativeGenerationJobType(type);
}

export function workerJobControlsProjectStatus(name: string): boolean {
  return !isDerivativeWorkerJobName(name);
}
