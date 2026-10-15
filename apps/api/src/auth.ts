import { clientNetworkRateLimitKey, InMemoryRateLimiter } from "./rateLimit.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@book-maker/core";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  allowsMobileBearer,
  authenticateMobileBearer,
  ensureDefaultLocalAdminUser,
  routedRequestPath,
  sendMobileAuthFailure
} from "./requestAuth.js";
import { readBearerToken } from "./mobileAuth.js";
import { hasCurrentLegalAcceptance } from "./legalAcceptance.js";
import { advanceOperatorEpoch, currentOperatorEpoch } from "./operatorSessions.js";

const AUTH_COOKIE_NAME = "ai_book_maker_session";
/**
 * A console cookie lives a week. It was 30 days, and it could not be revoked:
 * the shortest life that does not have the owner signing in daily, now that
 * "sign out everywhere" (`operatorSessions.ts`) can end it sooner.
 */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const loginBodySchema = z.object({
  password: z.string().min(1).max(1000)
});

type AuthStatus = {
  enabled: boolean;
  authenticated: boolean;
};

/** Ten guesses per address per fifteen minutes. */
const operatorLoginLimiter = new InMemoryRateLimiter({ maxAttempts: 10, windowMs: 15 * 60 * 1000 });

export async function registerAuth(app: FastifyInstance, config: AppConfig) {
  app.get("/api/auth/status", async (request): Promise<AuthStatus> => {
    const enabled = isAuthEnabled(config);
    return {
      enabled,
      authenticated: !enabled || (await isAuthenticatedRequest(request, config))
    };
  });

  app.post("/api/auth/login", async (request, reply): Promise<AuthStatus | FastifyReply> => {
    if (!isAuthEnabled(config)) {
      return { enabled: false, authenticated: true };
    }

    // One shared password guards pricing, moderation and every admin read on
    // the public hostname, so guesses are counted per address — per /64 for
    // IPv6, which a client rotates inside for free.
    const limit = operatorLoginLimiter.hit(clientNetworkRateLimitKey(request, "operator-login"));
    if (!limit.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(limit.retryAfterSeconds))
        .send({ error: "Too many sign-in attempts. Try again later." });
    }

    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Password required" });
    }
    if (!passwordMatches(parsed.data.password, config.WEB_PASSWORD)) {
      return reply.code(401).send({ error: "Invalid password" });
    }

    // A cookie names the generation it was issued under; with none readable
    // it could not be verified anyway, so none is issued.
    const epoch = await currentOperatorEpoch();
    if (epoch === null) {
      return reply.code(503).send({ error: "Sign-in is unavailable right now. Try again shortly." });
    }
    setAuthCookie(reply, createSessionToken(config.WEB_PASSWORD, epoch), config.NODE_ENV === "production");
    return { enabled: true, authenticated: true };
  });

  app.post("/api/auth/logout", async (_request, reply): Promise<AuthStatus> => {
    clearAuthCookie(reply);
    const enabled = isAuthEnabled(config);
    return { enabled, authenticated: !enabled };
  });

  // Signs every browser out, this one included, by moving the generation every
  // cookie is checked against. `/api/auth/*` is outside the protected set, so
  // the cookie is checked here; SameSite=Lax keeps a cross-site POST from
  // carrying it.
  app.post("/api/auth/logout-everywhere", async (request, reply): Promise<AuthStatus | FastifyReply> => {
    if (!isAuthEnabled(config)) {
      return { enabled: false, authenticated: true };
    }
    if (!(await isAuthenticatedRequest(request, config))) {
      return reply.code(401).send({ error: "Password required" });
    }
    await advanceOperatorEpoch();
    clearAuthCookie(reply);
    return { enabled: true, authenticated: false };
  });

  // Console and /docs responses may not be framed by another site, sniffed
  // into another type, or leak their URL as a referrer. Not the mobile
  // surface (JSON and image bytes the app fetches) and not `/s/`, whose share
  // pages set their own headers. SAMEORIGIN rather than DENY: the console's
  // PDF preview frames an export URL of this same origin. In production nginx
  // serves the console's own HTML and needs the same headers there.
  app.addHook("onSend", async (request, reply, payload) => {
    const path = routedRequestPath(request);
    if (path !== null && (allowsMobileBearer(path) || path === "/s" || path.startsWith("/s/"))) {
      return payload;
    }
    for (const [name, value] of CONSOLE_SECURITY_HEADERS) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    return payload;
  });

  app.addHook("onRequest", async (request, reply) => {
    // This one socket route authenticates a call-scoped ticket in its own
    // preValidation hook. The flag is server-owned route metadata, not input.
    if (request.routeOptions.config.voiceRelay === true && request.method === "GET" && request.headers.upgrade?.toLowerCase() === "websocket") return;
    // The route the router matched, never `request.url`: an encoded
    // `/%61pi/admin/users` routes to the admin handler (`routedRequestPath`).
    // A path that would not decode is protected as operator-only.
    const path = routedRequestPath(request);
    if (path !== null && !shouldProtectPath(path)) {
      return;
    }

    const operatorAuthenticated = await isAuthenticatedRequest(request, config);
    if (path === null || isOperatorOnlyPath(path)) {
      if (operatorAuthenticated) {
        // With password auth disabled, a mobile bearer must still reach the
        // handler as a bearer so `requireOperatorActor` can reject it. With
        // password auth enabled, `operatorAuthenticated` proves the cookie and
        // the established operator context intentionally wins any bearer.
        if (isAuthEnabled(config) || !readBearerToken(request)) {
          await markOperatorRequest(request);
        }
        return;
      }
      return reply.code(401).send({ error: "Password required" });
    }

    const mobileAuth = await authenticateMobileBearer(request);
    if (mobileAuth) {
      if ("ok" in mobileAuth) {
        return sendMobileAuthFailure(reply, mobileAuth);
      }
      if (
        requiresCurrentLegalAcceptance(request.method, path) &&
        !(await hasCurrentLegalAcceptance(mobileAuth.user.id))
      ) {
        return reply.code(428).send({
          error: {
            code: "LEGAL_ACCEPTANCE_REQUIRED",
            message: "Review and accept the current Terms and Privacy Policy to continue."
          }
        });
      }
      return;
    }

    if (operatorAuthenticated) {
      await markOperatorRequest(request);
      return;
    }

    // Signed out on the app's own surface. It has to answer in the app's error
    // envelope: every `/api/mobile/*` route declares its 401 as
    // `{ error: { code, message } }`, so the console's `{ error: "Password
    // required" }` failed response serialization and the app saw a 500 instead
    // of the 401 that sends it to sign-in.
    if (allowsMobileBearer(path)) {
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "Sign in to continue." } });
    }
    return reply.code(401).send({ error: "Password required" });
  });
}

