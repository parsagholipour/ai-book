/** Omit the SDK retry key unless the caller set it — never pass `undefined`. */
export function optionalMaxRetries(maxRetries: number | undefined): { maxRetries?: number } {
  return maxRetries !== undefined ? { maxRetries } : {};
}
