import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryObjectStore, readRunLog, setObjectStoreForTests } from "@book-maker/storage";

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

  it("does not fail generation when the diagnostic object cannot be written", async () => {
    vi.spyOn(store, "put").mockRejectedValue(new Error("S3 unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(createRunLogger(job).append("response", {})).resolves.toEqual(expect.any(String));
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
