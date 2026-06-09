export function normalizePlanMessages(messages: unknown): Array<{ role: string; content: string; at?: string }> {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") {
      return [];
    }
    const record = message as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) {
      return [];
    }
    const normalized = {
      role: typeof record.role === "string" ? record.role : "user",
      content
    };
    return typeof record.at === "string" ? [{ ...normalized, at: record.at }] : [normalized];
  });
}
