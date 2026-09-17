import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendRunLog, listRunLogs, readRunLog } from "./runLogs.js";
import { MemoryObjectStore } from "./testing.js";
import { objectKey, setObjectStoreForTests, S3ObjectStore, storageConfig } from "./store.js";
import { withTemporaryDirectory } from "./temporary.js";

afterEach(() => { vi.restoreAllMocks(); setObjectStoreForTests(null); });
it("requires the bucket in production and refuses malformed path-style settings", () => {
  expect(() => storageConfig({ NODE_ENV: "production" })).toThrow("S3_BUCKET");
  expect(() => storageConfig({ S3_FORCE_PATH_STYLE: "maybe" })).toThrow("true or false");
  expect(storageConfig({ S3_BUCKET: "private", S3_REGION: "eu-west-1" })).toMatchObject({ bucket: "private", region: "eu-west-1" });
});
it("rejects path traversal and ambiguous segments before storage I/O", () => {
  for (const segment of ["..", ".", "", "../secret", "a/b", "a\\b", "a\0b"]) {
    expect(() => objectKey("images", "project", segment)).toThrow();
  }
  expect(objectKey("images", "project", "safe image.png")).toBe("images/project/safe image.png");
});
it("reports only object absence as null and propagates access errors", async () => {
  const client = new S3Client({ region: "us-east-1" });
  const send = vi.spyOn(client, "send");
  const store = new S3ObjectStore({ bucket: "private", region: "us-east-1" }, client);
  send.mockRejectedValueOnce(Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } }));
  await expect(store.get("books/p/book.pdf")).resolves.toBeNull();
  send.mockRejectedValueOnce(Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } }));
  await expect(store.get("books/p/book.pdf")).rejects.toThrow("denied");
  send.mockRejectedValueOnce(new Error("network down"));
  await expect(store.head("books/p/book.pdf")).rejects.toThrow("network down");
  send.mockRejectedValueOnce(Object.assign(new Error("bucket missing"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } }));
  await expect(store.get("books/p/book.pdf")).rejects.toThrow("bucket missing");
});
it("readiness is a HeadBucket that names the bucket and endpoint when it fails", async () => {
  const client = new S3Client({ region: "us-east-1" });
  const send = vi.spyOn(client, "send");
  const store = new S3ObjectStore({ bucket: "private", region: "us-east-1", endpoint: "http://localhost:9000" }, client);
  send.mockResolvedValueOnce({} as never);
  await expect(store.ready()).resolves.toBeUndefined();
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
  expect(send.mock.calls[0]?.[0].input).toEqual({ Bucket: "private" });
  const denied = Object.assign(new Error("Forbidden"), { $metadata: { httpStatusCode: 403 } });
  send.mockRejectedValueOnce(denied);
  await expect(store.ready()).rejects.toMatchObject({
    message: 'Object storage bucket "private" is not reachable at http://localhost:9000: Forbidden', cause: denied
  });
  const aws = new S3ObjectStore({ bucket: "private", region: "eu-central-1" }, client);
  send.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
  await expect(aws.ready()).rejects.toThrow("not reachable at region eu-central-1: connect ECONNREFUSED");
});
it("releases local materialization even when a renderer throws", async () => {
  let path = "";
  await expect(withTemporaryDirectory("test", async (directory) => {
    path = directory; await writeFile(join(directory, "render.pdf"), "data"); throw new Error("renderer failed");
  })).rejects.toThrow("renderer failed");
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("immutable concurrent appends preserve every event and run grouping", async () => {
  setObjectStoreForTests(new MemoryObjectStore());
  const key = objectKey("books", "p", "runs", "job-generate-book.jsonl");
  await Promise.all(Array.from({ length: 50 }, (_, index) => appendRunLog(key, { event: "page", index })));
  const lines = (await readRunLog(key)).trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.map((line) => line.index)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  expect(await listRunLogs("p")).toMatchObject([{ key }]);
});

describe.runIf(process.env.S3_INTEGRATION === "true")("real private MinIO", () => {
  it("persists across clients, denies anonymous reads, atomically deduplicates, paginates and deletes only its prefix", async () => {
    const config = storageConfig();
    const first = new S3ObjectStore(config);
    const second = new S3ObjectStore(config);
    const prefix = objectKey("books", `integration-${Date.now()}`);
    const key = `${prefix}/book.pdf`;
    const neighbor = `${prefix}-other/book.pdf`;
    const bytes = Buffer.alloc(2 * 1024 * 1024, 73);
    try {
      await first.put(key, bytes, { contentType: "application/pdf" });
      expect(await second.get(key)).toEqual(bytes);
      expect(await second.head(key)).toMatchObject({ size: bytes.length, contentType: "application/pdf" });
      const anonymous = await fetch(`${config.endpoint}/${config.bucket}/${key}`);
      expect(anonymous.status).toBe(403);
      const writes = await Promise.all([first.putIfAbsent(`${prefix}/upload`, "one"), second.putIfAbsent(`${prefix}/upload`, "two")]);
      expect(writes.filter(Boolean)).toHaveLength(1);
      await first.copy(key, `${prefix}/copy.pdf`);
      expect(await second.get(`${prefix}/copy.pdf`)).toEqual(bytes);
      for (let offset = 0; offset < 1005; offset += 40) {
        await Promise.all(Array.from({ length: Math.min(40, 1005 - offset) }, (_, n) => first.put(`${prefix}/events/${offset + n}`, "event")));
      }
      expect((await second.list(`${prefix}/events/`)).length).toBe(1005);
      await first.put(neighbor, "keep");
      await second.deletePrefix(prefix);
      expect(await first.list(`${prefix}/`)).toEqual([]);
      expect((await first.get(neighbor))?.toString()).toBe("keep");
      expect(await first.get(key)).toBeNull();
    } finally {
      await first.deletePrefix(prefix); await first.delete(neighbor);
      first.client.destroy(); second.client.destroy();
    }
  }, 60_000);
});
