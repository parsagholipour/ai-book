export function planRevisionConsistencyWarning(input: {
  durableGenerationJobId: string | undefined;
  linkedGenerationJobId: string | null | undefined;
  linkedLedgerEntryId: string | null | undefined;
  payloadLedgerEntryId: string | null;
}): "operation_job_mismatch" | "billing_link_mismatch" | null {
  if (!input.durableGenerationJobId || input.linkedGenerationJobId !== input.durableGenerationJobId) {
    return "operation_job_mismatch";
  }
  if (
    (input.linkedLedgerEntryId || input.payloadLedgerEntryId) &&
    input.linkedLedgerEntryId !== input.payloadLedgerEntryId
  ) {
    return "billing_link_mismatch";
  }
  return null;
}
