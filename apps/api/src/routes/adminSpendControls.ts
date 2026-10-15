import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { prisma } from "@book-maker/db";
import type { z } from "zod";
import { topSpendersSince } from "../admin/spendToday.js";
import { requireOperatorActor } from "../requestAuth.js";
import { planHoldersBetween, totalUsd } from "../spendBreakdown.js";
import { spendBreaker } from "../spendBreaker.js";
import {
  AI_SPEND_CONTROL_DEFAULTS,
  aiSpendControlsInputOpenApi,
  aiSpendControlsInputSchema,
  type AiSpendControls
} from "../spendControls.js";

/**
 * The operator's AI spend breaker: the pause switch and the caps, with today's
 * spend split by plan (free, paid, unattributed), the month's free spend against
 * its ceiling, the state each puts free and paying readers in, and who is
 * spending it.
 *
 * A save is a new append-only `AiSpendControlRevision`, and it drops this
 * process's cached state so the next door asks against it at once; another API
 * process sees it within a minute (`spendBreaker.ts`).
 */

const TOP_SPENDERS = 10;

export const adminSpendControlRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/admin/spend-controls", { schema: { tags: ["admin"] } }, async (request, reply) => {
    if (!(await requireOperatorActor(request, reply))) {
      return;
    }
    return spendControlsResponse(request.log);
  });

  fastify.put(
    "/api/admin/spend-controls",
    { attachValidation: true, schema: { tags: ["admin"], body: aiSpendControlsInputOpenApi } },
    async (request, reply) => {
      if (!(await requireOperatorActor(request, reply))) {
        return;
      }
      const parsed = aiSpendControlsInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error);
      }
      const { note, ...controls } = parsed.data;
      const record = await prisma.$transaction(async (tx) => {
        const head = await tx.aiSpendControlRevision.findFirst({
          orderBy: { version: "desc" },
          select: { version: true }
        });
        return tx.aiSpendControlRevision.create({
          data: {
            version: (head?.version ?? 0) + 1,
            ...controls,
            note: note?.trim() || null,
            updatedBy: "operator-console"
          }
        });
      });
      spendBreaker.forget();
      request.log.warn(
        { event: "ai_spend.controls_updated", version: record.version, ...controls },
        controls.paused ? "AI spend controls updated: AI work is paused" : "AI spend controls updated"
      );
      return spendControlsResponse(request.log);
    }
  );
};

async function spendControlsResponse(log: Parameters<typeof spendBreaker.globalView>[0]) {
  // Fresh, not the minute-old cache: the operator is looking at it to decide.
  // The read goes through the breaker so this process starts acting on it too.
  spendBreaker.forget();
  const view = await spendBreaker.globalView(log);
  const spenders = await topSpendersSince(prisma, view.dayStart, TOP_SPENDERS);
  // Classified as the caps classify them: a plan held at any moment today.
  const paid = await planHoldersBetween(
    prisma,
    spenders.map((spender) => spender.userId),
    view.dayStart,
    view.resetsAt
  );
  return {
    controls: serializeControls(view.controls),
    defaults: AI_SPEND_CONTROL_DEFAULTS,
    today: {
      day: view.dayStart.toISOString().slice(0, 10),
      resetsAt: view.resetsAt.toISOString(),
      state: view.state,
      paidState: view.paidState,
      freeUsd: view.today.freeUsd,
      paidUsd: view.today.paidUsd,
      unattributedUsd: view.today.unattributedUsd,
      /** Free plus unattributed: what the soft and hard caps compare. */
      freeSpendUsd: view.freeSpendUsd,
      totalUsd: totalUsd(view.today)
    },
    month: {
      month: view.monthStart.toISOString().slice(0, 7),
      resetsAt: view.monthResetsAt.toISOString(),
      freeSpendUsd: view.monthFreeSpendUsd
    },
    topSpenders: spenders.map((spender) => ({ ...spender, paidPlan: paid.has(spender.userId) }))
  };
}

function serializeControls(controls: AiSpendControls) {
  return {
    version: controls.version,
    paused: controls.paused,
    softDailyCapUsd: controls.softDailyCapUsd,
    hardDailyCapUsd: controls.hardDailyCapUsd,
    freeMonthlyCapUsd: controls.freeMonthlyCapUsd,
    paidHardDailyCapUsd: controls.paidHardDailyCapUsd,
    freeUserDailyCapUsd: controls.freeUserDailyCapUsd,
    paidUserDailyCapUsd: controls.paidUserDailyCapUsd,
    note: controls.note,
    updatedBy: controls.updatedBy,
    updatedAt: controls.updatedAt?.toISOString() ?? null
  };
}

function sendValidationError(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return reply.code(400).send({
    error: where ? `${where}: ${issue?.message ?? "Invalid value"}` : (issue?.message ?? "Send valid spend controls.")
  });
}
