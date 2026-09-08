import { describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ sourceChunk: { findMany: vi.fn(), findFirst: vi.fn() }, sourceExtraction: { findMany: vi.fn() } }));
vi.mock("./client.ts", () => ({ prisma: db }));
import { createSourceService } from "./sources.ts";

describe("source service", () => {
  it("uses lexical evidence during an embedding outage and scopes every candidate to the owner and version", async () => {
    const ref = { sourceId: "old", version: 2 };
    db.sourceChunk.findMany.mockResolvedValue([{ ...ref, ordinal: 90, locator: "Ending", content: "The access code is ORCHID-913", embedding: null, extraction: { source: { name: "Archive" } } }]);
    const service = createSourceService("user1", [ref], { embed: async () => { throw new Error("Embedding outage"); } });
    expect((await service.search("access code"))[0]!.content).toContain("ORCHID-913");
    expect(db.sourceChunk.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: [{ ...ref, extraction: { source: { userId: "user1" } } }] } }));
  });
  it("refuses a model-requested source or version outside the frozen scope before querying", async () => {
    db.sourceChunk.findFirst.mockClear();
    const service = createSourceService("user1", [{ sourceId: "s1", version: 1 }]);
    expect(await service.read("s2", 1, 0)).toBeNull();
    expect(await service.read("s1", 2, 0)).toBeNull();
    expect(db.sourceChunk.findFirst).not.toHaveBeenCalled();
  });
  it("returns no sources for an empty scope without an unscoped DB query", async () => {
    const service = createSourceService("user1", []);
    expect(await service.overview()).toEqual([]);
    expect(await service.search("secret")).toEqual([]);
  });
});
