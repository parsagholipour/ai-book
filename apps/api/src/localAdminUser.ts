/**
 * The operator console's own user: every console request acts as it, and the
 * worker stamps its provider calls with it for console books. A leaf with no
 * imports, so a module that only needs to recognise the id (the spend breaker)
 * does not pull `requestAuth.ts`'s session graph in behind it.
 */
export const DEFAULT_LOCAL_ADMIN_USER_ID = "local-admin";
export const DEFAULT_LOCAL_ADMIN_USER_EMAIL = "local-admin@ai-book-maker.local";
