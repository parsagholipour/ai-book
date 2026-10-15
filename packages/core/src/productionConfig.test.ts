import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  enforceProductionConfig,
  MOCK_AI_IN_PRODUCTION_MESSAGE,
  ProductionConfigError,
  productionConfigReport,
  webPasswordProblem,
  type ProductionConfigIssue
} from "./productionConfig.js";

const SECRETS = {
  webPassword: "k3J9-qT7v-Lm2x-Pz8r-SECRETPW",
  privateKey: "-----BEGIN PRIVATE KEY-----\nSECRETKEYBYTES\n-----END PRIVATE KEY-----\n",
  smtp: "smtps://mailer:SECRETSMTP@smtp.mail.test:465",
  deepseek: "sk-SECRETDEEPSEEK",
  deepinfra: "SECRETDEEPINFRA",
  gemini: "SECRETGEMINI",
  alibaba: "sk-SECRETALIBABA",
  openai: "sk-SECRETOPENAI"
};

/** Everything a production API needs, with values that must never appear in output. */
const COMPLETE: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  S3_BUCKET: "test-private-bucket",
  PUBLIC_API_URL: "https://tomeza.ravanix.app",
  WEB_PASSWORD: SECRETS.webPassword,
  GOOGLE_PLAY_PACKAGE_NAME: "com.tomeza.tomeza",
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: "play@tomeza.iam.gserviceaccount.com",
    private_key: SECRETS.privateKey
  }),
  GOOGLE_PLAY_RTDN_AUDIENCE: "https://tomeza.ravanix.app/api/billing/google-play/rtdn",
  GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: "play-rtdn-push@tomeza.iam.gserviceaccount.com",
  SMTP_URL: SECRETS.smtp,
  GOOGLE_SIGN_IN_CLIENT_ID: "123-web.apps.googleusercontent.com",
  OPERATOR_ALERT_EMAIL: "owner@ravanix.app",
  DEEPSEEK_API_KEY: SECRETS.deepseek,
  DEEPINFRA_API_KEY: SECRETS.deepinfra,
  GEMINI_API_KEY: SECRETS.gemini,
  ALIBABA_API_KEY: SECRETS.alibaba,
  OPENAI_API_KEY: SECRETS.openai
};

/**
 * Today's checklist. A provider added to the default routing fails this list
 * on purpose: `deploy/production.env.example` and docs/deployment.md list the
 * same names and have to move with it.
 */
const REQUIRED_FOR_API = [
  "GOOGLE_PLAY_PACKAGE_NAME",
  "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
  "GOOGLE_PLAY_RTDN_AUDIENCE",
  "GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL",
  "WEB_PASSWORD",
  "SMTP_URL",
  "PUBLIC_API_URL",
  "DEEPSEEK_API_KEY",
  "DEEPINFRA_API_KEY",
  "GEMINI_API_KEY",
  "ALIBABA_API_KEY",
  "OPENAI_API_KEY"
] as const;

const REQUIRED_FOR_WORKER = [
  "PUBLIC_API_URL",
  "DEEPSEEK_API_KEY",
  "DEEPINFRA_API_KEY",
  "GEMINI_API_KEY",
  "ALIBABA_API_KEY",
  "OPENAI_API_KEY"
] as const;

function config(overrides: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = COMPLETE) {
  const env: NodeJS.ProcessEnv = { ...base, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }
  return loadConfig(env);
}

function without(...names: string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(names.map((name) => [name, undefined]));
}

function reported(issues: readonly ProductionConfigIssue[]): string[] {
  return issues.flatMap((issue) => issue.variables);
}

function silentLog() {
  return { warn: vi.fn(), mockAi: vi.fn() };
}

function assertNoSecret(text: string): void {
  for (const secret of [...Object.values(SECRETS), "SECRETKEYBYTES", "SECRETSMTP", "SECRETPW"]) {
    expect(text).not.toContain(secret);
  }
}

