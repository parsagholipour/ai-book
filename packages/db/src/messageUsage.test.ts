import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CREDIT_COSTS, messagePolicy, resetCreditPricing, setCreditPricing } from "@book-maker/core";

const db = await vi.hoisted(async () => (await import("./testing/billingTestDb.js")).createBillingTestDb());
vi.mock("./client.ts", () => ({ prisma: db.prisma, Prisma: db.Prisma }));
const { getMessageAllowance, reserveMessageUsage, settleMessageUsage, resetMessageAllowance, getCreditBalance, renewMessageUsage, recoverMessageUsage, completeMessageUsage } = await import("./billing.ts");
const now = new Date("2026-09-10T23:59:00Z");
const userId = "user-a";
const send = (requestKey: string) => reserveMessageUsage({ userId, requestKey, now });
const reset = async (expectedCredits = 50) => resetMessageAllowance({ userId, resetToken: (await getMessageAllowance(userId, now)).resetToken, expectedCredits, now });

beforeEach(() => {
  db.reset();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  resetCreditPricing();
  // This suite models transaction rollback too: a failed credit reservation
  // must not leak a quota write. Existing billing tests use the lighter fake.
  db.prisma.$transaction.mockImplementation(async (work) => {
    const snapshot = structuredClone(db.state);
    try { return await work(db.prisma); }
    catch (error) { Object.assign(db.state, snapshot); throw error; }
  });
});
afterEach(() => { resetCreditPricing(); vi.useRealTimers(); });

function price(values: Partial<typeof DEFAULT_CREDIT_COSTS> | Record<string, number>) {
  setCreditPricing({ ...DEFAULT_CREDIT_COSTS, ...values });
}

