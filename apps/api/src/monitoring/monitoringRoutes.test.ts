import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAuth } from "../auth.js";
import type { Mailer, MailMessage } from "../mailer.js";
import { createMailHealth } from "./mailHealth.js";
import { monitoringRoutes, type MonitoringRouteOptions } from "./monitoringRoutes.js";

const mockPrisma = vi.hoisted(() => ({
  user: { upsert: vi.fn(async () => ({ id: "local-admin" })) },
  mobileSession: { findUnique: vi.fn() },
  legalAcceptance: { findFirst: vi.fn() }
}));

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));

const log = () => ({ info: vi.fn(), error: vi.fn() });
const SENT_AT = new Date("2026-10-13T12:34:00.000Z");

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function operatorApp(options: Partial<MonitoringRouteOptions> & { mailer: Mailer | null }) {
  const instance = Fastify();
  // Stands in for `registerAuth` having checked the console cookie.
  instance.addHook("onRequest", async (request) => {
    request.operatorAuth = { userId: "local-admin" };
  });
  await instance.register(monitoringRoutes, {
    mailHealth: createMailHealth({ mailer: options.mailer, log: log() }),
    recipient: "owner@example.com",
    publicUrl: "https://api.tomeza.example/",
    now: () => SENT_AT,
    ...options
  });
  app = instance;
  return instance;
}

describe("POST /api/admin/monitoring/test-alert", () => {
  it("asks for the console cookie, and sends nothing without it", async () => {
    const send = vi.fn(async () => undefined);
    const instance = Fastify();
    await registerAuth(instance, { WEB_PASSWORD: "operator-password-1234" } as never);
    await instance.register(monitoringRoutes, {
      mailer: { send },
      mailHealth: createMailHealth({ mailer: { send }, log: log() }),
      recipient: "owner@example.com",
      publicUrl: "https://api.tomeza.example"
    });
    app = instance;

    for (const url of ["/api/admin/monitoring/test-alert", "/%61pi/admin/monitoring/test-alert"]) {
      const response = await instance.inject({ method: "POST", url });
      expect(response.statusCode, url).toBe(401);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a request the auth hook did not mark as the operator's", async () => {
    const send = vi.fn(async () => undefined);
    const instance = Fastify();
    await instance.register(monitoringRoutes, {
      mailer: { send },
      mailHealth: createMailHealth({ mailer: { send }, log: log() }),
      recipient: "owner@example.com",
      publicUrl: "https://api.tomeza.example"
    });
    app = instance;
    const response = await instance.inject({ method: "POST", url: "/api/admin/monitoring/test-alert" });
    expect(response.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends one test email to the alert address through the alert transport", async () => {
    const sent: MailMessage[] = [];
    const instance = await operatorApp({ mailer: { send: async (message) => void sent.push(message) } });
    const response = await instance.inject({ method: "POST", url: "/api/admin/monitoring/test-alert" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, sentTo: "owner@example.com", sentAt: SENT_AT.toISOString() });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "owner@example.com", subject: "[Tomeza] Test alert" });
    expect(sent[0]?.text).toContain("https://api.tomeza.example/api/ready");
    expect(sent[0]?.text).toContain("2026-10-13 12:34 UTC");
  });

  it("answers 502 with the reason when the server refuses, and readiness then fails mail", async () => {
    const mailer: Mailer = {
      send: async () => {
        throw new Error("Invalid login: 535 5.7.8 Authentication failed");
      }
    };
    const mailHealth = createMailHealth({ mailer, log: log() });
    const instance = await operatorApp({ mailer, mailHealth });
    const response = await instance.inject({ method: "POST", url: "/api/admin/monitoring/test-alert" });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ ok: false, error: "Error: Invalid login: 535 5.7.8 Authentication failed" });
    await expect(mailHealth.readinessCheck()).rejects.toThrow("Authentication failed");
  });

  it("says why nothing was sent when there is no address or no transport", async () => {
    const noAddress = await operatorApp({ mailer: { send: vi.fn() }, recipient: undefined });
    const unaddressed = await noAddress.inject({ method: "POST", url: "/api/admin/monitoring/test-alert" });
    expect(unaddressed.statusCode).toBe(409);
    expect(unaddressed.json().error).toContain("OPERATOR_ALERT_EMAIL");
    await noAddress.close();

    const noTransport = await operatorApp({ mailer: null });
    const untransported = await noTransport.inject({ method: "POST", url: "/api/admin/monitoring/test-alert" });
    expect(untransported.statusCode).toBe(503);
    expect(untransported.json().error).toContain("SMTP_URL");
  });
});
