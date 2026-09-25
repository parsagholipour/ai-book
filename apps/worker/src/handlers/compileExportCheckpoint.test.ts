import { expect, it, vi } from "vitest";
import { runExportCheckpoint, type ExportChecks } from "./compileExportCheckpoint.js";

it("reuses exact evidence across successors and invalidates a changed manuscript identity", async () => {
  const checks: ExportChecks = {};
  const compute = vi.fn(async () => ({ status: "reviewed" }));
  const options = { slot: "coverage" as const, fingerprint: "operation1:revision1:prose1", read: () => checks,
    mutate: async (change: (value: ExportChecks) => void) => { change(checks); }, compute,
    parse: (value: unknown) => typeof value === "object" && value !== null && "status" in value ? value : undefined,
    interrupted: () => ({ status: "unavailable" }), assertActive: async () => {} };
  await runExportCheckpoint(options); await runExportCheckpoint(options);
  expect(compute).toHaveBeenCalledOnce();
  await runExportCheckpoint({ ...options, fingerprint: "operation1:revision1:prose2" });
  expect(compute).toHaveBeenCalledTimes(2);
});

it("an interrupted or unavailable check never becomes an empty successful review or buys duplicate work", async () => {
  const checks: ExportChecks = {};
  const compute = vi.fn(async () => { throw new Error("delivery interrupted"); });
  const options = { slot: "inventory" as const, fingerprint: "brief1", read: () => checks,
    mutate: async (change: (value: ExportChecks) => void) => { change(checks); }, compute,
    parse: () => undefined, interrupted: () => ({ status: "unavailable" }), assertActive: async () => {} };
  await expect(runExportCheckpoint(options)).rejects.toThrow("delivery interrupted");
  expect(await runExportCheckpoint(options)).toEqual({ status: "unavailable" });
  expect(compute).toHaveBeenCalledOnce();
});

it("loss of lease or cancellation before settlement prevents saving a result", async () => {
  const checks: ExportChecks = {};
  const active = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("lease lost"));
  await expect(runExportCheckpoint({ slot: "coverage", fingerprint: "one", read: () => checks,
    mutate: async (change) => { change(checks); }, parse: () => undefined,
    compute: async () => ({ status: "reviewed" }), interrupted: () => ({ status: "unavailable" }), assertActive: active
  })).rejects.toThrow("lease lost");
  expect(checks.coverage).toEqual({ fingerprint: "one" });
});
