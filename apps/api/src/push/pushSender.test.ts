import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@book-maker/core";
import { bookProgressMessage, bookSettledMessage } from "./bookPushMessages.js";
import { createFcmPushSender, createPushSenderFromConfig } from "./pushSender.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CREDENTIALS = {
  client_email: "push@tomeza-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  project_id: "tomeza-test"
};
const ANDROID = { token: "android-token", platform: "ANDROID" as const };
const PROGRESS = bookProgressMessage({ projectId: "project-1", title: "Fox", percent: 30, detail: "Writing", sentAt: 1 });

function log() {
  return { info: vi.fn(), warn: vi.fn() };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fcmError(status: number, errorCode: string, message = "") {
  return json(status, {
    error: {
      code: status,
      message,
      status: "X",
      details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }]
    }
  });
}

/** Answers the token exchange, then each FCM send in turn. */
function fakeFetch(...sends: Response[]) {
  const queue = [...sends];
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return json(200, { access_token: "access-1", expires_in: 3600 });
    }
    return queue.shift() ?? json(200, { name: "projects/tomeza-test/messages/1" });
  });
}

describe("FCM push sender", () => {
  it("signs in once with the messaging scope and posts to the key's project", async () => {
    const fetchImpl = fakeFetch();
    const sender = createFcmPushSender({ credentials: CREDENTIALS, projectId: "tomeza-test", log: log(), fetchImpl });

    expect(await sender.send(ANDROID, PROGRESS)).toBe("sent");
    expect(await sender.send(ANDROID, PROGRESS)).toBe("sent");

    const tokenCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes("oauth2"));
    expect(tokenCalls).toHaveLength(1);
    const assertion = new URLSearchParams(String(tokenCalls[0]![1]!.body)).get("assertion")!;
    const claim = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString("utf8"));
    expect(claim).toMatchObject({
      iss: CREDENTIALS.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging"
    });

    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(String(url)).toBe("https://fcm.googleapis.com/v1/projects/tomeza-test/messages:send");
    expect(init!.headers).toMatchObject({ Authorization: "Bearer access-1" });
    expect(JSON.parse(String(init!.body)).message.data.kind).toBe("book_progress");
  });

  it("reports a token FCM will never deliver to again, and nothing else, as unregistered", async () => {
    const sender = createFcmPushSender({
      credentials: CREDENTIALS,
      projectId: "tomeza-test",
      log: log(),
      fetchImpl: fakeFetch(
        fcmError(404, "UNREGISTERED"),
        fcmError(403, "SENDER_ID_MISMATCH"),
        fcmError(400, "INVALID_ARGUMENT", "The registration token is not a valid FCM registration token"),
        fcmError(400, "INVALID_ARGUMENT", "Invalid value at 'message.data'"),
        fcmError(429, "QUOTA_EXCEEDED"),
        fcmError(503, "UNAVAILABLE")
      )
    });

    const outcomes = [];
    for (let index = 0; index < 6; index += 1) {
      outcomes.push(await sender.send(ANDROID, PROGRESS));
    }
    expect(outcomes).toEqual(["unregistered", "unregistered", "unregistered", "failed", "failed", "failed"]);
  });

  it("asks for a fresh access token after a 401", async () => {
    const fetchImpl = fakeFetch(json(401, { error: { status: "UNAUTHENTICATED" } }));
    const sender = createFcmPushSender({ credentials: CREDENTIALS, projectId: "tomeza-test", log: log(), fetchImpl });

    expect(await sender.send(ANDROID, PROGRESS)).toBe("failed");
    expect(await sender.send(ANDROID, PROGRESS)).toBe("sent");
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("oauth2"))).toHaveLength(2);
  });

  it("skips what a platform is not sent, without calling FCM", async () => {
    const fetchImpl = fakeFetch();
    const sender = createFcmPushSender({ credentials: CREDENTIALS, projectId: "tomeza-test", log: log(), fetchImpl });

    expect(await sender.send({ token: "ios-token", platform: "IOS" }, PROGRESS)).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns a network failure into a failed push rather than a thrown sweep", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const sender = createFcmPushSender({ credentials: CREDENTIALS, projectId: "tomeza-test", log: log(), fetchImpl });
    const ready = bookSettledMessage({ kind: "book_ready", projectId: "p", title: "Fox", sentAt: 1 });

    expect(await sender.send(ANDROID, ready)).toBe("failed");
  });
});

describe("push sender from config", () => {
  function config(values: Partial<AppConfig>): AppConfig {
    return { MOCK_PUSH: false, ...values } as AppConfig;
  }

  it("logs instead of sending under MOCK_PUSH", async () => {
    const logger = log();
    const sender = await createPushSenderFromConfig(config({ MOCK_PUSH: true }), logger);

    expect(await sender!.send(ANDROID, PROGRESS)).toBe("sent");
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "push.mock_sent", percent: 30 }), "Push (mock)");
  });

  it("is off, with a warning, when no usable key is configured", async () => {
    for (const values of [
      {},
      { FCM_SERVICE_ACCOUNT_JSON: "not json" },
      { FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...CREDENTIALS, project_id: undefined }) },
      { FCM_SERVICE_ACCOUNT_FILE: "/nonexistent/fcm.json" }
    ]) {
      const logger = log();
      expect(await createPushSenderFromConfig(config(values), logger)).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "push.unconfigured" }), expect.any(String));
    }
  });

  it("takes the project from FCM_PROJECT_ID over the key's own", async () => {
    const sender = await createPushSenderFromConfig(
      config({
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...CREDENTIALS, project_id: undefined }),
        FCM_PROJECT_ID: "tomeza-prod"
      }),
      log()
    );
    expect(sender).not.toBeNull();
  });
});
