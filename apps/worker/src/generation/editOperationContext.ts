/** Prefix used by the API's pre-separation character-sheet composition. */
export const LEGACY_CHARACTER_CONTEXT_PREFIX =
  "Mentioned character profiles (the user's own library characters; treat as authoritative canon):";

type EditContextSource = {
  request?: string | null | undefined;
  editInstruction?: string | null | undefined;
  characterContext?: string | null | undefined;
};

export type ResolvedEditPromptContext = {
  editInstruction: string;
  requestContext: string;
  characterContext?: string | undefined;
};

/**
 * Resolves the reader-approved instruction independently from prompt-only
 * character canon. Durable operation fields win over queued copies. The split
 * recognizes rows written before `characterContext` existed, when the API
 * appended a stable, labelled profile block to both strings.
 */
export function resolveEditPromptContext(
  operation: EditContextSource,
  payload: EditContextSource
): ResolvedEditPromptContext {
  const durableInstruction = splitLegacyCharacterContext(operation.editInstruction);
  const queuedInstruction = splitLegacyCharacterContext(payload.editInstruction);
  const durableRequest = splitLegacyCharacterContext(operation.request);
  const queuedRequest = splitLegacyCharacterContext(payload.request);

  const characterContext =
    trimmed(operation.characterContext) ??
    trimmed(payload.characterContext) ??
    durableInstruction.characterContext ??
    queuedInstruction.characterContext ??
    durableRequest.characterContext ??
    queuedRequest.characterContext;

  const editInstruction = stripAppendedCharacterContext(
    durableInstruction.text || queuedInstruction.text || durableRequest.text || queuedRequest.text,
    characterContext
  );
  if (!editInstruction) {
    throw new Error("Book edit has no approved instruction");
  }
  // The queued request is the delivery's supplemental conversation context;
  // unlike editInstruction it is not an approval contract. Durable request is
  // its recovery fallback when a reconstructed payload omits it.
  const requestContext =
    stripAppendedCharacterContext(queuedRequest.text, characterContext) ||
    stripAppendedCharacterContext(durableRequest.text, characterContext) ||
    editInstruction;

  return {
    editInstruction,
    requestContext,
    ...(characterContext ? { characterContext } : {})
  };
}

/**
 * Planner-facing user message for a plan rewrite. The stored edit contract is
 * `editInstruction` alone; sheets stay a labelled supplemental section so they
 * cannot become the next plan version's recorded request.
 */
export function authoritativeReplanMessage(
  editInstruction: string,
  request: string,
  characterContext?: string | undefined
): string {
  return [
    "Approved editInstruction (authoritative; apply it fully without softening, substitution, or omission):",
    editInstruction,
    ...(request !== editInstruction ? ["Original request context (supplemental only):", request] : []),
    ...(characterContext
      ? ["Character context (supplemental canon, not an additional edit requirement):", characterContext]
      : [])
  ].join("\n\n");
}

export function splitLegacyCharacterContext(value: string | null | undefined): {
  text: string;
  characterContext?: string | undefined;
} {
  const normalized = value?.trim() ?? "";
  const marker = `\n\n${LEGACY_CHARACTER_CONTEXT_PREFIX}`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return { text: normalized };
  const text = normalized.slice(0, markerIndex).trim();
  const characterContext = normalized.slice(markerIndex + 2).trim();
  return { text, ...(characterContext ? { characterContext } : {}) };
}

function stripAppendedCharacterContext(value: string, characterContext?: string): string {
  const normalized = value.trim();
  const context = characterContext?.trim();
  if (context) {
    const suffix = `\n\n${context}`;
    if (normalized.endsWith(suffix)) {
      return normalized.slice(0, -suffix.length).trim();
    }
  }
  return splitLegacyCharacterContext(normalized).text;
}

function trimmed(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
