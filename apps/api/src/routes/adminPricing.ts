/**
 * The operator console's pricing dashboard API.
 *
 * Lives under `/api/admin/`, which `isOperatorOnlyPath` in `../auth.ts` already
 * restricts to the console's session cookie — a mobile bearer token is rejected
 * before it reaches a handler here, so no route in this file needs to think
 * about mobile users.
 *
 * The preview route exists so the dashboard can show what a change would cost
 * *before* committing it, priced through the same `estimateFullBookCreditCost`
 * production uses. Re-implementing the arithmetic in the browser would be the
 * obvious alternative and would drift the first time the formula changed.
 */

import {
  CREDIT_PRICING_KEYS,
  CREDIT_PRICING_LIMITS,
  CREDIT_USD_VALUE,
  DEFAULT_CREDIT_COSTS,
  type CreditPricing,
  createProjectSchema,
  creditPricingInputSchema,
  estimateFullBookCreditCost
} from "@book-maker/core";
import {
  CreditPricingConflictError,
  getCreditPricingState,
  listCreditPricingRevisions,
  revertCreditPricing,
  saveCreditPricing,
  type CreditPricingState
} from "@book-maker/db";
import { type FastifyPluginAsync, type FastifyReply } from "fastify";
import { z } from "zod";
import { markOperatorRequest } from "../requestAuth.js";
import { resolveWindow } from "../admin/metrics.js";
import { loadPricingDrivers } from "../admin/pricingDrivers.js";

const REVISION_HISTORY_LIMIT = 20;

/**
 * The book the dashboard quotes. Deliberately fixed rather than supplied by the
 * browser: the console has no reason to build a `CreateProjectInput`, and
 * accepting one would put the generation schema on an operator-facing surface
 * for no gain.
 */
const PREVIEW_INPUT = createProjectSchema.parse({
  prompt: "Create a practical workbook about onboarding new managers.",
  category: "EDUCATION",
  subcategory: "Workbook or Study Guide",
  targetPages: 28,
  complexity: 5,
  temperature: 0.65,
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "minimal",
    finalReview: true,
    toneProfile: "neutral"
  }
});

const saveBodySchema = z
  .object({
    values: creditPricingInputSchema,
    note: z.string().trim().max(500).optional(),
    expectedVersion: z.number().int().min(0).optional()
  })
  .strict();

const revertBodySchema = z
  .object({
    version: z.number().int().min(1),
    note: z.string().trim().max(500).optional()
  })
  .strict();

const previewBodySchema = z.object({ values: creditPricingInputSchema }).strict();

const driverQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(90) });

const driverQueryOpenApi = {
  type: "object",
  properties: { days: { type: "integer", minimum: 1, maximum: 365, default: 90 } }
} as const;

/**
 * OpenAPI twin of {@link creditPricingInputSchema}; bounds come from the same table.
 *
 * Note this twin is not purely documentation. Fastify's AJV defaults mean
 * `additionalProperties: false` *strips* unknown keys and `type: "integer"`
 * coerces a numeric string before the handler runs — so an unfamiliar key is
 * dropped rather than refused, and a form field's `"90"` arrives as `90`. Zod
 * remains the gate that matters: the bounds, the integer-ness, and the
 * requirement to send a complete list are all enforced there.
 */
const pricingValuesOpenApi = {
  type: "object",
  additionalProperties: false,
  required: CREDIT_PRICING_KEYS,
  properties: Object.fromEntries(
    CREDIT_PRICING_KEYS.map((key) => [key, { type: "integer", minimum: 0, maximum: CREDIT_PRICING_LIMITS[key] }])
  )
} as const;

const saveBodyOpenApi = {
  type: "object",
  additionalProperties: false,
  required: ["values"],
  properties: {
    values: pricingValuesOpenApi,
    note: { type: "string", maxLength: 500 },
    expectedVersion: { type: "integer", minimum: 0 }
  }
} as const;

const revertBodyOpenApi = {
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: {
    version: { type: "integer", minimum: 1 },
    note: { type: "string", maxLength: 500 }
  }
} as const;

const previewBodyOpenApi = {
  type: "object",
  additionalProperties: false,
  required: ["values"],
  properties: { values: pricingValuesOpenApi }
} as const;

