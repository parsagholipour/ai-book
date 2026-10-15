import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@book-maker/db";
import { z } from "zod";
import { requireOperatorActor } from "../requestAuth.js";
import { forgetSexualContentFilterSetting } from "../contentSafety.js";

/**
 * Either switch may be sent alone: a save writes a whole revision, and the
 * switch a save does not name keeps the value the current revision holds (or
 * its default — copyright off, the sexual-content filter ON).
 */
const updateSafetySettingsSchema = z
  .object({
    copyrightRestrictionsEnabled: z.boolean().optional(),
    sexualContentFilterEnabled: z.boolean().optional(),
    note: z.string().trim().max(500).optional()
  })
  .strict()
  .refine(
    (body) => body.copyrightRestrictionsEnabled !== undefined || body.sexualContentFilterEnabled !== undefined,
    "Send at least one setting."
  );

type SafetySettingsRecord = {
  version: number;
  copyrightRestrictionsEnabled: boolean;
  /** Absent on a row read before the column existed, which means ON. */
  sexualContentFilterEnabled?: boolean | null;
  note: string | null;
  updatedBy: string | null;
  createdAt: Date;
};

export const adminSafetyRoutes: FastifyPluginAsync = async (fastify) => {
  // The auth hook is not trusted to have run: a handler with no guard of its
  // own was reachable by any spelling of the URL that slipped past it.
  fastify.get("/api/admin/safety-settings", async (request, reply) => {
    if (!(await requireOperatorActor(request, reply))) {
      return;
    }
    const current = (await prisma.safetySettingsRevision.findFirst({
      orderBy: { version: "desc" }
    })) as SafetySettingsRecord | null;
    return serializeSafetySettings(current);
  });

  fastify.patch("/api/admin/safety-settings", async (request, reply) => {
    if (!(await requireOperatorActor(request, reply))) {
      return;
    }
    const parsed = updateSafetySettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Send a valid safety setting." });
    }

    const record = await prisma.$transaction(async (tx) => {
      const current = await tx.safetySettingsRevision.findFirst({
        orderBy: { version: "desc" },
        select: { version: true, copyrightRestrictionsEnabled: true, sexualContentFilterEnabled: true }
      });
      return tx.safetySettingsRevision.create({
        data: {
          version: (current?.version ?? 0) + 1,
          copyrightRestrictionsEnabled:
            parsed.data.copyrightRestrictionsEnabled ?? current?.copyrightRestrictionsEnabled === true,
          sexualContentFilterEnabled:
            parsed.data.sexualContentFilterEnabled ?? current?.sexualContentFilterEnabled !== false,
          note: parsed.data.note?.trim() || null,
          updatedBy: "operator-console"
        }
      });
    });
    // This process reads the switch again at once; the worker and any other
    // API process follow within a minute (`contentSafety.ts`).
    forgetSexualContentFilterSetting();

    request.log.info(
      {
        event: "safety_settings.updated",
        version: record.version,
        copyrightRestrictionsEnabled: record.copyrightRestrictionsEnabled,
        sexualContentFilterEnabled: record.sexualContentFilterEnabled
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
    // No revision, or one that predates the column, is ON.
    sexualContentFilterEnabled: record?.sexualContentFilterEnabled !== false,
    note: record?.note ?? null,
    updatedBy: record?.updatedBy ?? null,
    updatedAt: record?.createdAt.toISOString() ?? null
  };
}
