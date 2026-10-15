import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  ACCOUNT_MODERATION_ACTIONS,
  ACCOUNT_MODERATION_REASON_MAX,
  ACCOUNT_MODERATION_REFUSALS,
  AccountModerationRefusedError,
  moderateAccount,
  type AccountModerationActionName
} from "../accountModeration.js";
import { requireOperatorActor } from "../requestAuth.js";

/**
 * `POST /api/admin/users/:id/moderation` — suspend or unsuspend an account, or
 * turn its sharing off or on, with the reason the operator gives
 * (`../accountModeration.ts`). Operator-only twice over: `/api/admin/` is
 * cookie-only at the auth hook, and the handler asks `requireOperatorActor`.
 */

const paramsSchema = z.object({ id: z.string().min(1).max(64) });
const bodySchema = z
  .object({
    action: z.enum(ACCOUNT_MODERATION_ACTIONS as [AccountModerationActionName, ...AccountModerationActionName[]]),
    reason: z.string().trim().max(ACCOUNT_MODERATION_REASON_MAX).optional()
  })
  .strict();

const errorBody = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" } },
      required: ["code", "message"]
    }
  },
  required: ["error"]
} as const;

const bodyOpenApi = {
  type: "object",
  additionalProperties: false,
  required: ["action", "reason"],
  properties: {
    action: { type: "string", enum: [...ACCOUNT_MODERATION_ACTIONS] },
    reason: { type: "string", maxLength: ACCOUNT_MODERATION_REASON_MAX, description: "Why: kept with the action for the next operator." }
  }
} as const;

export const adminAccountRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/api/admin/users/:id/moderation",
    {
      attachValidation: true,
      schema: { tags: ["admin"], body: bodyOpenApi, response: { 400: errorBody, 404: errorBody, 409: errorBody } }
    },
    async (request, reply) => {
      const operator = await requireOperatorActor(request, reply);
      if (!operator) {
        return;
      }
      const { id } = paramsSchema.parse(request.params);
      const parsed = bodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Send a valid account action." } });
      }
      const reason = parsed.data.reason ?? "";
      if (!reason) {
        return reply.code(400).send({ error: { code: "REASON_REQUIRED", message: "Say why: the reason is kept with the action." } });
      }
      try {
        const outcome = await moderateAccount({
          userId: id,
          action: parsed.data.action,
          reason,
          operatorUserId: operator.userId,
          log: request.log
        });
        return {
          actionId: outcome.actionId,
          status: outcome.status,
          sharingDisabledAt: outcome.sharingDisabledAt?.toISOString() ?? null,
          effects: outcome.effects
        };
      } catch (error) {
        if (error instanceof AccountModerationRefusedError) {
          const { status, message } = ACCOUNT_MODERATION_REFUSALS[error.code];
          return reply.code(status).send({ error: { code: error.code, message } });
        }
        throw error;
      }
    }
  );
};
