import type { FastifyPluginAsync } from "fastify";
import { publicReadiness, type ReadinessProbe } from "./readiness.js";

/**
 * `GET /api/ready` — what an external uptime monitor polls (docs/deployment.md,
 * "Monitoring and alerts"). Public by design: it is exempt from the auth hook
 * beside `/api/health` (`shouldProtectPath` in `auth.ts`, which reads the route
 * the router matched, so an encoded spelling lands here and nowhere else), and
 * nginx proxies it with the rest of `/api`. 200 when every check passes, 503
 * otherwise, with nothing in the body but each check's ok/fail.
 *
 * In its own plugin rather than beside `/api/health` in `routes/projects.ts`,
 * whose every other route is the operator's.
 */
export const readinessRoutes: FastifyPluginAsync<{ probe: ReadinessProbe }> = async (fastify, options) => {
  fastify.get("/api/ready", async (_request, reply) => {
    const report = await options.probe.check();
    return reply
      .code(report.ok ? 200 : 503)
      .header("Cache-Control", "no-store")
      .send(publicReadiness(report));
  });
};
