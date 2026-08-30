import { templateDefinitions } from "@book-maker/core";
import { prisma } from "./client.ts";

/**
 * The light `libraryMentions.ts` and `pageIllustrationOwnership.ts` modules are
 * **not** re-exported here. They are reached through their package subpaths,
 * because suites mock this entry point wholesale and those shared rules should
 * continue to load as their real implementations. See CLAUDE.md.
 */

export { prisma, PrismaClient, Prisma } from "./client.ts";
export * from "./planRevisionRetry.ts";
export * from "./creditPricing.ts";
export * from "./embeddingScopes.ts";
export * from "./pageOrdering.ts";
export * from "./pageRestructureRevert.ts";
export * from "./pageRestructureCompensation.ts";
export * from "./researchLinks.ts";
export * from "./storyState.ts";
/**
 * Semantic retrieval, split by arm. Re-exported **by name** rather than with
 * `export *`: each module hands a helper or two to a sibling — the query
 * builders in `retrievalQuery.ts` (the scope filter, the row cap and the top-K
 * both arms are built from), `cleanLexicalTerms` and the already-cleaned
 * `retrieveCleanedLexicalEmbeddings` it feeds — and those are seams inside the
 * split, not surface this package offers. `RetrievalCandidate` is the one thing
 * in that module which is: it is what both arms return, so a caller holding a
 * retrieval's rows has to be able to name it.
 */
export { degradeRetrievalArm, type DegradeRetrievalArmOptions } from "./retrievalArms.ts";
export { type RetrievalCandidate } from "./retrievalQuery.ts";
export {
  retrieveSimilarEmbeddings,
  type RetrieveSimilarEmbeddingsOptions
} from "./embeddingRetrieval.ts";
export {
  foldLexicalText,
  LEXICAL_SIMILARITY_FLOOR,
  retrieveLexicalContinuityNotes,
  retrieveLexicalEmbeddings,
  type LexicalContinuityNote,
  type RetrieveLexicalContinuityNotesOptions,
  type RetrieveLexicalEmbeddingsOptions
} from "./lexicalRetrieval.ts";
export {
  fuseHybridEmbeddingRanks,
  retrieveHybridEmbeddings,
  type HybridEmbedding,
  type RetrieveHybridEmbeddingsOptions
} from "./hybridRetrieval.ts";
export {
  embeddingIsDegraded,
  findPageEmbeddingRepairTargets,
  type PageEmbeddingRepairTarget
} from "./embeddingRepairTargets.ts";
export * from "./generated/prisma/enums.ts";
export type * from "./generated/prisma/models.ts";

export async function ensureSeedTemplates() {
  for (const template of templateDefinitions) {
    await prisma.template.upsert({
      where: { slug: template.slug },
      create: {
        slug: template.slug,
        name: template.name,
        category: template.category,
        description: template.description,
        defaultConfig: template.defaultConfig,
        styleRules: template.styleRules
      },
      update: {
        name: template.name,
        category: template.category,
        description: template.description,
        defaultConfig: template.defaultConfig,
        styleRules: template.styleRules
      }
    });
  }
}
