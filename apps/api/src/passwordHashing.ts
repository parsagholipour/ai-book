import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { sendRateLimitError } from "./rateLimit.js";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export type PasswordHashGateConfig = {
  /** Derivations running at once; each one holds a libuv threadpool thread. */
  maxConcurrent: number;
  /** Derivations allowed to wait for a slot before new ones are refused. */
  maxQueued: number;
};

/**
 * Two of libuv's four threads. Node runs every scrypt on that pool, and the
 * same pool serves the filesystem, DNS lookups and sharp; one derivation here
 * costs tens of milliseconds, so about a hundred sign-in attempts a second —
 * spread across enough addresses that no per-address limit fires — used to
 * occupy all four threads and stall every other route waiting on one. Capping
 * the derivations at two leaves the other two to the rest of the API whatever
 * arrives. A full queue drains in about a second at that rate, which is why a
 * refusal asks for a retry after one.
 */
export const DEFAULT_PASSWORD_HASH_GATE: PasswordHashGateConfig = { maxConcurrent: 2, maxQueued: 32 };
const BUSY_RETRY_AFTER_SECONDS = 1;

/** The gate's queue was full, so the derivation never started. */
export class PasswordHashingBusyError extends Error {
  readonly retryAfterSeconds = BUSY_RETRY_AFTER_SECONDS;

  constructor() {
    super("Password hashing is at capacity");
    this.name = "PasswordHashingBusyError";
  }
}

/**
 * A counting semaphore with a bounded FIFO queue. A released slot is handed
 * straight to the oldest waiter, so a newcomer never overtakes the queue, and
 * a full queue refuses at once rather than letting waiters pile up without end.
 */
export class PasswordHashGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly config: PasswordHashGateConfig;

  constructor(config: PasswordHashGateConfig) {
    this.config = config;
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  get capacity(): number {
    return this.config.maxConcurrent + this.config.maxQueued;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.config.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.config.maxQueued) {
      return Promise.reject(new PasswordHashingBusyError());
    }
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

/**
 * Process-wide, because the threadpool it protects is. Every scrypt call in
 * this module passes through it — a hash, a verification and the simulated
 * verification that keeps a missing account's timing honest — so no caller can
 * forget it.
 */
export const passwordHashGate = new PasswordHashGate(DEFAULT_PASSWORD_HASH_GATE);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await deriveScryptKey(password, salt, SCRYPT_KEY_LENGTH);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEY_LENGTH, salt.toString("base64url"), derivedKey.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) {
    return false;
  }

  const derivedKey = await deriveScryptKey(password, parsed.salt, parsed.keyLength, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p
  });
  return safeEqual(derivedKey, parsed.hash);
}

/** The scrypt spend of a real verification, for an account that does not exist. */
export async function simulatePasswordVerification(password: string): Promise<void> {
  await deriveScryptKey(password, Buffer.from("missing-mobile-user"), SCRYPT_KEY_LENGTH);
}

/**
 * The error handler each unauthenticated auth plugin installs. A refused
 * derivation becomes the `RATE_LIMITED` answer the app already shows, with the
 * route's own 429 body; anything else is rethrown, which Fastify hands to the
 * parent context's handler exactly as if this one were not there.
 */
export function passwordHashingErrorHandler(error: unknown, _request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof PasswordHashingBusyError) {
    sendRateLimitError(reply, error.retryAfterSeconds);
    return;
  }
  throw error;
}

async function deriveScryptKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  overrides: Partial<{ N: number; r: number; p: number }> = {}
): Promise<Buffer> {
  const options: ScryptOptions = {
    N: overrides.N ?? SCRYPT_N,
    r: overrides.r ?? SCRYPT_R,
    p: overrides.p ?? SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  };
  return passwordHashGate.run(() => scryptBuffer(password, salt, keyLength, options));
}

function scryptBuffer(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function parsePasswordHash(encodedHash: string):
  | {
      n: number;
      r: number;
      p: number;
      keyLength: number;
      salt: Buffer;
      hash: Buffer;
    }
  | null {
  const [algorithm, rawN, rawR, rawP, rawKeyLength, rawSalt, rawHash, extra] = encodedHash.split("$");
  if (algorithm !== "scrypt" || extra !== undefined || !rawN || !rawR || !rawP || !rawKeyLength || !rawSalt || !rawHash) {
    return null;
  }

  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  const keyLength = Number(rawKeyLength);
  if (![n, r, p, keyLength].every((value) => Number.isInteger(value) && value > 0)) {
    return null;
  }

  try {
    return {
      n,
      r,
      p,
      keyLength,
      salt: Buffer.from(rawSalt, "base64url"),
      hash: Buffer.from(rawHash, "base64url")
    };
  } catch {
    return null;
  }
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
