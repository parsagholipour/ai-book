import { prisma } from "@book-maker/db";
import type { ProductEventName } from "./productEventNames.js";

/**
 * The two writes behind the operator's growth funnel (`admin/productFunnel.ts`).
 * Neither is part of what a request does for the reader, so neither may fail
 * one: both are best-effort and log rather than throw.
 */

type Logger = { warn: (object: unknown, message: string) => void };

/** The UTC calendar day `at` falls on, as the `@db.Date` column stores it. */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Marks today as a day this reader used the app. Called where a session starts
 * or refreshes — an access token lives fifteen minutes, so a refresh is what an
 * app open after a pause looks like from here — and written once per day by
 * the primary key, whatever the number of refreshes.
 */
export function noteUserActiveDay(userId: string, log: Logger, at: Date = new Date()): void {
  // Deferred into the promise so even a synchronous throw lands in the catch:
  // nothing here may fail the sign-in it rides on.
  void Promise.resolve()
    .then(() => prisma.userActiveDay.createMany({ data: [{ userId, day: utcDay(at) }], skipDuplicates: true }))
    .catch((error: unknown) => log.warn({ err: error, userId }, "Could not record the reader's active day"));
}

export async function recordProductEvent(
  options: { userId: string; name: ProductEventName; properties?: Record<string, string> },
  log: Logger
): Promise<void> {
  try {
    await prisma.productEvent.create({
      data: {
        userId: options.userId,
        name: options.name,
        ...(options.properties ? { properties: options.properties } : {})
      }
    });
  } catch (error) {
    log.warn({ err: error, name: options.name }, "Could not record a product event");
  }
}
