import type { GenerationTextModelRouting } from "@book-maker/core";
import type { FastifyReply } from "fastify";
import { sendContentRestricted } from "../contentRestrictions.js";
import { screenRequestForSexualContent } from "../contentSafetyScreen.js";
import { liveRoutingLoader } from "../generationTextModelRouting.js";
import { recordInlineDecisionAttempt } from "../inlineDecisionUsage.js";
import type { UserTextModerationDeps } from "../userTextModeration.js";
import type { MobileRouteContext } from "./routeContext.js";

/**
 * The doors where a reader's request becomes a book, screened by the
 * sexual-content filter (`../contentSafetyScreen.ts`): the creation build, the
 * first plan, a direct plan revision, plan approval and every book-chat
 * message. Each asks after its auth, validation, replay and breaker checks and
 * before anything is reserved, claimed or written, and a refusal is the same
 * 422 `CONTENT_RESTRICTED` body the deterministic screens send
 * (`sendContentRestricted`), so every installed app already shows its sentence.
 */

type DoorLog = {
  warn(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
};

// Built on first use: nothing reads the Quality tab until a request is screened.
const routingLoaders = new WeakMap<MobileRouteContext, () => Promise<GenerationTextModelRouting>>();

function routingLoader(context: MobileRouteContext): () => Promise<GenerationTextModelRouting> {
  let loader = routingLoaders.get(context);
  if (!loader) {
    loader = liveRoutingLoader(context.appConfig);
    routingLoaders.set(context, loader);
  }
  return loader;
}

/**
 * The share note's moderation dependencies for any screen run on a reader's
 * behalf: the live Quality-tab route, one cost row per attempt under the reader,
 * and the suites' scripted seam (`options.userTextModeration`).
 */
export function moderationDepsFor(
  context: MobileRouteContext,
  owner: { projectId: string | null; userId: string }
): UserTextModerationDeps {
  const override = context.options.userTextModeration;
  return {
    config: context.appConfig,
    loadRouting: () => routingLoader(context)(),
    recordAttempt: (attempt) => recordInlineDecisionAttempt(attempt, owner),
    ...override
  };
}

/** The screen as a door: `true` lets the request on; `false` means the refusal has been sent. */
export async function requireRequestWithoutSexualContent(
  context: MobileRouteContext,
  reply: FastifyReply,
  input: { userId: string; projectId: string | null; text: string; door: string; log?: DoorLog | undefined }
): Promise<boolean> {
  const refusal = await screenRequestForSexualContent({
    text: input.text,
    door: input.door,
    deps: moderationDepsFor(context, { projectId: input.projectId, userId: input.userId }),
    log: input.log
  });
  if (!refusal) {
    return true;
  }
  sendContentRestricted(reply, refusal);
  return false;
}
