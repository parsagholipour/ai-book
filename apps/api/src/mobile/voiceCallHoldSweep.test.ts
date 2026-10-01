import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { releaseReservationsByKeyPrefix } from "@book-maker/db/billing";
import { mockPrisma, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import { resetVoiceCallTestState } from "./testing/voiceCallTestUtils.js";
import { sweepStaleVoiceCalls } from "./voiceCalls.js";

describe("voice call hold sweep", () => {
  beforeEach(() => {
    resetVoiceCallTestState();
    mockPrisma.creditLedgerEntry.findMany.mockResolvedValue([]);
    vi.mocked(releaseReservationsByKeyPrefix).mockResolvedValue(1);
  });
  afterEach(teardownMobileHarness);

  it("releases a hold its ended call never learned about", async () => {
    // July 2026: the hold was reserved, the call ended before its row recorded
    // it, and nothing read ENDED calls — 180 credits on hold for months.
    mockPrisma.creditLedgerEntry.findMany.mockResolvedValue([
      { idempotencyKey: "mobile:voice-call:call-ended:hold:0" },
      { idempotencyKey: "mobile:voice-call:call-live:hold:1" },
      { idempotencyKey: "mobile:voice-call:call-ended:charge" }
    ]);
    mockPrisma.voiceCall.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.id ? [{ id: "call-live" }] : []
    );

    await expect(sweepStaleVoiceCalls(new Date("2026-10-01T04:00:00Z"))).resolves.toBe(1);

    const ledgerWhere = mockPrisma.creditLedgerEntry.findMany.mock.calls[0]![0].where;
    expect(ledgerWhere).toMatchObject({ status: "RESERVED", operation: "VOICE_CALL_MINUTE" });
    expect(vi.mocked(releaseReservationsByKeyPrefix).mock.calls).toEqual([
      ["mobile:voice-call:call-ended:hold:", expect.any(String)]
    ]);
  });

  it("touches nothing when no hold is open", async () => {
    await expect(sweepStaleVoiceCalls(new Date("2026-10-01T04:00:00Z"))).resolves.toBe(0);
    expect(releaseReservationsByKeyPrefix).not.toHaveBeenCalled();
  });
});
