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

export async function resolveProjectActor(request: FastifyRequest, reply: FastifyReply): Promise<ProjectActor | null> {
  if (request.mobileAuth) {
    return {
      kind: "mobile",
      userId: request.mobileAuth.user.id,
      user: request.mobileAuth.user,
      sessionId: request.mobileAuth.sessionId
    };
  }

  const mobileAuth = await authenticateMobileBearer(request);
  if (mobileAuth) {
    if (isAuthFailure(mobileAuth)) {
      sendMobileAuthFailure(reply, mobileAuth);
      return null;
    }
    return {
      kind: "mobile",
      userId: mobileAuth.user.id,
      user: mobileAuth.user,
      sessionId: mobileAuth.sessionId
    };
  }

  const operatorAuth = request.operatorAuth ?? (await markOperatorRequest(request));
  return {
    kind: "operator",
    userId: operatorAuth.userId
  };
}

export function sendProjectNotFound(reply: FastifyReply, label = "Project not found"): FastifyReply {
  return reply.code(404).send({ error: label });
}

function isAuthFailure(value: AuthFailure | MobileAuthContext): value is AuthFailure {
  return "ok" in value && value.ok === false;
}
