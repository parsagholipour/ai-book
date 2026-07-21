export function planRevisionConsistencyWarning(input: {
  durableGenerationJobId: string | undefined;
  linkedGenerationJobId: string | null | undefined;
  linkedLedgerEntryId: string | null | undefined;
  payloadLedgerEntryId: string | null;
  billingRequired?: boolean;
}): "operation_job_mismatch" | "billing_link_mismatch" | "billing_link_missing" | null {
  if (!input.durableGenerationJobId || input.linkedGenerationJobId !== input.durableGenerationJobId) {
    return "operation_job_mismatch";
  }
  if (input.billingRequired && (!input.linkedLedgerEntryId || !input.payloadLedgerEntryId)) {
    return "billing_link_missing";
  }
  if (
    (input.linkedLedgerEntryId || input.payloadLedgerEntryId) &&
    input.linkedLedgerEntryId !== input.payloadLedgerEntryId
  ) {
    return "billing_link_mismatch";
  }
  return null;
}
