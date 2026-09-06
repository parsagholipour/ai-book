root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
def patch(path, pairs):
    s=open(root+path).read()
    for old,new in pairs:
        assert old in s, (path, old[:70]); s=s.replace(old,new,1)
    open(root+path,'w').write(s)

# judge spend attributed beside the compose calls
patch('packages/core/src/generation/pipelineStages.ts', [
('''    summary: "One continuous piece of prose per chapter from the stance, the form plan, the previous chapter's tail and digests of earlier chapters.",
    purposes: ["compose-chapter"],
    lane: "prose",
    calls: "1 per chapter, 2 when the first answer is far too short",''',
 '''    summary: "Two continuous drafts per chapter from the stance, the form plan, the previous chapter's tail and digests of earlier chapters; a fast cross-family judge reads the opening and closing of each and picks one, or the first when the two orders disagree.",
    purposes: ["compose-chapter", "judge-chapter-drafts"],
    lane: "prose",
    calls: "2 drafts and 2 judge calls per chapter, more when a draft is far too short",'''),
])
patch('apps/api/src/admin/qualityGateCosts.ts', [
('''    id: "composed.compose-chapter",
    label: "Compose chapters (composed chapters)",
    purposes: new Set(["compose-chapter"]),''',
 '''    id: "composed.compose-chapter",
    label: "Compose chapters (composed chapters)",
    purposes: new Set(["compose-chapter", "judge-chapter-drafts"]),'''),
])

# plan-time research asks about the book, not the app's planning instruction
patch('packages/core/src/generation/planner.ts', [
('''  const queries = [...new Set([input.prompt, ...fallbackQueries])].slice(0, 3);
  const results = await Promise.allSettled(queries.map((query) => adapter.search({ query, purpose: "plan-research" })));''',
 '''  const queries = [...new Set([researchSubjectForPrompt(input.prompt), ...fallbackQueries.map(researchSubjectForPrompt)])].slice(0, 3);
  const results = await Promise.allSettled(queries.map((query) => adapter.search({ query, purpose: "plan-research" })));'''),
('''async function researchForPlan(''',
 '''/**
 * What a search engine should be asked about. A chat-created book's prompt is
 * the app's planning instruction followed by the transcript, so the query used
 * to be "Create the best-fitting book from the user's creation chat…" and every
 * source came back about lead magnets; the reader's own first turn, or the
 * "Original idea" line, is the subject.
 */
export function researchSubjectForPrompt(prompt: string): string {
  const idea = /^Original idea:\\s*(.+)$/m.exec(prompt)?.[1]?.trim();
  if (idea) {
    return idea.slice(0, 300);
  }
  const firstUserTurn = /(?:^|\\n)\\s*User:\\s*(.+)/.exec(prompt)?.[1]?.trim();
  if (firstUserTurn) {
    return firstUserTurn.slice(0, 300);
  }
  return prompt.trim().slice(0, 300);
}

async function researchForPlan('''),
])
print("post-run patch applied")
