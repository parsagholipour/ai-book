import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { prisma } from "@book-maker/db";
import { z } from "zod";
import { routedRequestPath } from "./requestAuth.js";

/**
 * Operator-controlled app updates.
 *
 * Every store release the operator records says what it asks of the builds
 * older than it: `silent` (nothing — Play's own auto-update is left to it),
 * `prompt` (a dismissible "update available") or `required` (the app is
 * unusable until updated). A build's answer is decided by the releases newer
 * than it: the strongest policy among them wins, so one `required` release
 * keeps every build below it gated however many quieter releases follow.
 *
 * The app sends its build on every request, so the decision is enforced here as
 * well as offered: `GET /api/mobile/app-update` is what the app asks at launch
 * and on resume, and the gate below answers 426 to any other mobile request from
 * a required-to-update build — an app left open across the change, or one whose
 * launch check failed, still lands on the update screen.
 */

export const APP_UPDATE_PATH = "/api/mobile/app-update";
const APP_BUILD_HEADER = "x-app-build";
const APP_PLATFORM_HEADER = "x-app-platform";

export const APP_UPDATE_PLATFORMS = ["android", "ios"] as const;
export const APP_UPDATE_POLICIES = ["silent", "prompt", "required"] as const;

export type AppUpdatePlatform = (typeof APP_UPDATE_PLATFORMS)[number];
export type AppUpdatePolicy = (typeof APP_UPDATE_POLICIES)[number];
export type AppUpdateAction = "none" | "prompt" | "required";

export const appUpdateReleaseSchema = z
  .object({
    platform: z.enum(APP_UPDATE_PLATFORMS),
    /** The store build number — Android `versionCode`, the `+N` in pubspec. */
    build: z.number().int().min(1).max(2_100_000_000),
    /** The human version, e.g. "1.2.0". Shown to the reader, never compared. */
    version: z.string().trim().min(1).max(40),
    policy: z.enum(APP_UPDATE_POLICIES),
    message: z.string().trim().min(1).max(400).optional()
  })
  .strict();

export type AppUpdateRelease = z.infer<typeof appUpdateReleaseSchema>;

export const appUpdateReleasesSchema = z
  .array(appUpdateReleaseSchema)
  .max(500)
  .superRefine((releases, context) => {
    const seen = new Set<string>();
    releases.forEach((release, index) => {
      const key = `${release.platform}:${release.build}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index, "build"],
          message: `${release.platform} build ${release.build} is listed twice.`
        });
      }
      seen.add(key);
    });
  });

export type AppClient = { platform: AppUpdatePlatform; build: number };

export type AppUpdateDecision = {
  action: AppUpdateAction;
  /** The newest recorded build for the client's platform; null when nothing is asked. */
  latestBuild: number | null;
  latestVersion: string | null;
  /** The operator's note on the release that decided the action, if it has one. */
  message: string | null;
};

const NO_UPDATE: AppUpdateDecision = { action: "none", latestBuild: null, latestVersion: null, message: null };

export function decideAppUpdate(releases: readonly AppUpdateRelease[], client: AppClient | null): AppUpdateDecision {
  if (!client) return NO_UPDATE;
  const newer = releases
    .filter((release) => release.platform === client.platform && release.build > client.build)
    .sort((left, right) => right.build - left.build);
  const latest = newer[0];
  if (!latest) return NO_UPDATE;
  const decidedBy =
    newer.find((release) => release.policy === "required") ?? newer.find((release) => release.policy === "prompt");
  if (!decidedBy) return NO_UPDATE;
  return {
    action: decidedBy.policy === "required" ? "required" : "prompt",
    latestBuild: latest.build,
    latestVersion: latest.version,
    message: decidedBy.message ?? null
  };
}

/**
 * The calling build, or null when the request does not name one. Only the app
 * sends these headers; the console, curl and the suites do not, and a request
 * that names no build is never gated.
 */
export function readAppClient(request: Pick<FastifyRequest, "headers">): AppClient | null {
  const build = singleHeader(request.headers[APP_BUILD_HEADER]);
  const platform = singleHeader(request.headers[APP_PLATFORM_HEADER])?.toLowerCase();
  if (!build || !/^\d{1,10}$/.test(build) || !platform) return null;
  if (!(APP_UPDATE_PLATFORMS as readonly string[]).includes(platform)) return null;
  return { platform: platform as AppUpdatePlatform, build: Number(build) };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

/**
 * The gate reads the policy on every mobile request, so the head revision is
 * held for a short while. A save from the console drops it at once in this
 * process; anything else sees the change within the TTL.
 */
const POLICY_TTL_MS = 30_000;
let cachedPolicy: { releases: AppUpdateRelease[]; loadedAt: number } | null = null;

export function forgetAppUpdatePolicy(): void {
  cachedPolicy = null;
}

/**
 * Fails open: a policy the database cannot hand back, or one that no longer
 * parses, gates nobody. The last good list is kept through a failed read, and
 * the failure is cached for the TTL so a sick database is not asked again on
 * every request.
 */
export async function currentAppUpdateReleases(now = Date.now()): Promise<AppUpdateRelease[]> {
  if (cachedPolicy && now - cachedPolicy.loadedAt < POLICY_TTL_MS) {
    return cachedPolicy.releases;
  }
  let releases = cachedPolicy?.releases ?? [];
  try {
    const head = await prisma.appUpdatePolicyRevision.findFirst({
      orderBy: { version: "desc" },
      select: { releases: true }
    });
    const parsed = appUpdateReleasesSchema.safeParse(head?.releases ?? []);
    releases = parsed.success ? parsed.data : [];
  } catch {
    // Keep the last good list; see the doc comment.
  }
  cachedPolicy = { releases, loadedAt: now };
  return releases;
}

export function registerAppUpdateGate(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    // The matched route, as the auth hook reads it: `/%61pi/mobile/...` runs a
    // mobile handler and is gated like one.
    const path = routedRequestPath(request);
    if (path === null || !path.startsWith("/api/mobile/") || path === APP_UPDATE_PATH) return;
    const client = readAppClient(request);
    if (!client) return;
    const update = decideAppUpdate(await currentAppUpdateReleases(), client);
    if (update.action !== "required") return;
    return reply.code(426).send({
      error: {
        code: "APP_UPDATE_REQUIRED",
        message: "This version of Tomeza is no longer supported. Update the app to keep going.",
        update
      }
    });
  });
}

export const appUpdateRoutes: FastifyPluginAsync = async (fastify) => {
  // Public (see `shouldProtectPath`): a signed-out build has to be told too.
  fastify.get(APP_UPDATE_PATH, async (request) => ({
    update: decideAppUpdate(await currentAppUpdateReleases(), readAppClient(request))
  }));
};
