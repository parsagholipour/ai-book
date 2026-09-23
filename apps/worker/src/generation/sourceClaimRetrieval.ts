import {
  chapterEpisodeSchema, type BookDossier, type DossierExcerpt, type PrimarySourceFetch, type SourceClaim, type SourceClaimReview
} from "@book-maker/core";
import { fetchSourceDocument } from "./sourceDocumentFetch.js";
import { mergeSourceDossiers, retrieveChapterSources } from "./sourceDossier.js";

const MAX_SEARCH_ROUNDS = 2;
const GROUPS_PER_ROUND = 3;
const RETRIEVAL_BUDGET_MS = 120_000;
export function sourceClaimSearchKey(claim: Pick<SourceClaim, "sourceGroup" | "searchQuery">): string {
  return (claim.sourceGroup?.trim() || claim.searchQuery).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Grouping only plans retrieval. Neither a label nor a lexical hit can establish support. */
export function claimSearchGroups(claims: readonly SourceClaim[], attempted: ReadonlySet<string>) {
  const groups = new Map<string, SourceClaim[]>();
  for (const claim of claims) {
    if (claim.status !== "insufficient_evidence" || !claim.searchQuery.trim()) continue;
    const key = sourceClaimSearchKey(claim);
    if (attempted.has(key)) continue;
    groups.set(key, [...groups.get(key) ?? [], claim]);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, GROUPS_PER_ROUND).map(([key, members]) => {
    const queries = [...new Set(members.map((claim) => claim.searchQuery.trim()))].slice(0, 3);
    return { key, members, query: queries.join("; ").slice(0, 1200) };
  });
}

/** Reuse successful fetches within a bounded recovery cache; failures remain retryable. */
export function cachedClaimSourceFetch(fetch: PrimarySourceFetch): PrimarySourceFetch {
  const cache = new Map<string, Awaited<ReturnType<PrimarySourceFetch>>>();
  return async (url) => {
    const saved = cache.get(url);
    if (saved) return saved;
    const result = await fetch(url);
    if (result.status === 200) {
      if (cache.size >= 24) cache.delete(cache.keys().next().value!);
      cache.set(url, result);
    }
    return result;
  };
}

type RetrievalOptions = Omit<Parameters<typeof retrieveChapterSources>[0], "episodes" | "deadline" | "maxRounds">;
export async function recoverSourceClaimEvidence(options: RetrievalOptions & {
  initial: SourceClaimReview;
  excerpts: DossierExcerpt[];
  review: (excerpts: DossierExcerpt[]) => Promise<SourceClaimReview>;
  persistSources: (supplement: BookDossier) => Promise<void>;
  trace: (event: string, detail: Record<string, unknown>) => Promise<void>;
}) {
  let review = options.initial;
  let excerpts = options.excerpts;
  let supplement: BookDossier | undefined;
  const attempted = new Set<string>();
  const searchedClaims = new Set<string>();
  const deadline = Date.now() + RETRIEVAL_BUDGET_MS;
  const fetch = cachedClaimSourceFetch(options.fetch ?? fetchSourceDocument);
  if (!options.searchSources) return { review, excerpts, supplement, attempted, searchedClaims };
  for (let round = 0; round < MAX_SEARCH_ROUNDS && Date.now() < deadline; round += 1) {
    const groups = claimSearchGroups(review.claims, attempted);
    if (!groups.length) break;
    const found = await retrieveChapterSources({ ...options, evidence: true, deadline, maxRounds: 1,
      maxDocumentsPerEpisode: 2, fetch,
      searchSources: async (query) => {
        const group = groups.find((entry) => entry.query === query);
        if (group) attempted.add(group.key);
        const found = await options.searchSources!(query);
        if (group) for (const claim of group.members) searchedClaims.add(claim.quote);
        return found;
      },
      episodes: groups.map((group) => chapterEpisodeSchema.parse({
        title: group.members[0]!.quote, kind: "document",
        why: group.members.map((claim) => claim.quote).join("\n"), searchQueries: [group.query]
      }))
    });
    const merged = mergeSourceDossiers({ documents: [], excerpts }, found);
    const added = merged.excerpts.length - excerpts.length;
    const before = review.coverage;
    if (added > 0) {
      supplement = mergeSourceDossiers(supplement ?? { documents: [], excerpts: [] }, found);
      await options.persistSources(found);
      excerpts = merged.excerpts;
      review = await options.review(excerpts);
    }
    await options.trace("claim_retrieval_round", { round: round + 1, groups: groups.length, attemptedGroups: attempted.size,
      addedPassages: added, before, after: review.coverage });
    // A retrieval implementation that did not start a query (deadline/cancellation) cannot
    // authorize deletion, and repeating those same groups would just spend the budget again.
    if (!groups.some((group) => attempted.has(group.key))) break;
  }
  await options.trace("claim_retrieval_finished", { attemptedGroups: attempted.size, searchedClaims: searchedClaims.size,
    unsearchedGroupsRemain: claimSearchGroups(review.claims, attempted).length > 0,
    deadlineReached: Date.now() >= deadline, coverage: review.coverage });
  return { review, excerpts, supplement, attempted, searchedClaims };
}
