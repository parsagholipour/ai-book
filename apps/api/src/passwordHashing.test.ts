import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PASSWORD_HASH_GATE,
  PasswordHashGate,
  PasswordHashingBusyError,
  hashPassword,
  passwordHashGate,
  passwordHashingErrorHandler,
  simulatePasswordVerification,
  verifyPassword
} from "./passwordHashing.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending microtask (a slot handed on, a task started) run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("password hash gate", () => {
  it("runs at most maxConcurrent tasks, queues the next ones in order and refuses past the queue", async () => {
    const gate = new PasswordHashGate({ maxConcurrent: 2, maxQueued: 2 });
    const tasks = Array.from({ length: 4 }, () => deferred());
    const started: number[] = [];
    const runs = tasks.map((task, index) =>
      gate.run(async () => {
        started.push(index);
        await task.promise;
        return index;
      })
    );
    await settle();

    expect(started).toEqual([0, 1]);
    expect(gate.running).toBe(2);
    expect(gate.queued).toBe(2);
    await expect(gate.run(async () => "never")).rejects.toBeInstanceOf(PasswordHashingBusyError);

    // A finished task hands its slot to the oldest waiter; nothing overtakes.
    tasks[1]!.resolve();
    await settle();
    expect(started).toEqual([0, 1, 2]);
    expect(gate.running).toBe(2);
    expect(gate.queued).toBe(1);

    for (const task of tasks) task.resolve();
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3]);
    expect(gate.running).toBe(0);
    expect(gate.queued).toBe(0);
  });

  it("frees the slot of a task that fails", async () => {
    const gate = new PasswordHashGate({ maxConcurrent: 1, maxQueued: 0 });

    await expect(gate.run(async () => Promise.reject(new Error("scrypt failed")))).rejects.toThrow("scrypt failed");
    expect(gate.running).toBe(0);
    await expect(gate.run(async () => "next")).resolves.toBe("next");
  });

  it("leaves two of libuv's four threads to the rest of the API", () => {
    expect(DEFAULT_PASSWORD_HASH_GATE.maxConcurrent).toBe(2);
    expect(passwordHashGate.capacity).toBe(DEFAULT_PASSWORD_HASH_GATE.maxConcurrent + DEFAULT_PASSWORD_HASH_GATE.maxQueued);
  });
});

describe("password hashing through the process-wide gate", () => {
  it("refuses every kind of derivation while the gate is full, and works again once it drains", async () => {
    const passwordHash = await hashPassword("CorrectPass123");
    const release = occupyPasswordHashGate();

    await expect(hashPassword("CorrectPass123")).rejects.toBeInstanceOf(PasswordHashingBusyError);
    await expect(verifyPassword("CorrectPass123", passwordHash)).rejects.toBeInstanceOf(PasswordHashingBusyError);
    await expect(simulatePasswordVerification("CorrectPass123")).rejects.toBeInstanceOf(PasswordHashingBusyError);

    await release();
    await expect(verifyPassword("CorrectPass123", passwordHash)).resolves.toBe(true);
  });

  it("starts two scrypt derivations of a burst and queues the rest", async () => {
    // Each call enters the gate before its first await, so the split is
    // visible as soon as the burst has been issued.
    const burst = Array.from({ length: 8 }, (_, index) => hashPassword(`password-${index}`));

    expect(passwordHashGate.running).toBe(2);
    expect(passwordHashGate.queued).toBe(6);
    await expect(Promise.all(burst)).resolves.toHaveLength(8);
    expect(passwordHashGate.running).toBe(0);
    expect(passwordHashGate.queued).toBe(0);
  });
});

describe("password hashing error handler", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify();
    apps.push(app);
    app.setErrorHandler((_error, _request, reply) => reply.code(500).send({ handledBy: "parent" }));
    await app.register(async (scope) => {
      scope.setErrorHandler(passwordHashingErrorHandler);
      scope.post("/busy", async () => {
        throw new PasswordHashingBusyError();
      });
      scope.post("/broken", async () => {
        throw new Error("database down");
      });
    });
    return app;
  }

  it("answers a refused derivation as RATE_LIMITED with a Retry-After", async () => {
    const response = await (await buildApp()).inject({ method: "POST", url: "/busy" });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json()).toEqual({ error: { code: "RATE_LIMITED", message: "Too many attempts. Try again soon." } });
  });

  it("hands every other error to the parent handler unchanged", async () => {
    const response = await (await buildApp()).inject({ method: "POST", url: "/broken" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ handledBy: "parent" });
  });
});

/** Fills every running slot and queue place of the shared gate; returns the release. */
function occupyPasswordHashGate(): () => Promise<void> {
  const hold = deferred();
  const holders = Array.from({ length: passwordHashGate.capacity }, () => passwordHashGate.run(() => hold.promise));
  return async () => {
    hold.resolve();
    await Promise.all(holders);
  };
}
