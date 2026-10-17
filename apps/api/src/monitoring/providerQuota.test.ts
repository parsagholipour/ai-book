import { describe, expect, it, vi } from "vitest";
import { PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS } from "@book-maker/core";
import { freshAlertState } from "./alertState.js";
import {
  PROVIDER_QUOTA_ACCOUNTS,
  providerCallOutcomesSource,
  providerQuotaObservations,
  quotaAccountOf,
  type ProviderCallOutcome
} from "./providerQuota.js";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 9, minute));

function observe(outcomes: ProviderCallOutcome[], firing: string[] = []) {
  const previous = new Map(firing.map((key) => [key, { ...freshAlertState(key), firing: true }]));
  return new Map(providerQuotaObservations(outcomes, previous));
}

describe("providerQuotaObservations", () => {
  it("has a condition for every billed account and none for the local server", () => {
    expect(PROVIDER_QUOTA_ACCOUNTS).toEqual(expect.arrayContaining(["openai", "gemini", "deepseek", "deepinfra", "openrouter", "alibaba"]));
    expect(PROVIDER_QUOTA_ACCOUNTS).not.toContain("openai-compatible");
    expect(observe([]).size).toBe(PROVIDER_QUOTA_ACCOUNTS.length);
  });

  it("fails an account whose latest refusal is newer than its latest answer, and says so in numbers", () => {
    const observations = observe([
      { provider: "openai", exhaustedAt: at(42), refusals: 41, answeredAt: at(5) },
      { provider: "deepseek", exhaustedAt: null, refusals: 0, answeredAt: at(43) }
    ]);
    expect(observations.get("provider_quota_openai")).toEqual({
      failing: true,
      detail:
        "41 calls to OpenAI refused in the last hour for an account out of credit or quota (latest 2026-10-16 09:42 UTC), and none answered since; where routing names a fallback, that provider is doing this one's work"
    });
    expect(observations.get("provider_quota_deepseek")).toEqual({ failing: false });
  });

  it("clears an account on the first call it answers after its last refusal", () => {
    expect(observe([{ provider: "openai", exhaustedAt: at(42), refusals: 3, answeredAt: at(44) }]).get("provider_quota_openai")).toEqual({
      failing: false
    });
  });

  it("holds a firing account through a window with no call to it, and passes one that never fired", () => {
    expect(observe([], ["provider_quota_gemini"]).get("provider_quota_gemini")).toBeNull();
    expect(observe([]).get("provider_quota_gemini")).toEqual({ failing: false });
  });

  it("reads a product's rows as its account's: Gemini speech answering clears a Gemini refusal", () => {
    expect(quotaAccountOf("gemini_tts")).toBe("gemini");
    expect(quotaAccountOf("openai_realtime")).toBe("openai");
    expect(quotaAccountOf("vercel-ai-gateway")).toBe("vercel-ai-gateway");
    expect(quotaAccountOf("openai-compatible")).toBeUndefined();
    expect(quotaAccountOf("fake")).toBeUndefined();
    const observations = observe([
      { provider: "gemini", exhaustedAt: at(10), refusals: 724, answeredAt: null },
      { provider: "gemini_tts", exhaustedAt: null, refusals: 0, answeredAt: at(12) }
    ]);
    expect(observations.get("provider_quota_gemini")).toEqual({ failing: false });
  });
});

describe("providerCallOutcomesSource", () => {
  it("groups the window's rows by provider on the stable mark, and reads Postgres' bigint counts", async () => {
    const queryRaw = vi.fn(async (..._args: unknown[]) => [{ provider: "openai", exhaustedAt: at(42), refusals: 41n, answeredAt: null }]);
    const since = at(0);

    const outcomes = await providerCallOutcomesSource({ $queryRaw: queryRaw as never })(since);

    expect(outcomes).toEqual([{ provider: "openai", exhaustedAt: at(42), refusals: 41, answeredAt: null }]);
    const [strings, ...values] = queryRaw.mock.calls[0]!;
    const sql = (strings as TemplateStringsArray).join("?");
    expect(sql).toContain(`FROM "ProviderCallLog"`);
    expect(sql).toContain(`WHERE "createdAt" >= ?`);
    expect(sql).toContain(`GROUP BY "provider"`);
    expect(values).toEqual([
      PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS,
      PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS,
      PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS,
      since
    ]);
  });
});
