import { readFileSync } from "node:fs";
import type { AppConfig } from "./config.js";
import { missingProviderCredentials } from "./adapters/providerRequirements.js";

/**
 * What a production API or worker refuses to start without.
 *
 * Every one of these used to be optional, and every one failed somewhere a
 * deploy could not see: a Play purchase answered 503 and Google refunded it
 * three days later, a refund notice answered 503 and the credits stayed, an
 * unset `WEB_PASSWORD` let every request into the operator console, and a
 * missing provider key failed a reader's book at generation time. The checks
 * run in-process at boot — so the Dockerfile/Railway path is covered as well as
 * Compose — and in `apps/api/src/checkProductionConfig.ts`, which the deploy
 * runs in the new image before it stops the release that is serving.
 *
 * Every missing item is reported at once, each naming its setting and what
 * breaks without it. Values are never printed, and neither is a parse error,
 * because a JSON or URL error message quotes its input.
 */

export type ProductionProcess = "api" | "worker";

export type ProductionConfigIssue = {
  /** The settings this line is about. Names only. */
  variables: readonly string[];
  message: string;
};

export type ProductionConfigReport = {
  /** Missing or unusable: the process refuses to start. */
  problems: ProductionConfigIssue[];
  /** A feature that is off: logged at boot, never fatal. */
  warnings: ProductionConfigIssue[];
  /** `ALLOW_MOCK_AI_IN_PRODUCTION` let `MOCK_AI` through: the smoke test, or a mistake. */
  mockAi: boolean;
};

export const WEB_PASSWORD_MIN_LENGTH = 16;
const WEB_PASSWORD_MIN_DISTINCT_CHARACTERS = 6;
/** Spellings of "fill this in", including the example file's own value. */
const PLACEHOLDER_FRAGMENTS = [
  "replace-with",
  "replace_with",
  "replaceme",
  "replace-me",
  "changeme",
  "change-me",
  "change_me",
  "placeholder",
  "example",
  "your-password",
  "yourpassword"
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]);

export const MOCK_AI_IN_PRODUCTION_MESSAGE =
  "MOCK_AI is ON in production because ALLOW_MOCK_AI_IN_PRODUCTION is set. That is the production " +
  "smoke test's switch (scripts/check-production-docker.sh): every generation answers with canned " +
  "text and no provider key is checked. On a real deployment, remove both from PRODUCTION_ENV.";

/** Why `WEB_PASSWORD` cannot guard the operator console, or nothing when it can. Never quotes it. */
export function webPasswordProblem(password: string | undefined): string | undefined {
  const value = password?.trim();
  if (!value) {
    return "is not set";
  }
  if (value.length < WEB_PASSWORD_MIN_LENGTH) {
    return `is shorter than ${WEB_PASSWORD_MIN_LENGTH} characters`;
  }
  const lower = value.toLowerCase();
  if (PLACEHOLDER_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
    return "is still a placeholder";
  }
  if (new Set(value).size < WEB_PASSWORD_MIN_DISTINCT_CHARACTERS) {
    return `uses fewer than ${WEB_PASSWORD_MIN_DISTINCT_CHARACTERS} different characters`;
  }
  return undefined;
}

function publicApiUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "https:") {
    return "is not an https:// origin";
  }
  const host = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) {
    return "names this machine rather than the public host";
  }
  return undefined;
}

/**
 * The URL's shape only: whether the server answers and takes the credentials is
 * asked of the server after the API listens, and every ten minutes after
 * (apps/api/src/monitoring/mailHealth.ts). That answer is `/api/ready`'s `mail`
 * check, never a refused start: a mail provider's outage must not fail a deploy.
 */
function smtpUrlProblem(value: string | undefined): string | undefined {
  if (!value) {
    return "is not set";
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "smtp:" || protocol === "smtps:" ? undefined : "is not an smtp:// or smtps:// URL";
  } catch {
    return "is not an smtp:// or smtps:// URL";
  }
}

/** One address or a comma-separated list, each shaped like one. Never quotes the value. */
function operatorAlertEmailProblem(value: string | undefined): string | undefined {
  if (!value) {
    return "is not set";
  }
  const addresses = value.split(",").map((address) => address.trim());
  return addresses.every((address) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(address))
    ? undefined
    : "is not an email address (or a comma-separated list of them)";
}

/** The runtime's own test (`parseServiceAccountCredentials`): JSON with a client_email and a private_key. */
function isServiceAccountKey(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const { client_email: email, private_key: key } = parsed as Record<string, unknown>;
    return typeof email === "string" && email.trim() !== "" && typeof key === "string" && key.trim() !== "";
  } catch {
    return false;
  }
}

