import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@book-maker/db";
import {
  readBearerToken,
  verifyMobileAccessToken,
  type AuthFailure,
  type AuthUser
} from "./mobileAuth.js";

export const DEFAULT_LOCAL_ADMIN_USER_ID = "local-admin";
export const DEFAULT_LOCAL_ADMIN_USER_EMAIL = "local-admin@ai-book-maker.local";

let defaultLocalAdminUserId: Promise<string> | null = null;

export type MobileAuthContext = {
  user: AuthUser;
  sessionId: string;
};

export type OperatorAuthContext = {
  userId: string;
};

export type ProjectActor =
  | {
      kind: "mobile";
      userId: string;
      user: AuthUser;
      sessionId: string;
    }
  | {
      kind: "operator";
      userId: string;
    };

export type OperatorProjectActor = Extract<ProjectActor, { kind: "operator" }>;

const MOBILE_BEARER_PATH_PREFIXES = ["/api/mobile/", "/assets/images/", "/assets/voice/"];

/**
 * The surface a mobile bearer token authenticates, and the only one.
 *
 * `/api/mobile/*` is the product API. The two asset prefixes are shared
 * deliberately: the serializers hand the app image and voice URLs under them and
 * the Flutter client fetches those with the same bearer, so
 * `sendOwnedProjectAsset` is the one handler outside the mobile routes that
 * legitimately sees a mobile actor. They are listed rather than covered by a
 * `/assets/` prefix so that this stays the exact complement of the asset paths
 * `shouldProtectPath` guards — a new asset route omitted here fails loudly with
 * a 401 instead of quietly widening what a bearer reaches. Everything else
 * behind the `onRequest` hook belongs to the operator console, which
 * authenticates with the WEB_PASSWORD cookie and nothing else.
 *
 * The legacy operator API is not a second, cheaper door into the product, and
 * checking ownership is not enough to keep it from being one — every route there
 * scopes to `actor.userId`, so a mobile bearer reached exactly its own books and
 * paid nothing for them. `POST /api/plans/:id/approve` starts a whole book with
 * no credit reservation and no free-tier image slot;
 * `GET /api/projects/:id/export/*` renders inline and sends the file without the
 * entitlement its `/api/mobile/*` twin charges for — and that render is an
 * unbounded Chromium inside a Fastify handler, which is exactly what the mobile
 * export routes were rewritten to stop doing.
 */
export function allowsMobileBearer(path: string): boolean {
  return MOBILE_BEARER_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function pathFromRequestUrl(rawUrl: string): string {
  return new URL(rawUrl, "http://localhost").pathname;
}

declare module "fastify" {
  interface FastifyRequest {
    mobileAuth?: MobileAuthContext;
    operatorAuth?: OperatorAuthContext;
  }
}

export async function authenticateMobileBearer(request: FastifyRequest): Promise<MobileAuthContext | AuthFailure | null> {
  const token = readBearerToken(request);
  if (!token) {
    return null;
  }
  const verified = await verifyMobileAccessToken(token);
  if (!verified.ok) {
    return verified;
  }
  const context = {
    user: verified.user,
    sessionId: verified.sessionId
  };
  request.mobileAuth = context;
  return context;
}

export function sendMobileAuthFailure(reply: FastifyReply, failure: AuthFailure): FastifyReply {
  return reply.code(failure.statusCode).send({
    error: {
      code: failure.code,
      message: failure.message
    }
  });
}

export async function ensureDefaultLocalAdminUser(): Promise<string> {
  defaultLocalAdminUserId ??= upsertDefaultLocalAdminUser();
  return defaultLocalAdminUserId;
}

async function upsertDefaultLocalAdminUser(): Promise<string> {
  const user = await prisma.user.upsert({
    where: { email: DEFAULT_LOCAL_ADMIN_USER_EMAIL },
    create: {
      id: DEFAULT_LOCAL_ADMIN_USER_ID,
      email: DEFAULT_LOCAL_ADMIN_USER_EMAIL,
      displayName: "Local Admin"
    },
    update: {
      displayName: "Local Admin"
    },
    select: { id: true }
  });
  return user.id;
}

export async function markOperatorRequest(request: FastifyRequest): Promise<OperatorAuthContext> {
  const operatorAuth = {
    userId: await ensureDefaultLocalAdminUser()
  };
  request.operatorAuth = operatorAuth;
  return operatorAuth;
}

/**
 * The actor a project route acts for.
 *
 * A mobile bearer only ever produces a mobile actor on the surface
 * `allowsMobileBearer` names. Off it the token is refused outright rather than
 * quietly falling through to the operator branch — the `onRequest` hook in
 * `auth.ts` already answers 401 there, but only when a WEB_PASSWORD is
 * configured, and this rule has to hold either way.
 */
export async function resolveProjectActor(request: FastifyRequest, reply: FastifyReply): Promise<ProjectActor | null> {
  // The auth hook has already verified the operator cookie before setting this
  // context. Once established it wins over an incidental Authorization header:
  // browser extensions and stale API tooling can add one, but they must not
  // turn a valid operator request into a mobile actor or an auth failure.
  if (request.operatorAuth) {
    return {
      kind: "operator",
      userId: request.operatorAuth.userId
    };
  }

  const mobileAuth = request.mobileAuth ?? (await authenticateMobileBearer(request));
  if (mobileAuth) {
    if (isAuthFailure(mobileAuth)) {
      sendMobileAuthFailure(reply, mobileAuth);
      return null;
    }
    if (!allowsMobileBearer(pathFromRequestUrl(request.url))) {
      sendOperatorOnly(reply);
      return null;
    }
    return {
      kind: "mobile",
      userId: mobileAuth.user.id,
      user: mobileAuth.user,
      sessionId: mobileAuth.sessionId
    };
  }

  const operatorAuth = await markOperatorRequest(request);
  return {
    kind: "operator",
    userId: operatorAuth.userId
  };
}

/**
 * The operator console's own routes, which are unpriced and unmetered because
 * the only way to reach them is the WEB_PASSWORD cookie.
 *
 * `resolveProjectActor` already refuses a mobile bearer off the mobile surface,
 * so this restates that rule where it is load-bearing rather than discovering
 * it: a handler that asks for an operator cannot be opened to the app by a
 * later edit to one path list.
 */
export async function requireOperatorActor(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<OperatorProjectActor | null> {
  const actor = await resolveProjectActor(request, reply);
  if (!actor) {
    return null;
  }
  if (actor.kind !== "operator") {
    sendOperatorOnly(reply);
    return null;
  }
  return actor;
}

function sendOperatorOnly(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ error: "Operator access required" });
}

export function sendProjectNotFound(reply: FastifyReply, label = "Project not found"): FastifyReply {
  return reply.code(404).send({ error: label });
}

function isAuthFailure(value: AuthFailure | MobileAuthContext): value is AuthFailure {
  return "ok" in value && value.ok === false;
}
