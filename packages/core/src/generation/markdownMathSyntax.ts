/** The TeX delimiters shared by export rendering and deletion-only cut validation. */
export function mathAt(text: string, at: number): { tex: string; display: boolean; end: number } | undefined {
  const opening = text.startsWith("\\[", at) ? "\\[" : text.startsWith("\\(", at) ? "\\("
    : text.startsWith("$$", at) ? "$$" : text[at] === "$" ? "$" : undefined;
  if (!opening) return undefined;
  const closing = opening === "\\[" ? "\\]" : opening === "\\(" ? "\\)" : opening;
  const display = opening === "\\[" || opening === "$$";
  const start = at + opening.length;
  if (opening === "$" && /\s|\$/.test(text[start] ?? " ")) return undefined;
  // A bounded scan also makes an unmatched dollar in a long book cheap.
  for (let cursor = start; cursor < Math.min(text.length, start + 16_000); cursor += 1) {
    if (!display && /[\n`]/.test(text[cursor]!)) return undefined;
    if (text.startsWith(closing, cursor)) {
      if (opening === "$" && (/\s/.test(text[cursor - 1]!) || /[\p{L}\p{N}]/u.test(text[cursor + 1] ?? ""))) return undefined;
      const tex = text.slice(start, cursor).trim();
      return tex ? { tex, display, end: cursor + closing.length } : undefined;
    }
    if (text[cursor] === "\\") cursor += 1;
  }
  return undefined;
}