const temporary = mkdtempSync(join(tmpdir(), "production-config-test-"));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

describe("production configuration", () => {
  it("passes a complete production environment for both processes", () => {
    for (const role of ["api", "worker"] as const) {
      const report = productionConfigReport(config(), role);
      expect(report.problems).toEqual([]);
      expect(report.mockAi).toBe(false);
      expect(() => enforceProductionConfig(config(), role, silentLog())).not.toThrow();
    }
  });

  it.each(REQUIRED_FOR_API)("reports a missing %s by name, and only that", (name) => {
    // The service-account pair is one requirement; dropping the JSON leaves no file to fall back to.
    const report = productionConfigReport(config(without(name)), "api");
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.variables).toContain(name);
    expect(report.problems[0]?.message).toContain(name);
  });

  it("reports every missing setting together, in one error naming each", () => {
    const empty = { NODE_ENV: "production", S3_BUCKET: "test-private-bucket" };
    const report = productionConfigReport(config({}, empty), "api");
    expect(new Set(reported(report.problems))).toEqual(
      new Set([...REQUIRED_FOR_API, "GOOGLE_PLAY_SERVICE_ACCOUNT_FILE"])
    );

    let thrown: unknown;
    try {
      enforceProductionConfig(config({}, empty), "api", silentLog());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProductionConfigError);
    const message = (thrown as ProductionConfigError).message;
    expect(message).toMatch(/^The API refuses to start in production: 12 required settings are missing/);
    for (const name of REQUIRED_FOR_API) {
      expect(message).toContain(name);
    }
    expect(message.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(12);
  });

  it("asks the worker only for the public origin and the provider keys", () => {
    const empty = { NODE_ENV: "production", S3_BUCKET: "test-private-bucket" };
    expect(new Set(reported(productionConfigReport(config({}, empty), "worker").problems))).toEqual(
      new Set(REQUIRED_FOR_WORKER)
    );
    const workerOnly = config(
      without("GOOGLE_PLAY_PACKAGE_NAME", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "GOOGLE_PLAY_RTDN_AUDIENCE",
        "GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL", "WEB_PASSWORD", "SMTP_URL")
    );
    expect(productionConfigReport(workerOnly, "worker").problems).toEqual([]);
  });

  it("never prints a value, a parse error or a URL it refused", () => {
    const broken = config({
      WEB_PASSWORD: "SECRETPW",
      // Invalid JSON: V8's parse error quotes the text around the fault.
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: `{"client_email": "x", private_key: "${SECRETS.privateKey}"}`,
      SMTP_URL: "https://mailer:SECRETSMTP@smtp.mail.test",
      PUBLIC_API_URL: "http://tomeza.ravanix.app",
      DEEPSEEK_API_KEY: "   "
    });
    const report = productionConfigReport(broken, "api");
    expect(reported(report.problems)).toEqual(
      expect.arrayContaining(["WEB_PASSWORD", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "SMTP_URL", "PUBLIC_API_URL", "DEEPSEEK_API_KEY"])
    );
    assertNoSecret(new ProductionConfigError("api", report.problems).message);
    assertNoSecret(JSON.stringify(report));
  });

  it("is a no-op outside production, whatever is missing", () => {
    for (const NODE_ENV of ["development", "test", undefined]) {
      const log = silentLog();
      const local = config({ NODE_ENV }, { S3_BUCKET: "test-private-bucket" });
      expect(enforceProductionConfig(local, "api", log)).toBeUndefined();
      expect(enforceProductionConfig(local, "worker", log)).toBeUndefined();
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.mockAi).not.toHaveBeenCalled();
    }
  });

  it("warns about Google sign-in instead of refusing to start", () => {
    const log = silentLog();
    const report = enforceProductionConfig(config(without("GOOGLE_SIGN_IN_CLIENT_ID")), "api", log);
    expect(report?.problems).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ variables: ["GOOGLE_SIGN_IN_CLIENT_ID"] }));
    expect(productionConfigReport(config(without("GOOGLE_SIGN_IN_CLIENT_ID")), "worker").warnings).toEqual([]);
  });

  it("warns, never refuses, when no one would be told about an outage", () => {
    const log = silentLog();
    const report = enforceProductionConfig(config(without("OPERATOR_ALERT_EMAIL")), "api", log);
    expect(report?.problems).toEqual([]);
    expect(report?.warnings.map((warning) => warning.variables)).toEqual([["OPERATOR_ALERT_EMAIL"]]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ variables: ["OPERATOR_ALERT_EMAIL"] }));
    // The API sends the alerts; the worker is never asked.
    expect(productionConfigReport(config(without("OPERATOR_ALERT_EMAIL")), "worker").warnings).toEqual([]);
  });

  it("accepts a list of alert addresses and warns about a malformed one without quoting it", () => {
    expect(productionConfigReport(config({ OPERATOR_ALERT_EMAIL: "owner@ravanix.app, ops@ravanix.app" }), "api").warnings).toEqual([]);
    const report = productionConfigReport(config({ OPERATOR_ALERT_EMAIL: "SECRETPW-not-an-address" }), "api");
    expect(reported(report.warnings)).toEqual(["OPERATOR_ALERT_EMAIL"]);
    expect(report.warnings[0]?.message).toContain("is not an email address");
    assertNoSecret(JSON.stringify(report));
  });

  it("passes a complete environment without a single warning", () => {
    expect(productionConfigReport(config(), "api").warnings).toEqual([]);
  });
});