export const adminPricingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/admin/pricing", { schema: { tags: ["admin"] } }, async (request) => {
    await markOperatorRequest(request);
    const [state, revisions] = await Promise.all([
      getCreditPricingState(),
      listCreditPricingRevisions(REVISION_HISTORY_LIMIT)
    ]);
    return {
      ...serializeState(state),
      defaults: { ...DEFAULT_CREDIT_COSTS },
      limits: { ...CREDIT_PRICING_LIMITS },
      creditUsdValue: CREDIT_USD_VALUE,
      preview: previewFor(state.values),
      revisions: revisions.map((revision) => ({
        version: revision.version,
        changed: revision.changed,
        note: revision.note,
        updatedBy: revision.updatedBy,
        createdAt: revision.createdAt.toISOString()
      }))
    };
  });

  fastify.put(
    "/api/admin/pricing",
    { attachValidation: true, schema: { tags: ["admin"], body: saveBodyOpenApi } },
    async (request, reply) => {
      const operator = await markOperatorRequest(request);
      const parsed = saveBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error);
      }
      return withConflictHandling(reply, async () => {
        const result = await saveCreditPricing({
          values: parsed.data.values,
          updatedBy: operator.userId,
          ...(parsed.data.note ? { note: parsed.data.note } : {}),
          ...(typeof parsed.data.expectedVersion === "number" ? { expectedVersion: parsed.data.expectedVersion } : {})
        });
        request.log.info(
          { event: "pricing.updated", version: result.version, changed: result.changed, applied: result.applied },
          "Credit pricing updated"
        );
        return { ...serializeState(result), applied: result.applied, changed: result.changed };
      });
    }
  );

  fastify.post(
    "/api/admin/pricing/revert",
    { attachValidation: true, schema: { tags: ["admin"], body: revertBodyOpenApi } },
    async (request, reply) => {
      const operator = await markOperatorRequest(request);
      const parsed = revertBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error);
      }
      return withConflictHandling(reply, async () => {
        try {
          const result = await revertCreditPricing({
            version: parsed.data.version,
            updatedBy: operator.userId,
            ...(parsed.data.note ? { note: parsed.data.note } : {})
          });
          request.log.info(
            { event: "pricing.reverted", version: result.version, revertedTo: parsed.data.version },
            "Credit pricing reverted"
          );
          return { ...serializeState(result), applied: result.applied, changed: result.changed };
        } catch (error) {
          if (error instanceof Error && /No pricing revision/.test(error.message)) {
            return reply.code(404).send({ error: error.message });
          }
          throw error;
        }
      });
    }
  );

  fastify.get(
    "/api/admin/pricing/drivers",
    { attachValidation: true, schema: { tags: ["admin"], querystring: driverQueryOpenApi } },
    async (request, reply) => {
      await markOperatorRequest(request);
      const parsed = driverQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error);
      }
      const state = await getCreditPricingState();
      return loadPricingDrivers(resolveWindow(parsed.data.days), state.values);
    }
  );

  fastify.post(
    "/api/admin/pricing/preview",
    { attachValidation: true, schema: { tags: ["admin"], body: previewBodyOpenApi } },
    async (request, reply) => {
      await markOperatorRequest(request);
      const parsed = previewBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error);
      }
      // Priced explicitly against the proposed values — nothing is persisted and
      // the live prices other requests are being charged do not move.
      return previewFor(parsed.data.values);
    }
  );
};

function serializeState(state: CreditPricingState) {
  return {
    values: state.values,
    version: state.version,
    note: state.note,
    updatedBy: state.updatedBy,
    updatedAt: state.updatedAt?.toISOString() ?? null
  };
}

function previewFor(values: CreditPricing) {
  const estimate = estimateFullBookCreditCost(PREVIEW_INPUT, values);
  return {
    label: `${PREVIEW_INPUT.targetPages}-page illustrated workbook`,
    targetPages: PREVIEW_INPUT.targetPages,
    totalCredits: estimate.totalCredits,
    estimatedUsd: Math.round(estimate.totalCredits * CREDIT_USD_VALUE * 100) / 100,
    lineItems: estimate.lineItems
  };
}

async function withConflictHandling<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CreditPricingConflictError) {
      return reply.code(409).send({ error: error.message, currentVersion: error.currentVersion });
    }
    throw error;
  }
}

function sendValidationError(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return reply.code(400).send({
    error: where ? `${where}: ${issue?.message ?? "Invalid value"}` : (issue?.message ?? "Invalid pricing values.")
  });
}
