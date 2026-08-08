/** Installs the attempt-aware billing fake shared by the mobile route suites. */
export function installGenerationAttemptMock(options: {
  mockBilling: any;
  mockPrisma: any;
  state: { generationAttempts: any[]; bookEditOperations: any[] };
}): void {
  const { mockBilling, mockPrisma, state } = options;
  mockBilling.startGenerationAttempt.mockImplementation(async (start: any) => {
    const existing = state.generationAttempts.find((attempt) => attempt.commandKey === start.commandKey);
    if (existing) {
      if (
        existing.userId !== start.userId ||
        existing.requestFingerprint !== start.requestFingerprint ||
        existing.operation !== start.operation ||
        existing.quotedCredits !== start.quotedCredits
      ) {
        throw new mockBilling.GenerationAttemptConflictError();
      }
      return { replayed: true, attempt: existing };
    }
    if (start.retryOfAttemptId) {
      const retryChild = state.generationAttempts.find(
        (attempt) => attempt.retryOfAttemptId === start.retryOfAttemptId
      );
      if (retryChild) return { replayed: true, attempt: retryChild };
    }

    const attemptId = `attempt-${String(start.commandKey).replaceAll(":", "-")}`;
    let quotaClaim = null;
    if (start.imageQuotaLimit !== null && start.imageQuotaLimit !== undefined) {
      quotaClaim = await mockBilling.consumeIllustratedBookUse({
        userId: start.userId,
        limit: start.imageQuotaLimit
      });
      if (!quotaClaim.allowed) throw new mockBilling.GenerationQuotaExceededError(quotaClaim);
    }
    const reservation = await mockBilling.reserveCredits({
      userId: start.userId,
      projectId: start.projectId,
      operation: start.operation,
      amountCredits: start.quotedCredits,
      idempotencyKey: `generation-attempt:${attemptId}`,
      description: start.description,
      metadata: {
        ...start.metadata,
        ...(quotaClaim ? { imageQuota: { periodKey: quotaClaim.periodKey } } : {})
      }
    });
    const ledgerEntry = reservation ? await mockBilling.commitReservedCredits(reservation.id) : null;
    const domain = await start.create(mockPrisma, { attemptId, ledgerEntry });
    if (start.grantExportEntitlement) {
      await mockBilling.grantProjectEntitlement({
        userId: start.userId,
        projectId: domain.projectId,
        type: "EXPORT_UNLOCK",
        source: "full_generation_credits",
        creditsCost: start.quotedCredits,
        relatedLedgerEntryId: ledgerEntry?.id ?? null
      });
    }
    const attempt = {
      id: attemptId,
      userId: start.userId,
      commandKey: start.commandKey,
      requestFingerprint: start.requestFingerprint,
      status: "QUEUED",
      operation: start.operation,
      quotedCredits: start.quotedCredits,
      projectId: domain.projectId,
      editOperationId: domain.editOperationId ?? null,
      ledgerEntryId: ledgerEntry?.id ?? null,
      primaryJobId: domain.primaryJobId,
      retryOfAttemptId: start.retryOfAttemptId ?? null,
      error: null,
      refundPending: false,
      createdAt: new Date()
    };
    state.generationAttempts.push(attempt);
    if (domain.editOperationId) {
      const editOperation = state.bookEditOperations.find((operation) => operation.id === domain.editOperationId);
      if (editOperation) {
        editOperation.generationAttempts = [attempt, ...(editOperation.generationAttempts ?? [])];
      }
    }
    return { replayed: false, attempt };
  });
}
