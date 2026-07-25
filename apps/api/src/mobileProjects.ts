import type { FastifyPluginAsync } from "fastify";
import { ensureSeedTemplates } from "@book-maker/db";
import { ensureDefaultProductCatalog } from "@book-maker/db/billing";
import { createMobileRouteContext, type MobileProjectRoutesOptions } from "./mobile/routeContext.js";
import { registerMobileAccountRoutes } from "./mobile/routes/account.js";
import { registerMobileCreationDraftRoutes } from "./mobile/routes/creationDrafts.js";
import { registerMobileCreationSessionRoutes } from "./mobile/routes/creationSessions.js";
import { registerMobileProjectRoutes } from "./mobile/routes/projects.js";
import { registerMobileProjectChatRoutes } from "./mobile/routes/projectChat.js";
import { registerMobileBookRoutes } from "./mobile/routes/book.js";
import { registerMobileStatusRoutes } from "./mobile/routes/status.js";
import { registerMobilePlanRoutes } from "./mobile/routes/plans.js";
import { registerMobileExportRoutes } from "./mobile/routes/exports.js";

/**
 * Composition root for the mobile API.
 *
 * Route groups live under `./mobile/routes/` and are registered directly on the
 * same Fastify instance (not via `register`), so they share one encapsulation
 * context exactly as they did when this was a single plugin. Shared setup —
 * config, rate limiters, billing verifier, AI enrichment hooks — is built once
 * in `createMobileRouteContext` and threaded through.
 *
 * Everything re-exported below is public API used by `server.ts`, the mobile
 * import routes, or the test suite.
 */
export const mobileProjectRoutes: FastifyPluginAsync<MobileProjectRoutesOptions> = async (fastify, options) => {
  await ensureSeedTemplates();
  await ensureDefaultProductCatalog();
  const context = createMobileRouteContext(options);
  // Raw binary uploads for chat attachments; metadata travels in the query string.
  fastify.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  await registerMobileAccountRoutes(fastify, context);
  await registerMobileCreationDraftRoutes(fastify, context);
  await registerMobileCreationSessionRoutes(fastify, context);
  await registerMobileProjectRoutes(fastify, context);
  await registerMobileProjectChatRoutes(fastify, context);
  await registerMobileBookRoutes(fastify, context);
  await registerMobileStatusRoutes(fastify, context);
  await registerMobilePlanRoutes(fastify, context);
  await registerMobileExportRoutes(fastify, context);
};

export { MOBILE_PRODUCT_PRESETS, mobileAuthError } from "./mobile/schemas.js";
export { hitAuthenticatedLimit, requireMobileAuth, sendMobileError } from "./mobile/httpErrors.js";
export { buildMobileCreateProjectInput, loadMobileProjectDetail } from "./mobile/projectRecords.js";
export { serializeProjectDetail } from "./mobile/projectSerializers.js";
export { reconcileRetryablePlanRevisionOperations } from "./mobile/editOperations.js";
export type { MobileProjectRoutesOptions } from "./mobile/routeContext.js";
export type * from "./mobile/dto.js";
