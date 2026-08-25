import type { Prisma } from "@book-maker/db";
import { isStopRequestedError } from "../runtime/jobTypes.js";

type SavepointClient = Pick<Prisma.TransactionClient, "$executeRawUnsafe">;

const SAVEPOINT = `SAVEPOINT "best_effort_page_memory"`;
const ROLLBACK = `ROLLBACK TO SAVEPOINT "best_effort_page_memory"`;
const RELEASE = `RELEASE SAVEPOINT "best_effort_page_memory"`;

/**
 * Isolates one optional memory write without releasing the caller's transaction
 * locks. PostgreSQL keeps a transaction aborted after a caught statement error;
 * rolling back to the savepoint is what makes the manuscript transaction
 * committable again. Callbacks own their established degradation logging.
 */
export async function runBestEffortPageMemoryWrite<T>(
  client: SavepointClient,
  write: () => Promise<T>
): Promise<T | null> {
  await client.$executeRawUnsafe(SAVEPOINT);
  try {
    const result = await write();
    await client.$executeRawUnsafe(RELEASE);
    return result;
  } catch (error) {
    try {
      await client.$executeRawUnsafe(ROLLBACK);
      await client.$executeRawUnsafe(RELEASE);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "Failed to recover the manuscript transaction after an optional memory write"
      );
    }
    if (isStopRequestedError(error)) {
      throw error;
    }
    return null;
  }
}
