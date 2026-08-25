/**
 * Whether a `P2002` names LibraryMention's primary key rather than the
 * library's own `[userId, name]` unique constraint.
 */
export function namesMentionPrimaryKey(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const known = error as { code?: unknown; meta?: { modelName?: unknown; target?: unknown } | undefined };
  if (known.code !== "P2002") {
    return false;
  }
  if (known.meta?.modelName === "LibraryMention") {
    return true;
  }
  const target = known.meta?.target;
  const named = Array.isArray(target) ? target.join(",") : typeof target === "string" ? target : "";
  return /sourceCharacterId|targetKind|targetId|targetCharacterId|LibraryMention/.test(named);
}

/**
 * Flattens every place Prisma and `@prisma/adapter-pg` may carry a SQLSTATE,
 * constraint name, column, or table into one searchable string.
 *
 * Prisma models some violations and not others: a foreign key can arrive as a
 * `P2003` plus `meta.driverAdapterError.cause`, a CHECK often arrives as an
 * unknown-request error with only prose, and a raw driver failure may expose
 * just its original code/message. This union is the single record of that
 * adapter traversal and is also shared by character photo writes.
 */
export function constraintErrorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const known = error as {
    code?: unknown;
    message?: unknown;
    meta?:
      | {
          code?: unknown;
          modelName?: unknown;
          constraint?: unknown;
          field_name?: unknown;
          column_name?: unknown;
          driverAdapterError?:
            | { cause?: { originalCode?: unknown; originalMessage?: unknown; constraint?: { index?: unknown } } }
            | undefined;
        }
      | undefined;
  };
  const cause = known.meta?.driverAdapterError?.cause;
  return [
    known.code,
    known.meta?.code,
    known.meta?.modelName,
    known.meta?.constraint,
    known.meta?.field_name,
    known.meta?.column_name,
    cause?.originalCode,
    cause?.originalMessage,
    cause?.constraint?.index,
    known.message
  ]
    .map((value) => (typeof value === "string" ? value : ""))
    .join(" ");
}

/** Whether a LibraryMention CHECK or equivalent subtype-length rule refused a row. */
export function namesMentionCheckConstraint(error: unknown): boolean {
  const text = constraintErrorText(error);
  if (/LibraryMention_(target_arc|not_self)/.test(text)) {
    return true;
  }
  if (/\b23514\b/.test(text) && /LibraryMention/.test(text)) {
    return true;
  }
  // An over-long `otherType` reaches varchar's 22001/P2000 before the CHECK.
  return /\bP2000\b|\b22001\b/.test(text) && /otherType|LibraryMention/.test(text);
}

/**
 * Whether a LibraryMention foreign key refused a link to a character that was
 * deleted after `mentionedTargets` read it. Both FKs on this table point to
 * LibraryCharacter, so a 23503/P2003 naming the table has the same 404 meaning.
 * A bare FK code is intentionally insufficient: other tables have FKs too.
 */
export function namesMentionCharacterForeignKey(error: unknown): boolean {
  const text = constraintErrorText(error);
  if (/LibraryMention_[A-Za-z]+_fkey/.test(text)) {
    return true;
  }
  return /\bP2003\b|\b23503\b/.test(text) && /LibraryMention/.test(text);
}
