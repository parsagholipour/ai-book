import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@book-maker/db";
import { z } from "zod";

const updateSafetySettingsSchema = z
  .object({
    copyrightRestrictionsEnabled: z.boolean(),
    note: z.string().trim().max(500).optional()
  })
  .strict();

type SafetySettingsRecord = {
  version: number;
  copyrightRestrictionsEnabled: boolean;
  note: string | null;
  updatedBy: string | null;
  createdAt: Date;
};

export const adminSafetyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/admin/safety-settings", async () => {
    const current = (await prisma.safetySettingsRevision.findFirst({
      orderBy: { version: "desc" }
    })) as SafetySettingsRecord | null;
    return serializeSafetySettings(current);
  });

  fastify.patch("/api/admin/safety-settings", async (request, reply) => {
    const parsed = updateSafetySettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Send a valid copyright restriction setting." });
    }

    const record = await prisma.$transaction(async (tx) => {
      const current = await tx.safetySettingsRevision.findFirst({
        orderBy: { version: "desc" },
        select: { version: true, copyrightRestrictionsEnabled: true }
      });
      return tx.safetySettingsRevision.create({
        data: {
          version: (current?.version ?? 0) + 1,
          copyrightRestrictionsEnabled: parsed.data.copyrightRestrictionsEnabled,
          note: parsed.data.note?.trim() || null,
          updatedBy: "operator-console"
        }
      });
    });

    request.log.info(
      {
        event: "safety_settings.updated",
        version: record.version,
        copyrightRestrictionsEnabled: record.copyrightRestrictionsEnabled
      },
      "Safety settings updated"
    );
    return serializeSafetySettings(record as SafetySettingsRecord);
  });
};

function serializeSafetySettings(record: SafetySettingsRecord | null) {
  return {
    version: record?.version ?? 0,
    copyrightRestrictionsEnabled: record?.copyrightRestrictionsEnabled ?? false,
    note: record?.note ?? null,
    updatedBy: record?.updatedBy ?? null,
    updatedAt: record?.createdAt.toISOString() ?? null
  };
}
