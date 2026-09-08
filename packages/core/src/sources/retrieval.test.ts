import { describe, expect, it } from "vitest";
import { rankSourcePassages } from "./retrieval.js";
import { createSourceTools } from "./tools.js";
import { sourceCitation, type SourcePassage, type SourceService } from "./types.js";

const passage: SourcePassage = { sourceId: "older", version: 2, ordinal: 44, name: "First file", locator: "Ending", content: "The observatory closed in 2047. Its code was ORCHID-913." };
describe("private source evidence", () => {
  it("keeps conflicting claims attached to their separate files", () => {
    const newer = { ...passage, sourceId: "newer", content: "The observatory closed in 2058. Its code was PINE-882." };
    const result = rankSourcePassages([passage, newer], "When did the observatory close?");
    expect(result.map((row) => row.sourceId)).toEqual(["older", "newer"]);
    expect(result[0]!.content).toContain("2047");
    expect(result[1]!.content).toContain("2058");
  });
  it("fuses semantic matches with lexical evidence and supports Arabic/Persian keyboard variants", () => {
    const semantic = { ...passage, sourceId: "semantic", content: "دسترسی به بایگانی", embedding: [1, 0] };
    const lexical = { ...passage, content: "علی کد را ثبت کرد", embedding: [0, 1] };
    const result = rankSourcePassages([semantic, lexical], "علي كد", [1, 0]);
    expect(result).toHaveLength(2);
    expect(rankSourcePassages([lexical], "علي كد")).toHaveLength(1);
    expect(rankSourcePassages([lexical], "no matching fact")).toEqual([]);
  });
  it("accepts only citations to passages returned in this turn, never overview-only or invented references", async () => {
    const service: SourceService = { overview: async () => [], search: async () => [passage], read: async () => passage };
    const ledger = createSourceTools(service);
    expect(ledger.validate(sourceCitation(passage))).toBe("[unverified source]");
    await ledger.tools[0]!.execute({ query: "code" });
    expect(ledger.validate(`${sourceCitation(passage)} [source:foreign:1:0]`)).toBe(`${sourceCitation(passage)} [unverified source]`);
    expect(createSourceTools(service).validate(sourceCitation(passage))).toBe("[unverified source]");
  });
});