/**
 * The only place an operator is made. Handlers read `request.operatorAuth` and
 * never set it — `resolveProjectActor` refuses a request this hook did not
 * mark — so a request that gets past the hook by any route still is no one.
 */
async function markOperatorRequest(request: FastifyRequest): Promise<void> {
  request.operatorAuth = { userId: await ensureDefaultLocalAdminUser() };
}

function isAuthEnabled(config: AppConfig): config is AppConfig & { WEB_PASSWORD: string } {
  return Boolean(config.WEB_PASSWORD);
}

function shouldProtectPath(path: string): boolean {
  if (
    path === "/api/health" ||
    // Readiness for an uptime monitor: terse, cached, no secrets (src/monitoring/readiness.ts).
    path === "/api/ready" ||
    // Authenticated independently with Google's Pub/Sub OIDC token.
    path === "/api/billing/google-play/rtdn" ||
    path === "/api/mobile/legal" ||
    path === "/api/mobile/sample-book" ||
    path === "/api/mobile/app-update" ||
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/mobile/auth/")
  ) {
    return false;
  }
  return path.startsWith("/api/") || path.startsWith("/assets/images/") || path.startsWith("/assets/voice/") || path.startsWith("/docs");
}

/**
 * Existing data stays readable while acceptance is outstanding. Destructive
 * deletion, reporting, subscription management, logout, call settlement and
 * product analytics also remain available so the acceptance screen can never trap a user in an
 * account or paid/active operation.
 *
 * `path` is the matched route pattern (`routedRequestPath`), so the suffix
 * tests read the route as written — `/api/mobile/voice/calls/:callId/end` —
 * and no id a client chooses can make a path end in `/end`.
 */
