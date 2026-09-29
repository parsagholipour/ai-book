type Requirement = { requirementIndex: number; quote: string; scopeQuote: string };

/** Derive failure-only edges for explicit positive lists in the SAME each-page
 * clause. Containment alone is not entailment (alternatives, negations, conditions
 * and discussion of a property do not require that property). Unclear prose keeps
 * independent checks; no requirement is removed and success never propagates. */
export function pictureBookRequirementDependencies(requirements: readonly Requirement[]) {
  const trim = (text: string) => text.trim().replace(/[.!]$/u, "").trim();
  const unsafe = /\b(?:or|nor|either|neither|if|unless|except|instead|but|not|no|without|avoid|omit|exclude|before|after|when|until|only|optional|may|can)\b/iu;
  return new Map(requirements.flatMap(parent => {
    if (parent.quote !== parent.scopeQuote || unsafe.test(parent.quote)) return [];
    const intro = /^(?:Make (?:each|every) page (?:a|an) [\p{L}\p{N}\s-]+ with|(?:Each|Every) page (?:must |should )?(?:include|contain|have|feature|use|provide))\s+/iu.exec(parent.quote);
    if (!intro) return [];
    const split = (text: string) => text.split(/\s+with\s+|,\s*(?:and\s+)?|\s+and\s+/iu).map(trim);
    const parts = split(parent.quote);
    if (parts.length < 2) return [];
    parts.push(...split(parent.quote.slice(intro[0].length)));
    const children = requirements.filter(child => child.requirementIndex !== parent.requirementIndex &&
      child.scopeQuote === parent.scopeQuote && parts.includes(trim(child.quote)));
    return children.length ? [[parent.requirementIndex, children.map(child => child.requirementIndex)] as const] : [];
  }));
}
