import { readFile } from "node:fs/promises";
import type { AppConfig } from "@book-maker/core";
import type { FastifyBaseLogger } from "fastify";
import {
  DEFAULT_GOOGLE_TOKEN_URI,
  parseServiceAccountCredentials,
  signServiceAccountJwt,
  type ServiceAccountCredentials
} from "../googleServiceAccount.js";
import { fcmRequestBody, type BookPushMessage, type PushTarget } from "./bookPushMessages.js";

/**
 * - `sent`: FCM accepted it (delivery is FCM's business from here).
 * - `skipped`: this platform is not sent this kind of message.
 * - `unregistered`: the token is dead for good; the caller deletes the device.
 * - `failed`: anything else. Logged here; a push is never retried.
 */
export type PushSendResult = "sent" | "skipped" | "unregistered" | "failed";

export interface PushSender {
  send(target: PushTarget, message: BookPushMessage): Promise<PushSendResult>;
}

type FetchLike = typeof fetch;
type PushLog = Pick<FastifyBaseLogger, "info" | "warn">;

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_TIMEOUT_MS = 10_000;

/**
 * The sender `server.ts` runs the push sweep with, or null when pushes are
 * off: no FCM key in a non-mock environment, or a key that cannot be read.
 * Neither stops the API from starting — a phone not being told is not a
 * reason to refuse every other request.
 */
export async function createPushSenderFromConfig(config: AppConfig, log: PushLog): Promise<PushSender | null> {
  if (config.MOCK_PUSH) {
    return createMockPushSender(log);
  }
  let raw: string | undefined;
  try {
    raw = config.FCM_SERVICE_ACCOUNT_JSON?.trim() || (config.FCM_SERVICE_ACCOUNT_FILE ? await readFile(config.FCM_SERVICE_ACCOUNT_FILE, "utf8") : undefined);
  } catch (error) {
    log.warn({ err: error, event: "push.unconfigured" }, "FCM_SERVICE_ACCOUNT_FILE could not be read; no pushes will be sent");
    return null;
  }
  if (!raw) {
    log.warn({ event: "push.unconfigured" }, "No FCM service account configured; no pushes will be sent");
    return null;
  }
  let credentials: ServiceAccountCredentials | null = null;
  try {
    credentials = parseServiceAccountCredentials(raw);
  } catch {
    credentials = null;
  }
  const projectId = config.FCM_PROJECT_ID?.trim() || credentials?.project_id;
  if (!credentials || !projectId) {
    log.warn(
      { event: "push.unconfigured" },
      "The FCM service account needs client_email, private_key and a project id; no pushes will be sent"
    );
    return null;
  }
  return createFcmPushSender({ credentials, projectId, log });
}

/** Dev and tests: the push is a log line, and every token is alive. */
export function createMockPushSender(log: PushLog): PushSender {
  return {
    async send(target, message) {
      if (!fcmRequestBody(target, message)) {
        return "skipped";
      }
      log.info(
        {
          event: "push.mock_sent",
          kind: message.kind,
          projectId: message.projectId,
          percent: message.percent,
          platform: target.platform,
          body: message.body
        },
        "Push (mock)"
      );
      return "sent";
    }
  };
}

export function createFcmPushSender(options: {
  credentials: ServiceAccountCredentials;
  projectId: string;
  log: PushLog;
  fetchImpl?: FetchLike;
}): PushSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(options.projectId)}/messages:send`;
  let cache: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string | null> {
    const now = Date.now();
    if (cache && cache.expiresAt - 60_000 > now) {
      return cache.token;
    }
    const tokenUri = options.credentials.token_uri ?? DEFAULT_GOOGLE_TOKEN_URI;
    const response = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signServiceAccountJwt(options.credentials, FCM_SCOPE, tokenUri)
      }),
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS)
    });
    if (!response.ok) {
      options.log.warn({ event: "push.token_failed", status: response.status }, "FCM access token request failed");
      return null;
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      options.log.warn({ event: "push.token_failed" }, "FCM access token response had no access token");
      return null;
    }
    cache = { token: body.access_token, expiresAt: now + Math.max(60, body.expires_in ?? 3600) * 1000 };
    return cache.token;
  }

  return {
    async send(target, message) {
      const body = fcmRequestBody(target, message);
      if (!body) {
        return "skipped";
      }
      try {
        const token = await accessToken();
        if (!token) {
          return "failed";
        }
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(FCM_TIMEOUT_MS)
        });
        if (response.ok) {
          return "sent";
        }
        const error = await readFcmError(response);
        if (isDeadToken(error)) {
          return "unregistered";
        }
        if (response.status === 401) {
          // A revoked or rotated key; the next send asks for a fresh token.
          cache = null;
        }
        options.log.warn(
          { event: "push.send_failed", status: response.status, fcmError: error.errorCode ?? error.status, kind: message.kind },
          "FCM refused a push"
        );
        return "failed";
      } catch (error) {
        options.log.warn({ err: error, event: "push.send_failed", kind: message.kind }, "FCM push request failed");
        return "failed";
      }
    }
  };
}

type FcmError = { status?: string; message?: string; errorCode?: string };

async function readFcmError(response: Response): Promise<FcmError> {
  try {
    const body = (await response.json()) as {
      error?: { status?: string; message?: string; details?: Array<{ "@type"?: string; errorCode?: string }> };
    };
    const fcmDetail = body.error?.details?.find((detail) => detail["@type"]?.endsWith("FcmError"));
    return {
      ...(body.error?.status ? { status: body.error.status } : {}),
      ...(body.error?.message ? { message: body.error.message } : {}),
      ...(fcmDetail?.errorCode ? { errorCode: fcmDetail.errorCode } : {})
    };
  } catch {
    return {};
  }
}

/**
 * A token that will never work again: the app was uninstalled or its token
 * rotated (UNREGISTERED), it belongs to another Firebase project
 * (SENDER_ID_MISMATCH), or it was never a token. INVALID_ARGUMENT alone is
 * not enough — a malformed *message* answers the same code, and deleting
 * every device over a bug in this file would be the wrong lesson.
 */
function isDeadToken(error: FcmError): boolean {
  if (error.errorCode === "UNREGISTERED" || error.errorCode === "SENDER_ID_MISMATCH") {
    return true;
  }
  return error.errorCode === "INVALID_ARGUMENT" && /registration token/i.test(error.message ?? "");
}
