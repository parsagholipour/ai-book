import { MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION } from "./manuscriptQualityIssue.js";

export const ANTI_SLOP_QUALITY_REVISION_NOTE =
  `Anti-slop Phase 05 rollout; detector ${MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION}. Mandatory integrity is not a disableable tier list.`;

/**
 * Note-only quality-revision patch. Do not mutate production from tests.
 * Operators append via `PATCH /api/admin/generation-quality` with this note;
 * the existing append-only route preserves unrelated settings and unknown fields.
 */
export function buildAntiSlopQualityRevisionPatch(stored: unknown): {
  note: string;
  settings: Record<string, unknown>;
} {
  const settings = cloneJsonObject(stored);
  for (const id of Object.keys(settings)) {
    if (looksLikeMandatoryIntegrityKey(id)) {
      delete settings[id];
    }
  }
  return {
    note: ANTI_SLOP_QUALITY_REVISION_NOTE,
    settings
  };
}

function looksLikeMandatoryIntegrityKey(id: string): boolean {
  return id.startsWith("integrity.") || id === "mandatoryIntegrity";
}

function cloneJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function qualityRevisionEncodesMandatoryIntegrity(settings: Record<string, unknown>): boolean {
  return Object.keys(settings).some((id) => looksLikeMandatoryIntegrityKey(id));
}
