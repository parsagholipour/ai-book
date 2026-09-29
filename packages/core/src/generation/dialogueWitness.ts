/** Cheap evidence triage, not a verdict that speech is natural or sufficient.
 * The reviewer still judges meaning; narration alone cannot witness dialogue. */
export function requestsDialogue(quote: string): boolean {
  return /\b(?:dialogue|speech|spoken (?:words|lines|dialogue))\b/iu.test(quote) &&
    !/\b(?:no|without|avoid|omit|exclude)\s+(?:(?:any|all|natural|spoken|direct|stilted|forced|unnatural|unnecessary|excessive)\s+)*(?:dialogue|speech|spoken)\b|\b(?:dialogue|speech)[ -]free\b/iu.test(quote);
}

type Span = { start: number; end: number };
const speechVerb = /\b(?:said|says|asked|asks|replied|replies|answered|answers|whispered|whispers|shouted|shouts|cried|cries|yelled|yells|called out|read aloud|sang|sings)\b/iu;
const nonSpeech = /\b(?:thought|thinks|wondered|wonders|imagined|imagines|remembered|remembers|sign|label|notice|inscription|lettering|written|printed|named|titled)\b/iu;

export function dialogueCandidateSpans(markdown: string): Span[] {
  const candidates: Span[] = [];
  const quotations = /“([^“”]+)”|"([^"\n]+)"|«([^«»]+)»|「([^「」]+)」|『([^『』]+)』|(?<![\p{L}\p{N}])‘([^‘’]+)’|(?<![\p{L}\p{N}])'([^'\n]+)'/gu;
  for (const match of markdown.matchAll(quotations)) {
    const start = match.index, end = start + match[0].length;
    // Only the immediately attached clause can identify a thought or inscription.
    // A thought elsewhere in the paragraph must not suppress a later spoken line.
    const before = markdown.slice(0, start).split(/[.!?\n“”"«»「」『』]/u).at(-1) ?? "";
    const after = markdown.slice(end).split(/[.!?\n“”"«»「」『』]/u)[0] ?? "";
    const attached = `${before} ${after}`;
    if (!nonSpeech.test(attached) || speechVerb.test(attached)) candidates.push({ start: start + 1, end: end - 1 });
  }
  // Dialogue can be unquoted. These are candidates only, still judged in context.
  for (const match of markdown.matchAll(/(?:^|\n)[ \t]*[—–][ \t]*([^\n]+)/gu)) {
    const speech = match[1]!;
    candidates.push({ start: match.index + match[0].lastIndexOf(speech), end: match.index + match[0].length });
  }
  for (const match of markdown.matchAll(/(?:^|\n)[ \t]*(\p{Lu}[\p{L}\p{M} .'-]{0,50}):[ \t]+([^\n]+)/gu)) {
    if (/^(?:sign|label|notice|warning|title|chapter|note|narrator|narration)$/iu.test(match[1]!.trim())) continue;
    candidates.push({ start: match.index + match[0].lastIndexOf(match[2]!), end: match.index + match[0].length });
  }
  for (const match of markdown.matchAll(/\b(?:said|says|asked|asks|replied|answered|whispered|shouted|cried|called out|read aloud)[,:][ \t]+([^\n]+)/giu)) {
    const utterance = match[1]!;
    // Quoted speech already has exact boundaries above. Do not let the
    // attribution swallow narration following the closing quotation mark.
    if (/^[“"«「『‘']/u.test(utterance)) continue;
    const firstSentence = [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(utterance)][0]?.segment ?? utterance;
    const start = match.index + match[0].lastIndexOf(utterance);
    candidates.push({ start, end: start + firstSentence.trimEnd().length });
  }
  return candidates.filter(span => /[\p{L}\p{N}]/u.test(markdown.slice(span.start, span.end)));
}

export function dialogueWitnessConcern(markdown: string, evidence: string): string | undefined {
  const candidates = dialogueCandidateSpans(markdown);
  for (let start = markdown.indexOf(evidence); evidence.length && start >= 0; start = markdown.indexOf(evidence, start + 1)) {
    if (candidates.some(span => /[\p{L}\p{N}]/u.test(markdown.slice(Math.max(start, span.start), Math.min(start + evidence.length, span.end)))))
      return undefined;
  }
  return "Dialogue evidence must include actual spoken words in their page context; this witness does not overlap a recognizable spoken-text candidate. Recheck the whole page and select a spoken-text witness, or return a grounded missing_requirement finding. If speech cannot be established, leave the check unresolved.";
}

export const DIALOGUE_WITNESS_GUIDANCE = "For a dialogue obligation, the selected evidence must contain words actually spoken in the scene, not narration about moving, looking, speaking or following. Read the full page to identify the speaker and intended listener; one speaker can suffice. Quoted thoughts, signs, labels and titles are not speech unless the scene explicitly makes them spoken. Dialogue may use quotation marks, dialogue dashes, speaker labels or an attributed unquoted utterance. On changed pages, compare the original dialogue with the candidate: losing required speech is a regression even when the continuity target is resolved. A source match establishes coordinates, never semantic fulfillment.";
