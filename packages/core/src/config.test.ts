import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

function productionConfig(env: NodeJS.ProcessEnv = {}) {
  return loadConfig({ NODE_ENV: "production", S3_BUCKET: "test-private-bucket", ...env });
}

describe("DEBUG_MODE", () => {
  it("requires an explicit opt-in and keeps production mocks off", () => {
    expect(productionConfig().DEBUG_MODE).toBe(false);
    expect(productionConfig({ DEBUG_MODE: "false" }).DEBUG_MODE).toBe(false);
    expect(productionConfig({ DEBUG_MODE: "true" })).toMatchObject({
      DEBUG_MODE: true, NODE_ENV: "production", MOCK_AI: false,
      MOCK_GOOGLE_PLAY_BILLING: false, MOCK_EMAIL: false, MOCK_PUSH: false
    });
    expect(() => productionConfig({ DEBUG_MODE: "typo" })).toThrow(/DEBUG_MODE must be true or false/);
  });
});

describe("TRUST_PROXY_HOPS", () => {
  it("defaults to 0 when unset outside production", () => {
    expect(loadConfig({}).TRUST_PROXY_HOPS).toBe(0);
  });

  it("defaults to 2 in production when unset", () => {
    expect(productionConfig().TRUST_PROXY_HOPS).toBe(2);
  });

  it("keeps an explicit 0 in production", () => {
    expect(productionConfig({ TRUST_PROXY_HOPS: "0" }).TRUST_PROXY_HOPS).toBe(0);
  });

  it("keeps an explicit 2 in production", () => {
    expect(productionConfig({ TRUST_PROXY_HOPS: "2" }).TRUST_PROXY_HOPS).toBe(2);
  });
});