describe("ordinary message allowance", () => {
  it("returns an abandoned send's slot and credits without requiring its client to retry", async () => {
    price({ messageCreditsFree: 7 });
    await send("advisor:abandoned");
    const later = new Date(now.getTime() + 20 * 60_000);
    vi.setSystemTime(later);
    await getMessageAllowance(userId, later);
    expect(await getCreditBalance(userId, later)).toMatchObject({ availableCredits: 1000, reservedCredits: 0 });
    expect([...db.state.messageReservations.values()][0]?.status).toBe("REFUNDED");
    await expect(reserveMessageUsage({ userId, requestKey: "advisor:abandoned", now: later })).resolves.toBeTruthy();
  });

  it("keeps a heartbeating request alive and recovers it after heartbeats stop", async () => {
    price({ messageCreditsFree: 7 });
    const requestKey = "advisor:live";
    const leaseId = await send(requestKey);
    const lease = { userId, requestKey, leaseId };
    const heartbeatAt = new Date(now.getTime() + 8 * 60_000);
    expect(await renewMessageUsage(lease, heartbeatAt)).toBe(true);
    expect(await recoverMessageUsage({ now: new Date(now.getTime() + 12 * 60_000) })).toBe(0);
    expect(await recoverMessageUsage({ now: new Date(now.getTime() + 20 * 60_000) })).toBe(1);
    expect(await renewMessageUsage(lease)).toBe(false);
  });

  it("an expired attempt cannot publish, settle or refund its replacement", async () => {
    price({ messageCreditsFree: 7 });
    const requestKey = "advisor:retry";
    const first = { userId, requestKey, leaseId: await send(requestKey) };
    const later = new Date(now.getTime() + 20 * 60_000);
    vi.setSystemTime(later);
    const leaseId = await reserveMessageUsage({ userId, requestKey, now: later });
    expect(leaseId).not.toBe(first.leaseId);
    const write = vi.fn(async () => "reply");
    await expect(completeMessageUsage(first, write)).rejects.toMatchObject({ code: "REQUEST_IN_PROGRESS" });
    expect(write).not.toHaveBeenCalled();
    await settleMessageUsage(userId, requestKey, false, first.leaseId);
    await settleMessageUsage(userId, requestKey, true, first.leaseId);
    expect(await getCreditBalance(userId, later)).toMatchObject({ reservedCredits: 7, lifetimeCreditsSpent: 0 });
    await completeMessageUsage({ userId, requestKey, leaseId }, write);
    expect(await getCreditBalance(userId, later)).toMatchObject({ reservedCredits: 0, lifetimeCreditsSpent: 7 });
  });

  it("a reply and its charge commit or roll back together", async () => {
    price({ messageCreditsFree: 7 });
    const requestKey = "project:book:atomic";
    const lease = { userId, requestKey, leaseId: await send(requestKey) };
    const write = (tx: Parameters<Parameters<typeof completeMessageUsage>[1]>[0]) => tx.projectChatMessage.create({
      data: { projectId: "book", role: "ASSISTANT", content: "Here is the reply.", metadata: {} }
    });
    db.prisma.creditLedgerEntry.update.mockRejectedValueOnce(new Error("commit unavailable"));
    await expect(completeMessageUsage(lease, write)).rejects.toThrow("commit unavailable");
    expect(db.state.projectChatMessages.size).toBe(0);
    expect(await getCreditBalance(userId, now)).toMatchObject({ reservedCredits: 7, lifetimeCreditsSpent: 0 });
    await completeMessageUsage(lease, write);
    await settleMessageUsage(userId, requestKey, false, lease.leaseId); // Error while serializing the already-saved response.
    expect(db.state.projectChatMessages.size).toBe(1);
    expect(await getCreditBalance(userId, now)).toMatchObject({ reservedCredits: 0, lifetimeCreditsSpent: 7 });
  });

  it.each(["creation-start", "creation", "project"])("settles a saved legacy %s reply instead of refunding it", async (scope) => {
    price({ messageCreditsFree: 7 });
    const requestKey = scope === "creation-start" ? "creation-start:request" : `${scope}:book:request`;
    await send(requestKey);
    db.state.creationDrafts.set("book", { id: "book", userId, requestId: "request", payload: { messages: [{ role: "user", requestId: "request" }, { role: "assistant", content: "A reply" }] } });
    db.state.projectChatMessages.set("user", { id: "user", projectId: "book", requestId: "request", role: "USER" });
    db.state.projectChatMessages.set("reply", { id: "reply", projectId: "book", parentId: "user", role: "ASSISTANT" });
    const later = new Date(now.getTime() + 20 * 60_000);
    expect(await recoverMessageUsage({ now: later })).toBe(1);
    expect(await getCreditBalance(userId, later)).toMatchObject({ reservedCredits: 0, lifetimeCreditsSpent: 7 });
  });

  it.each([
    ["free", 50, 50], ["creator", 150, 100], ["pro", 300, 150], ["max", 600, 200]
  ] as const)("defaults %s to %i messages and a %i credit reset", (tier, dailyLimit, resetCredits) => {
    expect(messagePolicy(tier)).toMatchObject({ dailyLimit, resetCredits, creditsPerMessage: 0, resetEnabled: true });
  });

  it("counts free messages across chats and prevents a second claim of the same request", async () => {
    await send("creation:draft-a:request-1");
    await send("project:book-b:request-2");
    await expect(send("creation:draft-a:request-1")).rejects.toMatchObject({ code: "REQUEST_IN_PROGRESS" });
    expect(await getMessageAllowance(userId, now)).toMatchObject({ used: 2, remaining: 48, resetsAt: "2026-09-11T00:00:00.000Z" });
    expect(db.state.ledger.size).toBe(0);
    expect(await getMessageAllowance("user-b", now)).toMatchObject({ used: 0, remaining: 50 });
  });

  it("blocks at the cap before billing and renews at UTC midnight", async () => {
    price({ messageDailyLimitFree: 1, messageCreditsFree: 7 });
    await send("first");
    await settleMessageUsage(userId, "first", true);
    await expect(send("blocked")).rejects.toMatchObject({ code: "MESSAGE_LIMIT_REACHED" });
    expect(await getCreditBalance(userId, now)).toMatchObject({ lifetimeCreditsSpent: 7, reservedCredits: 0 });
    expect(await getMessageAllowance(userId, new Date("2026-09-11T00:00:00Z"))).toMatchObject({ used: 0, remaining: 1 });
  });

  it("refunds failed sends once and gives retries their own charge", async () => {
    price({ messageCreditsFree: 7 });
    await send("retry-me");
    await settleMessageUsage(userId, "retry-me", false);
    await settleMessageUsage(userId, "retry-me", false);
    expect(await getMessageAllowance(userId, now)).toMatchObject({ used: 0 });
    expect(await getCreditBalance(userId, now)).toMatchObject({ availableCredits: 1000, reservedCredits: 0 });
    await send("retry-me");
    await settleMessageUsage(userId, "retry-me", true);
    await settleMessageUsage(userId, "retry-me", true);
    expect(await getCreditBalance(userId, now)).toMatchObject({ availableCredits: 993, lifetimeCreditsSpent: 7 });
  });

  it("does not spend a slot when there are insufficient credits", async () => {
    price({ messageCreditsFree: 7, freeMonthlyCredits: 0 });
    await expect(send("too-costly")).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(await getMessageAllowance(userId, now)).toMatchObject({ used: 0 });
    expect(db.state.messageReservations.size).toBe(0);
  });

  it("charges one reset and restores the allowance without moving midnight", async () => {
    price({ messageDailyLimitFree: 1 });
    await send("first");
    const before = await getMessageAllowance(userId, now);
    const request = { userId, resetToken: before.resetToken, expectedCredits: 50, now };
    await resetMessageAllowance(request);
    await send("second");
    await resetMessageAllowance(request); // Late retry after the replacement allowance was spent.
    expect(await getMessageAllowance(userId, now)).toMatchObject({ remaining: 0, resetToken: "2026-09-10:1:1", resetsAt: before.resetsAt });
    expect(await getCreditBalance(userId, now)).toMatchObject({ availableCredits: 950, lifetimeCreditsSpent: 50 });
    await reset();
    expect(await getMessageAllowance(userId, now)).toMatchObject({ remaining: 1, resetToken: "2026-09-10:2:1" });
  });

  it("a previous cycle's failure does not restore a slot in the new cycle", async () => {
    price({ messageDailyLimitFree: 1 });
    await send("before-reset");
    await reset();
    await send("after-reset");
    await settleMessageUsage(userId, "before-reset", false);
    expect(await getMessageAllowance(userId, now)).toMatchObject({ used: 1, remaining: 0 });
  });

  it("refuses premature resets, disabled resets, changed quotes and yesterday's tokens", async () => {
    await expect(reset()).rejects.toMatchObject({ code: "MESSAGE_RESET_UNAVAILABLE" });
    price({ messageDailyLimitFree: 1 });
    await send("first");
    price({ messageDailyLimitFree: 1, messageResetEnabledFree: 0 });
    await expect(reset()).rejects.toMatchObject({ code: "MESSAGE_RESET_UNAVAILABLE" });
    price({ messageDailyLimitFree: 1, messageResetCreditsFree: 70 });
    await expect(reset(50)).rejects.toMatchObject({ code: "MESSAGE_QUOTE_CHANGED" });
    await expect(resetMessageAllowance({ userId, resetToken: "2026-09-09:0", expectedCredits: 70, now })).rejects.toMatchObject({ code: "MESSAGE_QUOTE_CHANGED" });
  });

  it("does not reset usage or advance the token if credits are insufficient", async () => {
    price({ messageDailyLimitFree: 1, freeMonthlyCredits: 0 });
    await send("first");
    await expect(reset()).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(await getMessageAllowance(userId, now)).toMatchObject({ used: 1, resetToken: "2026-09-10:0:1" });
  });

  it("supports zero-credit resets, while a zero daily cap disables sends and resets", async () => {
    price({ messageDailyLimitFree: 1, messageResetCreditsFree: 0 });
    await send("first");
    await reset(0);
    expect(await getMessageAllowance(userId, now)).toMatchObject({ remaining: 1 });
    expect(db.state.ledger.size).toBe(0);
    price({ messageDailyLimitFree: 0 });
    await expect(send("disabled")).rejects.toMatchObject({ code: "MESSAGE_LIMIT_REACHED" });
    await expect(reset()).rejects.toMatchObject({ code: "MESSAGE_RESET_UNAVAILABLE" });
  });

  it("re-quotes a reset when the administrator changes how many messages it restores", async () => {
    price({ messageDailyLimitFree: 2 });
    await send("first");
    await send("second");
    const quote = await getMessageAllowance(userId, now);
    price({ messageDailyLimitFree: 1 });
    await expect(resetMessageAllowance({ userId, resetToken: quote.resetToken, expectedCredits: 50, now })).rejects.toMatchObject({ code: "MESSAGE_QUOTE_CHANGED" });
    expect(await getMessageAllowance(userId, now)).toMatchObject({ used: 2 });
  });

  it("uses the live subscription plan's overrides and retains usage when the plan changes", async () => {
    await send("on-free");
    db.state.entitlements.set("pro", {
      id: "pro", userId, projectId: null, type: "PRO_PLAN", status: "ACTIVE", source: "google_play_subscription",
      creditsCost: 0, relatedLedgerEntryId: null, purchaseRecordId: null, startsAt: now, expiresAt: null
    });
    price({ messageDailyLimitPro: 420, messageCreditsPro: 3, messageResetCreditsPro: 80, messageResetEnabledPro: 0 });
    expect(await getMessageAllowance(userId, now)).toMatchObject({ tier: "pro", used: 1, remaining: 419, creditsPerMessage: 3, resetCredits: 80, resetEnabled: false });
    db.state.entitlements.clear();
    expect(await getMessageAllowance(userId, now)).toMatchObject({ tier: "free", used: 1, remaining: 49 });
  });

  it("retries serialization conflicts without executing an extra charge", async () => {
    db.prisma.$transaction.mockRejectedValueOnce({ code: "P2034" });
    await send("race");
    expect(await getMessageAllowance(userId, now)).toMatchObject({ used: 1 });
    expect(db.prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
