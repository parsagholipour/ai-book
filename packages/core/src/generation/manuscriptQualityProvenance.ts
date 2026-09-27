import { createHash } from "node:crypto";

/** IDs are derived locally; model-proposed links are validated before becoming
 * provenance. Never infer finding identity from page overlap. */
export type ManuscriptQualityProvenance = {
  findingId?: string;
  /** Validated aliases selected in the same manuscript's coverage assessment. */
  relatedFindingIds?: string[];
  primaryPageIndex?: number;
  relatedPageIndexes?: number[];
  repairOperationId?: string;
  kind?: "manuscript" | "repair";
  verification?: "unverified";
};
const pageIndex = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0;
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;

export function optionalQualityProvenance(value: unknown): { provenance?: ManuscriptQualityProvenance } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const provenance: ManuscriptQualityProvenance = {
    ...(identifier(record.findingId) ? { findingId: record.findingId } : {}),
    ...(Array.isArray(record.relatedFindingIds) && record.relatedFindingIds.length <= 64 && record.relatedFindingIds.every(identifier)
      ? { relatedFindingIds: [...new Set(record.relatedFindingIds)] } : {}),
    ...(pageIndex(record.primaryPageIndex) ? { primaryPageIndex: record.primaryPageIndex } : {}),
    ...(Array.isArray(record.relatedPageIndexes) && record.relatedPageIndexes.every(pageIndex)
      ? { relatedPageIndexes: [...new Set(record.relatedPageIndexes)].filter(index => index !== record.primaryPageIndex).sort((a, b) => a - b) } : {}),
    ...(identifier(record.repairOperationId) ? { repairOperationId: record.repairOperationId } : {}),
    ...(record.kind === "manuscript" || record.kind === "repair" ? { kind: record.kind } : {}),
    ...(record.verification === "unverified" ? { verification: record.verification } : {})
  };
  return Object.keys(provenance).length ? { provenance } : {};
}

export function pageFindingProvenance(primaryPageIndex: number, diagnosis: string, relatedPageIndexes: readonly number[] = []): ManuscriptQualityProvenance {
  return {
    findingId: `finding-${createHash("sha256").update(JSON.stringify([primaryPageIndex, diagnosis.trim()])).digest("hex").slice(0, 24)}`,
    primaryPageIndex, relatedPageIndexes: [...new Set(relatedPageIndexes)].filter(index => index !== primaryPageIndex).sort((a, b) => a - b),
    kind: "manuscript"
  };
}
