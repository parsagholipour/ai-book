import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@book-maker/core";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  authenticateMobileBearer,
  markOperatorRequest,
  sendMobileAuthFailure
} from "./requestAuth.js";
import { hasCurrentLegalAcceptance } from "./legalAcceptance.js";

const AUTH_COOKIE_NAME = "ai_book_maker_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const loginBodySchema = z.object({
  password: z.string().min(1).max(1000)
});

type AuthStatus = {
  enabled: boolean;
  authenticated: boolean;
};

export async function registerAuth(app: FastifyInstance, config: AppConfig) {
  app.get("/api/auth/status", async (request): Promise<AuthStatus> => {
    const enabled = isAuthEnabled(config);
    return {
      enabled,
      authenticated: !enabled || isAuthenticatedRequest(request, config)
    };
  });

  app.post("/api/auth/login", async (request, reply): Promise<AuthStatus | FastifyReply> => {
    if (!isAuthEnabled(config)) {
      return { enabled: false, authenticated: true };
    }

    const { password } = loginBodySchema.parse(request.body);
    if (!passwordMatches(password, config.WEB_PASSWORD)) {
      return reply.code(401).send({ error: "Invalid password" });
    }

    setAuthCookie(reply, createSessionToken(config.WEB_PASSWORD));
    return { enabled: true, authenticated: true };
  });

  app.post("/api/auth/logout", async (_request, reply): Promise<AuthStatus> => {
    clearAuthCookie(reply);
    const enabled = isAuthEnabled(config);
    return { enabled, authenticated: !enabled };
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = pathFromRequestUrl(request.url);
    if (!shouldProtectPath(path)) {
      return;
    }

    const operatorAuthenticated = isAuthenticatedRequest(request, config);
    if (isOperatorOnlyPath(path)) {
      if (operatorAuthenticated) {
        await markOperatorRequest(request);
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

    return reply.code(401).send({ error: "Password required" });
  });
}

function isAuthEnabled(config: AppConfig): config is AppConfig & { WEB_PASSWORD: string } {
  return Boolean(config.WEB_PASSWORD);
}

function pathFromRequestUrl(rawUrl: string): string {
  return new URL(rawUrl, "http://localhost").pathname;
}

function shouldProtectPath(path: string): boolean {
  if (
    path === "/api/health" ||
    path === "/api/mobile/legal" ||
    path === "/api/mobile/sample-book" ||
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/mobile/auth/")
  ) {
    return false;
  }
  return path.startsWith("/api/") || path.startsWith("/assets/images/") || path.startsWith("/assets/voice/") || path.startsWith("/docs");
}

/**
 * Existing data stays readable while acceptance is outstanding. Destructive
 * deletion, reporting, subscription management, logout, and call settlement
 * also remain available so the acceptance screen can never trap a user in an
 * account or paid/active operation.
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
    path.startsWith("/api/mobile/billing/") ||
    path.endsWith("/reports") ||
    path.endsWith("/heartbeat") ||
    path.endsWith("/end")
  ) {
    return false;
  }
  return true;
}

function isOperatorOnlyPath(path: string): boolean {
  return (
    path.startsWith("/docs") ||
    path.startsWith("/api/admin/") ||
    path === "/api/runtime" ||
    path === "/api/voice/rtc-config" ||
    path === "/api/voice/providers"
  );
}

function isAuthenticatedRequest(request: FastifyRequest, config: AppConfig): boolean {
  if (!isAuthEnabled(config)) {
    return true;
  }
  const token = readCookie(request, AUTH_COOKIE_NAME);
  return Boolean(token && verifySessionToken(token, config.WEB_PASSWORD));
}

function passwordMatches(input: string, expected: string): boolean {
  return timingSafeEqual(hash(input), hash(expected));
}

function createSessionToken(password: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
    })
  ).toString("base64url");
  const signature = signPayload(payload, password);
  return `${payload}.${signature}`;
}

function verifySessionToken(token: string, password: string): boolean {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) {
    return false;
  }

  const expectedSignature = signPayload(payload, password);
  if (!safeEqual(signature, expectedSignature)) {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof decoded.exp === "number" && decoded.exp > Date.now();
  } catch {
    return false;
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

function setAuthCookie(reply: FastifyReply, value: string): void {
  reply.header("Set-Cookie", serializeCookie(AUTH_COOKIE_NAME, value, SESSION_MAX_AGE_SECONDS));
}

function clearAuthCookie(reply: FastifyReply): void {
  reply.header("Set-Cookie", serializeCookie(AUTH_COOKIE_NAME, "", 0));
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
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
