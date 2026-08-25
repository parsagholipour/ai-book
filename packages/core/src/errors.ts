/** Extracts a message from an unknown thrown value without stringifying it. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
