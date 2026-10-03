import { beforeEach, expect, it, vi } from "vitest";
const transaction = vi.hoisted(() => vi.fn());
vi.mock("./client.ts", () => ({ prisma: { $transaction: transaction },
  Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } } }));
import { runSerializable } from "./billingInternals.ts";

beforeEach(() => { transaction.mockReset(); });

it("retries a pg-adapter serialization failure at COMMIT", async () => {
  const conflict = new Error("TransactionWriteConflict", { cause: { kind: "TransactionWriteConflict" } });
  conflict.name = "DriverAdapterError";
  transaction.mockRejectedValueOnce(conflict).mockResolvedValueOnce("committed");
  expect(await runSerializable(async () => "committed")).toBe("committed");
  expect(transaction).toHaveBeenCalledTimes(2);
});

it("does not retry arbitrary errors or retry conflicts forever", async () => {
  transaction.mockRejectedValue(new Error("connection lost"));
  await expect(runSerializable(async () => undefined)).rejects.toThrow("connection lost");
  expect(transaction).toHaveBeenCalledTimes(1);
  transaction.mockReset().mockRejectedValue({ code: "P2034" });
  await expect(runSerializable(async () => undefined)).rejects.toMatchObject({ code: "P2034" });
  expect(transaction).toHaveBeenCalledTimes(5);
});
