/**
 * Read-only analytics and inspection for the operator dashboard.
 *
 * Everything here is under `/api/admin/`, which `isOperatorOnlyPath` in
 * `../auth.ts` already restricts to the console's session cookie. Nothing in
 * this file mutates: it is the reporting half of the dashboard, and the
 * mutating halves (pricing, moderation) live in `adminPricing.ts` and
 * `mobileSafety.ts`.
 */

import { type FastifyPluginAsync, type FastifyReply } from "fastify";
import { z } from "zod";
import { markOperatorRequest } from "../requestAuth.js";
import { loadAdminProjectDetail, loadAdminUserDetail, listAdminUsers } from "../admin/inspection.js";
import { loadAdminOverview, resolveWindow } from "../admin/metrics.js";

const windowQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const userListQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  sort: z.enum(["recent", "spend", "cash", "credits", "projects"]).default("recent"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const idParamsSchema = z.object({ id: z.string().min(1) });

const windowQueryOpenApi = {
  type: "object",
  properties: { days: { type: "integer", minimum: 1, maximum: 365, default: 30 } }
} as const;

const userListQueryOpenApi = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: 200 },
    sort: { type: "string", enum: ["recent", "spend", "cash", "credits", "projects"], default: "recent" },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    offset: { type: "integer", minimum: 0, default: 0 }
  }
} as const;

export const adminAnalyticsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/api/admin/overview",
    { attachValidation: true, schema: { tags: ["admin"], querystring: windowQueryOpenApi } },
    async (request, reply) => {
      await markOperatorRequest(request);
      const parsed = windowQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendInvalid(reply, parsed.error);
      }
      return loadAdminOverview(resolveWindow(parsed.data.days));
    }
  );

  fastify.get(
    "/api/admin/users",
    { attachValidation: true, schema: { tags: ["admin"], querystring: userListQueryOpenApi } },
    async (request, reply) => {
      await markOperatorRequest(request);
      const parsed = userListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendInvalid(reply, parsed.error);
      }
      return listAdminUsers({
        ...(parsed.data.query ? { query: parsed.data.query } : {}),
        sort: parsed.data.sort,
        limit: parsed.data.limit,
        offset: parsed.data.offset
      });
    }
  );

  fastify.get("/api/admin/users/:id", { schema: { tags: ["admin"] } }, async (request, reply) => {
    await markOperatorRequest(request);
    const { id } = idParamsSchema.parse(request.params);
    const detail = await loadAdminUserDetail(id);
    if (!detail) {
      return reply.code(404).send({ error: "User not found" });
    }
    return detail;
  });

  fastify.get("/api/admin/projects/:id", { schema: { tags: ["admin"] } }, async (request, reply) => {
    await markOperatorRequest(request);
    const { id } = idParamsSchema.parse(request.params);
    const detail = await loadAdminProjectDetail(id);
    if (!detail) {
      return reply.code(404).send({ error: "Project not found" });
    }
    return detail;
  });
};

function sendInvalid(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return reply.code(400).send({
    error: where ? `${where}: ${issue?.message ?? "Invalid value"}` : (issue?.message ?? "Invalid request.")
  });
}