describe("the smoke test's switch", () => {
  const smoke = { MOCK_AI: "true", ALLOW_MOCK_AI_IN_PRODUCTION: "true" };
  const noProviders = without("DEEPSEEK_API_KEY", "DEEPINFRA_API_KEY", "GEMINI_API_KEY", "ALIBABA_API_KEY", "OPENAI_API_KEY");

  it("waives the provider keys only because MOCK_AI calls no provider, and says so loudly", () => {
    const log = silentLog();
    const report = enforceProductionConfig(config({ ...smoke, ...noProviders }), "worker", log);
    expect(report?.problems).toEqual([]);
    expect(log.mockAi).toHaveBeenCalledWith(MOCK_AI_IN_PRODUCTION_MESSAGE);
  });

  it("waives nothing else: the smoke test sets dummy Play, RTDN, SMTP and password values", () => {
    const report = productionConfigReport(config({ ...smoke, ...noProviders, ...without("SMTP_URL", "GOOGLE_PLAY_PACKAGE_NAME") }), "api");
    expect(reported(report.problems).sort()).toEqual(["GOOGLE_PLAY_PACKAGE_NAME", "SMTP_URL"]);
  });

  it("is still the only way MOCK_AI reaches production", () => {
    expect(() => config({ MOCK_AI: "true" })).toThrow(/MOCK_AI must be off in production/);
  });
});

describe("WEB_PASSWORD", () => {
  it.each([
    [undefined, "is not set"],
    ["", "is not set"],
    ["                    ", "is not set"],
    ["short-password", "is shorter than 16 characters"],
    ["replace-with-a-strong-operator-password", "is still a placeholder"],
    ["CHANGEME-CHANGEME-1234", "is still a placeholder"],
    ["abababababababababab", "uses fewer than 6 different characters"]
  ])("refuses %j", (password, problem) => {
    expect(webPasswordProblem(password)).toBe(problem);
  });

  it("accepts a random one, and the smoke test's", () => {
    expect(webPasswordProblem("5f0c8e2a9b7d41e6a3c1f08b")).toBeUndefined();
    expect(webPasswordProblem("smoke-test-operator-password")).toBeUndefined();
  });

  it("is read after the trim config.ts applies, so a padded blank is unset", () => {
    expect(reported(productionConfigReport(config({ WEB_PASSWORD: "   " }), "api").problems)).toEqual(["WEB_PASSWORD"]);
  });
});