function playServiceAccountProblem(config: AppConfig): ProductionConfigIssue | undefined {
  const consequence =
    "Every Play purchase answers 503 and is never acknowledged, so Google refunds it after three " +
    "days, and no subscription renewal is ever granted.";
  // The JSON wins when both are set, exactly as `googlePlayBilling.ts` reads them.
  if (config.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    return isServiceAccountKey(config.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON)
      ? undefined
      : {
          variables: ["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"],
          message:
            "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not a service-account key (the key file's JSON, with " +
            `client_email and private_key, single-quoted on one line). ${consequence}`
        };
  }
  if (config.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE) {
    let raw: string;
    try {
      raw = readFileSync(config.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE, "utf8");
    } catch {
      return {
        variables: ["GOOGLE_PLAY_SERVICE_ACCOUNT_FILE"],
        message: `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE names a file this process cannot read. ${consequence}`
      };
    }
    return isServiceAccountKey(raw)
      ? undefined
      : {
          variables: ["GOOGLE_PLAY_SERVICE_ACCOUNT_FILE"],
          message: `GOOGLE_PLAY_SERVICE_ACCOUNT_FILE names a file that is not a service-account key. ${consequence}`
        };
  }
  return {
    variables: ["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "GOOGLE_PLAY_SERVICE_ACCOUNT_FILE"],
    message:
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (or GOOGLE_PLAY_SERVICE_ACCOUNT_FILE) is not set. " +
      `${consequence} GOOGLE_PLAY_ACCESS_TOKEN is not a substitute: it expires within the hour.`
  };
}

function apiIntegrationProblems(config: AppConfig): ProductionConfigIssue[] {
  const problems: ProductionConfigIssue[] = [];
  // MOCK_GOOGLE_PLAY_BILLING is forced off outside development and test
  // (config.ts), so production has no way to skip the real verifier.
  if (!config.GOOGLE_PLAY_PACKAGE_NAME) {
    problems.push({
      variables: ["GOOGLE_PLAY_PACKAGE_NAME"],
      message:
        "GOOGLE_PLAY_PACKAGE_NAME is not set. Every Play purchase answers 503 and is never " +
        "acknowledged, so Google refunds it after three days; refund notices are refused too."
    });
  }
  const serviceAccount = playServiceAccountProblem(config);
  if (serviceAccount) {
    problems.push(serviceAccount);
  }
  const rtdnConsequence =
    "The refund notice endpoint answers 503, so a purchase refunded in Play keeps its credits and a " +
    "voided subscription keeps its plan (docs/google-play-rtdn.md).";
  if (!config.GOOGLE_PLAY_RTDN_AUDIENCE) {
    problems.push({
      variables: ["GOOGLE_PLAY_RTDN_AUDIENCE"],
      message: `GOOGLE_PLAY_RTDN_AUDIENCE is not set. ${rtdnConsequence}`
    });
  }
  if (!config.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL) {
    problems.push({
      variables: ["GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL"],
      message: `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL is not set. ${rtdnConsequence}`
    });
  }
  const smtp = smtpUrlProblem(config.SMTP_URL);
  if (smtp) {
    problems.push({
      variables: ["SMTP_URL"],
      message:
        `SMTP_URL ${smtp}. Forgot-password answers 503 EMAIL_UNAVAILABLE, so a reader who forgets ` +
        "their password is locked out of their books and credits."
    });
  }
  return problems;
}

function sharedProblems(config: AppConfig): ProductionConfigIssue[] {
  const problems: ProductionConfigIssue[] = [];
  const publicUrl = publicApiUrlProblem(config.PUBLIC_API_URL);
  if (publicUrl) {
    problems.push({
      variables: ["PUBLIC_API_URL"],
      message:
        `PUBLIC_API_URL ${publicUrl} (unset, it is http://localhost:4001). Every picture, cover and ` +
        "share link is stored with this origin and outlives the deploy, and CORS admits only it."
    });
  }
  for (const requirement of missingProviderCredentials(config)) {
    const names = requirement.variables.join(" and ");
    problems.push({
      variables: requirement.variables,
      message:
        `${names} ${requirement.variables.length > 1 ? "are" : "is"} not set, and the default model ` +
        `routing uses ${requirement.label} for ${requirement.uses.join(", ")}: each of those calls ` +
        "fails when it is made, and the book, audiobook or call that made it fails with it." +
        (requirement.optOut ? ` Or set ${requirement.optOut}.` : "")
    });
  }
  return problems;
}

/**
 * The production rules for one process, whatever `NODE_ENV` says — the deploy
 * preflight asks before the containers that would set it exist.
 * The worker needs the public origin (it writes stored asset URLs) and the
 * provider keys; the API needs those and everything a reader's account touches.
 */
export function productionConfigReport(config: AppConfig, role: ProductionProcess): ProductionConfigReport {
  const problems: ProductionConfigIssue[] = [];
  const warnings: ProductionConfigIssue[] = [];
  if (config.DEBUG_MODE) {
    warnings.push({
      variables: ["DEBUG_MODE"],
      message:
        "DEBUG_MODE is ON: new accounts are disabled. Missing Google Play, refund notification " +
        "and SMTP settings only warn; those services remain unavailable until configured."
    });
  }
  if (role === "api") {
    (config.DEBUG_MODE ? warnings : problems).push(...apiIntegrationProblems(config));
    const password = webPasswordProblem(config.WEB_PASSWORD);
    if (password) {
      problems.push({
        variables: ["WEB_PASSWORD"],
        message:
          `WEB_PASSWORD ${password}. Unset, every request to the operator console, /api/admin and ` +
          "/docs is let in as the operator; weak, the password and the session cookie it signs are " +
          `guessable. Use ${WEB_PASSWORD_MIN_LENGTH}+ random characters, e.g. openssl rand -hex 24.`
      });
    }
  }
  problems.push(...sharedProblems(config));
  if (role === "api" && !config.GOOGLE_SIGN_IN_CLIENT_ID) {
    warnings.push({
      variables: ["GOOGLE_SIGN_IN_CLIENT_ID"],
      message:
        "GOOGLE_SIGN_IN_CLIENT_ID is not set: Google sign-in answers 503 GOOGLE_SIGN_IN_UNAVAILABLE " +
        "(email sign-in still works). An app build compiled with a client ID shows a Google button that cannot sign anyone in."
    });
  }
  // A warning, not a refusal: the site works without it, and a deploy must not
  // fail over who gets told when it stops working. The API sends the alerts, so
  // only the API asks.
  const alertEmail = role === "api" ? operatorAlertEmailProblem(config.OPERATOR_ALERT_EMAIL) : undefined;
  if (alertEmail) {
    warnings.push({
      variables: ["OPERATOR_ALERT_EMAIL"],
      message:
        `OPERATOR_ALERT_EMAIL ${alertEmail}: the API's alerts (worker down, stuck queue, failed jobs, low ` +
        "disk, AI spend caps) are only written to its log, which nobody watches. Set it to the owner's address."
    });
  }
  return { problems, warnings, mockAi: config.MOCK_AI };
}

export class ProductionConfigError extends Error {
  constructor(
    readonly role: ProductionProcess,
    readonly problems: readonly ProductionConfigIssue[]
  ) {
    super(formatProductionConfigProblems(role, problems));
    this.name = "ProductionConfigError";
  }
}

export function formatProductionConfigProblems(
  role: ProductionProcess | "release",
  problems: readonly ProductionConfigIssue[]
): string {
  const subject = role === "api" ? "The API" : role === "worker" ? "The worker" : "This release";
  const count = problems.length === 1 ? "1 required setting is" : `${problems.length} required settings are`;
  return [
    `${subject} refuses to start in production: ${count} missing or unusable.`,
    ...problems.map((problem) => `  - ${problem.message}`),
    "Set them in PRODUCTION_ENV (deploy/production.env.example lists every one) and deploy again. " +
      "Values are never printed."
  ].join("\n");
}

export type ProductionConfigLog = {
  warn(issue: ProductionConfigIssue): void;
  /** `ALLOW_MOCK_AI_IN_PRODUCTION` is on. Log it as an error: it is a test switch. */
  mockAi(message: string): void;
};

/** Logs the warnings and throws `ProductionConfigError` on any problem. A no-op outside production. */
export function enforceProductionConfig(
  config: AppConfig,
  role: ProductionProcess,
  log: ProductionConfigLog
): ProductionConfigReport | undefined {
  if (config.NODE_ENV !== "production") {
    return undefined;
  }
  const report = productionConfigReport(config, role);
  if (report.mockAi) {
    log.mockAi(MOCK_AI_IN_PRODUCTION_MESSAGE);
  }
  for (const warning of report.warnings) {
    log.warn(warning);
  }
  if (report.problems.length > 0) {
    throw new ProductionConfigError(role, report.problems);
  }
  return report;
}
