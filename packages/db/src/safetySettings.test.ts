import { describe, expect, it, vi } from "vitest";
import {
  createSexualContentFilterFlag,
  readCopyrightRestrictionsEnabled,
  readSexualContentFilterEnabled
} from "./safetySettings.ts";

function clientReturning(row: unknown) {
  const findFirst = vi.fn(async () => row);
  return { client: { safetySettingsRevision: { findFirst } } as never, findFirst };
}

describe("readSexualContentFilterEnabled", () => {
  it("is ON when no revision exists — the opposite default of the copyright flag", async () => {
    const { client } = clientReturning(null);
    await expect(readSexualContentFilterEnabled(client)).resolves.toBe(true);
    await expect(readCopyrightRestrictionsEnabled(client)).resolves.toBe(false);
  });

  it("follows an explicit revision either way", async () => {
    await expect(readSexualContentFilterEnabled(clientReturning({ sexualContentFilterEnabled: false }).client)).resolves.toBe(false);
    await expect(readSexualContentFilterEnabled(clientReturning({ sexualContentFilterEnabled: true }).client)).resolves.toBe(true);
  });

  it("reads a revision that carries no value for the column as ON", async () => {
    await expect(readSexualContentFilterEnabled(clientReturning({ copyrightRestrictionsEnabled: true }).client)).resolves.toBe(true);
  });

  it("reads the newest version", async () => {
    const { client, findFirst } = clientReturning(null);
    await readSexualContentFilterEnabled(client);
    expect(findFirst).toHaveBeenCalledWith({ orderBy: { version: "desc" }, select: { sexualContentFilterEnabled: true } });
  });
});

describe("createSexualContentFilterFlag", () => {
  it("caches one read for its window and reads again after it", async () => {
    let clock = 0;
    const { client, findFirst } = clientReturning({ sexualContentFilterEnabled: false });
    const flag = createSexualContentFilterFlag(() => client, { ttlMs: 60_000, now: () => clock });
    await expect(flag.enabled()).resolves.toBe(false);
    clock = 59_999;
    await expect(flag.enabled()).resolves.toBe(false);
    expect(findFirst).toHaveBeenCalledTimes(1);
    clock = 60_000;
    await flag.enabled();
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it("shares one read between concurrent callers", async () => {
    const { client, findFirst } = clientReturning(null);
    const flag = createSexualContentFilterFlag(() => client);
    await expect(Promise.all([flag.enabled(), flag.enabled(), flag.enabled()])).resolves.toEqual([true, true, true]);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("fails closed: a read that fails answers ON and reports the error", async () => {
    const error = new Error("connection reset");
    const onReadError = vi.fn();
    const client = { safetySettingsRevision: { findFirst: vi.fn(async () => { throw error; }) } } as never;
    const flag = createSexualContentFilterFlag(() => client, { onReadError });
    await expect(flag.enabled()).resolves.toBe(true);
    expect(onReadError).toHaveBeenCalledWith(error);
  });

  it("forgets its answer on a console save", async () => {
    const findFirst = vi.fn()
      .mockResolvedValueOnce({ sexualContentFilterEnabled: true })
      .mockResolvedValueOnce({ sexualContentFilterEnabled: false });
    const flag = createSexualContentFilterFlag(() => ({ safetySettingsRevision: { findFirst } }) as never);
    await expect(flag.enabled()).resolves.toBe(true);
    flag.forget();
    await expect(flag.enabled()).resolves.toBe(false);
  });

  it("reads a stand-in client with no safety table as OFF, uncached", async () => {
    let client: unknown = null;
    const flag = createSexualContentFilterFlag(() => client as never);
    await expect(flag.enabled()).resolves.toBe(false);
    client = clientReturning(null).client;
    await expect(flag.enabled()).resolves.toBe(true);
  });
});