describe("PUBLIC_API_URL", () => {
  it.each(["http://tomeza.ravanix.app", "https://localhost:4001", "https://127.0.0.1", "https://api.localhost"])(
    "refuses %s",
    (url) => {
      expect(reported(productionConfigReport(config({ PUBLIC_API_URL: url }), "worker").problems)).toEqual(["PUBLIC_API_URL"]);
    }
  );

  it("refuses the default an unset variable leaves behind", () => {
    expect(reported(productionConfigReport(config(without("PUBLIC_API_URL")), "worker").problems)).toEqual(["PUBLIC_API_URL"]);
  });
});

describe("the Play service account", () => {
  const key = JSON.stringify({ client_email: "play@tomeza.iam.gserviceaccount.com", private_key: SECRETS.privateKey });

  it("accepts a readable key file", () => {
    const path = join(temporary, "play.json");
    writeFileSync(path, key);
    const report = productionConfigReport(
      config({ ...without("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"), GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: path }),
      "api"
    );
    expect(report.problems).toEqual([]);
  });

  it("treats a blank JSON line as unset, so it does not shadow the file", () => {
    const path = join(temporary, "play-blank.json");
    writeFileSync(path, key);
    const loaded = config({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: "", GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: path });
    expect(loaded.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON).toBeUndefined();
    expect(productionConfigReport(loaded, "api").problems).toEqual([]);
  });

  it("refuses a file that is missing or is not a key", () => {
    const notKey = join(temporary, "not-a-key.json");
    writeFileSync(notKey, JSON.stringify({ type: "service_account" }));
    for (const path of [join(temporary, "missing.json"), notKey]) {
      const report = productionConfigReport(
        config({ ...without("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"), GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: path }),
        "api"
      );
      expect(reported(report.problems)).toEqual(["GOOGLE_PLAY_SERVICE_ACCOUNT_FILE"]);
      expect(report.problems[0]?.message).not.toContain(path);
    }
  });

  it("refuses JSON without the two fields the verifier signs with", () => {
    const report = productionConfigReport(
      config({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "play@tomeza.iam.gserviceaccount.com" }) }),
      "api"
    );
    expect(reported(report.problems)).toEqual(["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"]);
  });
});

describe("SMTP_URL", () => {
  it.each(["smtp://smtp.mail.test:587", "smtps://user:pass@smtp.mail.test:465"])("accepts %s", (url) => {
    expect(productionConfigReport(config({ SMTP_URL: url }), "api").problems).toEqual([]);
  });

  it.each(["mail.test", "https://smtp.mail.test"])("refuses %s", (url) => {
    expect(reported(productionConfigReport(config({ SMTP_URL: url }), "api").problems)).toEqual(["SMTP_URL"]);
  });
});

describe("provider keys", () => {
  it("drops OpenAI when the narration fallback that needs it is turned off", () => {
    const report = productionConfigReport(
      config({ ...without("OPENAI_API_KEY"), AUDIOBOOK_OPENAI_FALLBACK_ENABLED: "false" }),
      "worker"
    );
    expect(report.problems).toEqual([]);
    const required = productionConfigReport(config(without("OPENAI_API_KEY")), "worker").problems;
    expect(required[0]?.message).toContain("AUDIOBOOK_OPENAI_FALLBACK_ENABLED=false");
  });

  it("requires OpenAI for voice calls routed to OpenAI Realtime, with no switch to offer", () => {
    const report = productionConfigReport(
      config({ ...without("OPENAI_API_KEY"), AUDIOBOOK_OPENAI_FALLBACK_ENABLED: "false", VOICE_CHAT_PROVIDER: "openai_realtime" }),
      "worker"
    );
    expect(reported(report.problems)).toEqual(["OPENAI_API_KEY"]);
    expect(report.problems[0]?.message).not.toContain("Or set");
  });
});
