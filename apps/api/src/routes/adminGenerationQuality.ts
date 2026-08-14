import type { FastifyPluginAsync } from "fastify";
import {
  QUALITY_FEATURE_DEFAULTS,
  QUALITY_FEATURE_IDS,
  QUALITY_FEATURES,
  parseQualityFeatureSettings,
  type QualityFeatureSettings
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { z } from "zod";

const effortTierSchema = z.enum(["ultra", "premium", "balanced", "fast"]);
const featureTiersSchema = z.array(effortTierSchema);

const qualitySettingsBodySchema = z
  .object({
    storyExtractAudit: featureTiersSchema,
    planCritic: featureTiersSchema,
    claimVerifier: featureTiersSchema,
    styleExcerpts: featureTiersSchema,
    styleAuditor: featureTiersSchema,
    pageMapCritic: featureTiersSchema,
    writerTools: featureTiersSchema,
    bestOfPolish: featureTiersSchema,
    planThinkingBoost: featureTiersSchema,
    claimRetrieve: featureTiersSchema
  })
  .strict();

const patchGenerationQualitySchema = qualitySettingsBodySchema
  .extend({
    note: z.string().trim().max(500).optional()
  })
  .strict();

const resetGenerationQualitySchema = z
  .object({
    note: z.string().trim().max(500).optional()
  })
  .strict();

type GenerationQualityRecord = {
  version: number;
  settings: unknown;
  note: string | null;
  updatedBy: string | null;
  createdAt: Date;
};

export const adminGenerationQualityRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/admin/generation-quality", async () => {
    const current = (await prisma.generationQualityRevision.findFirst({
      orderBy: { version: "desc" }
    })) as GenerationQualityRecord | null;
    return serializeGenerationQuality(current);
  });

  fastify.patch("/api/admin/generation-quality", async (request, reply) => {
    const parsed = patchGenerationQualitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Send a complete generation-quality feature map." });
    }
    const { note, ...rawSettings } = parsed.data;
    const settings = parseQualityFeatureSettings(rawSettings);
    const record = await appendGenerationQualityRevision(settings, note);
    request.log.info(
      { event: "generation_quality.updated", version: record.version },
      "Generation quality settings updated"
    );
    return serializeGenerationQuality(record);
  });

  fastify.post("/api/admin/generation-quality/reset", async (request, reply) => {
    const parsed = resetGenerationQualitySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Send an optional note." });
    }
    const settings = cloneDefaults();
    const record = await appendGenerationQualityRevision(
      settings,
      parsed.data.note?.trim() || "Reset to compiled defaults"
    );
    request.log.info(
      { event: "generation_quality.reset", version: record.version },
      "Generation quality settings reset to compiled defaults"
    );
    return serializeGenerationQuality(record);
  });
};

async function appendGenerationQualityRevision(
  settings: QualityFeatureSettings,
  note: string | undefined
): Promise<GenerationQualityRecord> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.generationQualityRevision.findFirst({
      orderBy: { version: "desc" },
      select: { version: true }
    });
    return tx.generationQualityRevision.create({
      data: {
        version: (current?.version ?? 0) + 1,
        settings,
        note: note?.trim() || null,
        updatedBy: "operator-console"
      }
    });
  }) as Promise<GenerationQualityRecord>;
}

function cloneDefaults(): QualityFeatureSettings {
  const settings = {} as QualityFeatureSettings;
  for (const id of QUALITY_FEATURE_IDS) {
    settings[id] = [...QUALITY_FEATURE_DEFAULTS[id]];
  }
  return settings;
}

function serializeGenerationQuality(record: GenerationQualityRecord | null) {
  return {
    version: record?.version ?? 0,
    settings: parseQualityFeatureSettings(record?.settings),
    usingCompiledDefaults: record == null,
    features: QUALITY_FEATURES,
    note: record?.note ?? null,
    updatedBy: record?.updatedBy ?? null,
    updatedAt: record?.createdAt.toISOString() ?? null
  };
}
