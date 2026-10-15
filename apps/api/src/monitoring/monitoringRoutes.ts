import { hostname } from "node:os";
import type { FastifyPluginAsync } from "fastify";
import type { Mailer, MailMessage } from "../mailer.js";
import { requireOperatorActor } from "../requestAuth.js";
import { type MailHealth, withinMs } from "./mailHealth.js";
import { failureReason } from "./readiness.js";

/**
 * `POST /api/admin/monitoring/test-alert` — sends one test email to
 * `OPERATOR_ALERT_EMAIL` through the transport the alerts use, so the owner
 * can see after a deploy that an alert would reach them. Operator-only: under
 * `/api/admin/` the auth hook asks for the console cookie, and the handler
 * asks again through `requireOperatorActor`. The outcome is recorded in the
 * mail health the readiness `mail` check reads, since a real send proves or
 * disproves the same thing a verification does.
 */

/** As long as the alert sweep gives a send (`operatorAlerts.ts`). */
const TEST_ALERT_TIMEOUT_MS = 30_000;

export type MonitoringRouteOptions = {
  mailer: Mailer | null;
  mailHealth: MailHealth;
  recipient: string | undefined;
  publicUrl: string;
  now?: () => Date;
};

export const monitoringRoutes: FastifyPluginAsync<MonitoringRouteOptions> = async (fastify, options) => {
  fastify.post("/api/admin/monitoring/test-alert", { schema: { tags: ["admin"] } }, async (request, reply) => {
    if (!(await requireOperatorActor(request, reply))) {
      return;
    }
    if (!options.recipient) {
      return reply.code(409).send({ ok: false, error: "OPERATOR_ALERT_EMAIL is not set, so alerts are only written to the API log." });
    }
    if (!options.mailer) {
      return reply.code(503).send({ ok: false, error: "No mail transport is configured (SMTP_URL)." });
    }
    const sentAt = (options.now ?? (() => new Date()))();
    try {
      await withinMs(options.mailer.send(composeTestAlertEmail(options.recipient, options.publicUrl, sentAt)), TEST_ALERT_TIMEOUT_MS, "The mail server");
    } catch (error) {
      options.mailHealth.record({ ok: false, error });
      const reason = failureReason(error);
      request.log.error({ event: "operator_alert.test_failed", reason }, "Test alert email could not be sent");
      return reply.code(502).send({ ok: false, error: reason });
    }
    options.mailHealth.record({ ok: true });
    request.log.info({ event: "operator_alert.test_sent" }, "Test alert email sent");
    return { ok: true, sentTo: options.recipient, sentAt: sentAt.toISOString() };
  });
};

export function composeTestAlertEmail(to: string, publicUrl: string, sentAt: Date): MailMessage {
  return {
    to,
    subject: "[Tomeza] Test alert",
    text: [
      `A test of the operator alerts, sent by the API on ${hostname()} at ${sentAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      "",
      "If you are reading this, alert emails reach you. Nothing is wrong.",
      `Readiness right now: ${publicUrl.replace(/\/$/, "")}/api/ready`,
      'What each alert means: docs/deployment.md, "Monitoring and alerts".'
    ].join("\n")
  };
}