export function requiresCurrentLegalAcceptance(method: string, path: string): boolean {
  if (!["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
    return false;
  }
  if (!path.startsWith("/api/mobile/")) {
    return false;
  }
  if (
    path === "/api/mobile/legal/acceptance" ||
    path === "/api/mobile/account/deletion-request" ||
    // Product analytics (a paywall view): recording one is not the reader
    // agreeing to anything, and a 428 here sent a reader who chose "Not now"
    // straight back to the terms screen from the paywall.
    path === "/api/mobile/events" ||
    path.startsWith("/api/mobile/billing/") ||
    path.endsWith("/reports") ||
    path.endsWith("/heartbeat") ||
    path.endsWith("/end")
  ) {
    return false;
  }
  return true;
}

/**
 * Everything protected that is not the mobile surface — `/docs`, `/api/admin/*`,
 * `/api/runtime`, the voice provider config, and the whole legacy operator API
 * under `/api/projects`, `/api/plans` and `/api/templates`.
 *
 * It is expressed as the complement of `allowsMobileBearer` rather than as its
 * own list because the two have to partition the protected surface exactly: a
 * route missing from an operator-only list was not merely undocumented, it
 * accepted mobile bearer tokens. That is how the operator export handlers came
 * to serve an app user a render nobody was charged for.
 */
function isOperatorOnlyPath(path: string): boolean {
  return !allowsMobileBearer(path);
}

const CONSOLE_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Frame-Options", "SAMEORIGIN"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "same-origin"]
];

async function isAuthenticatedRequest(request: FastifyRequest, config: AppConfig): Promise<boolean> {
  if (!isAuthEnabled(config)) {
    return true;
  }
  const token = readCookie(request, AUTH_COOKIE_NAME);
  const issuedUnder = token ? verifiedSessionEpoch(token, config.WEB_PASSWORD) : null;
  if (issuedUnder === null) {
    return false;
  }
  // Only a cookie that already verifies pays for the generation read, and an
  // unreadable generation refuses it.
  const current = await currentOperatorEpoch();
  return current !== null && issuedUnder === current;
}

function passwordMatches(input: string, expected: string): boolean {
  return timingSafeEqual(hash(input), hash(expected));
}

function createSessionToken(password: string, epoch: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
      epoch
    })
  ).toString("base64url");
  const signature = signPayload(payload, password);
  return `${payload}.${signature}`;
}

/**
 * The generation a cookie was issued under, when its signature and expiry
 * check out; otherwise `null`. A cookie with no generation predates sign-out
 * everywhere (and the 7-day life) and is refused: the operator signs in once.
 */
function verifiedSessionEpoch(token: string, password: string): number | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) {
    return null;
  }

  const expectedSignature = signPayload(payload, password);
  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown; epoch?: unknown };
    const now = Date.now();
    if (typeof decoded.exp !== "number" || decoded.exp <= now || decoded.exp > now + SESSION_MAX_AGE_SECONDS * 1000) {
      return null;
    }
    return typeof decoded.epoch === "number" && Number.isSafeInteger(decoded.epoch) ? decoded.epoch : null;
  } catch {
    return null;
  }
}

function signPayload(payload: string, password: string): string {
  return createHmac("sha256", password).update(payload).digest("base64url");
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function setAuthCookie(reply: FastifyReply, value: string, secure: boolean): void {
  reply.header("Set-Cookie", serializeCookie(AUTH_COOKIE_NAME, value, SESSION_MAX_AGE_SECONDS, secure));
}

function clearAuthCookie(reply: FastifyReply): void {
  reply.header("Set-Cookie", serializeCookie(AUTH_COOKIE_NAME, "", 0));
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number, secure = false): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    // Production is HTTPS end to end at the edge; the cookie never rides plain HTTP.
    ...(secure ? ["Secure"] : []),
    `Max-Age=${maxAgeSeconds}`
  ].join("; ");
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) {
    return null;
  }

  for (const cookie of header.split(";")) {
    const [rawName, ...rawValue] = cookie.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return null;
}
