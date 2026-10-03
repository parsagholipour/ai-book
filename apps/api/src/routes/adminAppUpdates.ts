import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@book-maker/db";
import { z } from "zod";
import { appUpdateReleasesSchema, forgetAppUpdatePolicy, type AppUpdateRelease } from "../appUpdates.js";
import { requireOperatorActor } from "../requestAuth.js";

/**
 * The operator's list of app-store releases and the policy each one sets for
 * older builds. A save replaces the whole list, so it names the version it was
 * edited from: two console tabs saving over each other would otherwise drop
 * whichever release the slower one never saw.
 */
const updateAppUpdatesSchema = z
  .object({
    baseVersion: z.number().int().min(0),
    releases: appUpdateReleasesSchema,
    note: z.string().trim().max(500).optional()
  })
  .strict();

type AppUpdatePolicyRecord = {
  version: number;
  releases: unknown;
  note: string | null;
  updatedBy: string | null;
  createdAt: Date;
};

export const adminAppUpdateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/admin/app-updates", { onRequest: requireAppUpdatesOperator }, async () => {
    const head = (await prisma.appUpdatePolicyRevision.findFirst({
      orderBy: { version: "desc" }
    })) as AppUpdatePolicyRecord | null;
    return serializeAppUpdates(head);
  });

  fastify.put("/api/admin/app-updates", { onRequest: requireAppUpdatesOperator }, async (request, reply) => {
    const parsed = updateAppUpdatesSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({ error: issue?.message ?? "Send a valid release list." });
    }

    const result = await prisma.$transaction(async (tx) => {
      const head = await tx.appUpdatePolicyRevision.findFirst({
        orderBy: { version: "desc" },
        select: { version: true }
      });
      const headVersion = head?.version ?? 0;
      if (headVersion !== parsed.data.baseVersion) {
        return { conflict: headVersion } as const;
      }
      const record = await tx.appUpdatePolicyRevision.create({
        data: {
          version: headVersion + 1,
          releases: sortReleases(parsed.data.releases),
          note: parsed.data.note?.trim() || null,
          updatedBy: "operator-console"
        }
      });
      return { record: record as AppUpdatePolicyRecord } as const;
    });

    if ("conflict" in result) {
      return reply.code(409).send({
        error: `The release list changed (now version ${result.conflict}) since this page loaded. Reload and make the change again.`
      });
    }

    forgetAppUpdatePolicy();
    request.log.info(
      {
        event: "app_updates.updated",
        version: result.record.version,
        releases: parsed.data.releases.map((release) => `${release.platform}:${release.build}:${release.policy}`)
      },
      "App update policy updated"
    );
    return serializeAppUpdates(result.record);
  });
};

/**
 * One save can lock every installed build out of the app, so the route asserts
 * the operator itself rather than trusting the path alone — with password auth
 * off, a mobile bearer reaches the handler as a bearer (see `src/auth.ts`).
 */
async function requireAppUpdatesOperator(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireOperatorActor(request, reply);
  if (!actor) {
    return reply;
  }
}

function serializeAppUpdates(record: AppUpdatePolicyRecord | null) {
  const parsed = appUpdateReleasesSchema.safeParse(record?.releases ?? []);
  return {
    version: record?.version ?? 0,
    releases: parsed.success ? sortReleases(parsed.data) : [],
    note: record?.note ?? null,
    updatedBy: record?.updatedBy ?? null,
    updatedAt: record?.createdAt.toISOString() ?? null
  };
}

function sortReleases(releases: AppUpdateRelease[]): AppUpdateRelease[] {
  return [...releases].sort(
    (left, right) => left.platform.localeCompare(right.platform) || right.build - left.build
  );
}
