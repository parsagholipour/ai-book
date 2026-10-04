import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAccountRunLogs, MemoryObjectStore, readRunLog, setObjectStoreForTests } from "@book-maker/storage";

vi.mock("../runtime/config.js", () => ({ config: {} }));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: vi.fn() }));

import { createRunLogger } from "./runLogging.js";

const job = { id: "bull-1", name: "generate-page", data: { projectId: "project-1", generationJobId: "run-1" } } as never;

describe("durable worker run logs", () => {
  let store: MemoryObjectStore;
  beforeEach(() => { store = new MemoryObjectStore(); setObjectStoreForTests(store); });

  it("stores concurrent append events separately and reconstructs one ordered log", async () => {
    const logger = createRunLogger(job);
    await Promise.all([logger.append("start", { index: 1 }), logger.append("end", { index: 2 })]);
    const lines = (await readRunLog(logger.filePath)).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.event)).toEqual(["start", "end"]);
    expect(await store.list(`${logger.filePath}.events/`)).toHaveLength(2);
  });

  it("preserves compact buffer, bigint and circular diagnostic serialization", async () => {
    const logger = createRunLogger(job);
    const details: Record<string, unknown> = { bytes: Buffer.from("large payload"), tokenCount: 42n };
    details.self = details;
    await logger.append("response", { details });
    expect(JSON.parse((await readRunLog(logger.filePath)).trim()).details).toEqual({
      bytes: { type: "Buffer", bytes: 13 }, tokenCount: "42", self: "[Circular]"
    });
  });

  it("keeps projectless portrait prompts under their account and stops logging after deletion", async () => {
    const logger = createRunLogger({
      id: "bull-portrait", name: "generate-character-portrait",
      data: { generationJobId: "portrait-1", userId: "user-1", libraryCharacterId: "character-1" }
    } as never);
    await logger.append("image.generate.request", { request: { prompt: "private character description" } });
    expect(logger.filePath).toBe("books/.account-runs/user-1/runs/portrait-1-generate-character-portrait.jsonl");
    expect(await readRunLog(logger.filePath)).toContain("private character description");
    expect(await store.list("books/_unknown-project/")).toEqual([]);

    await deleteAccountRunLogs("user-1");
    await logger.append("image.generate.response", { response: "late private response" });
    expect(await readRunLog(logger.filePath)).toBe("");
  });

  it("does not fail generation when the diagnostic object cannot be written", async () => {
    vi.spyOn(store, "put").mockRejectedValue(new Error("S3 unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(createRunLogger(job).append("response", {})).resolves.toEqual(expect.any(String));
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
