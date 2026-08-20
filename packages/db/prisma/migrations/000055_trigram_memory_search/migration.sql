-- Lexical needle-in-haystack recall for long-book continuity. Vector search
-- alone misses the rare distinctive tokens a story turns on — a character
-- name, a named object, a place — because those barely move a whole-summary
-- embedding. pg_trgm's strict_word_similarity(needle, haystack) catches them:
-- a phrase present verbatim in a ~370-char page summary scores 1.0, where the
-- symmetric similarity() is Jaccard over both trigram sets and dilutes the
-- same match to ~0.04 — below any usable floor. Trigram matching is also
-- script-agnostic: no stemmer or per-language config, so Persian, Arabic and
-- CJK books get the same keyword recall as Latin ones — with one fold on top
-- of it, because the codepoints an Arabic and a Persian keyboard type for the
-- same letter are not the same trigrams: needle and column both go through
-- translate() before they are scored.
--
-- Both queries that call these functions live in
-- packages/db/src/lexicalRetrieval.ts: retrieveLexicalEmbeddings over
-- Embedding.text, and retrieveLexicalContinuityNotes over
-- ContinuityNote.body — the two columns the rest of this migration is about.
-- packages/db/src/hybridRetrieval.ts fuses the first of those with the cosine
-- arm in packages/db/src/embeddingRetrieval.ts, which is pgvector's and needs
-- nothing from here.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- An earlier draft of this feature also created trigram GIN indexes on
-- Embedding.text and ContinuityNote.body. gin_trgm_ops serves the % / <% / %>
-- (and <<% / %>>) operators, never a similarity(col, $q) > floor or
-- strict_word_similarity(needle, haystack) > floor function-call predicate —
-- which is how the shipped queries rank. GIN therefore cannot keep those
-- ranking functions from scanning, and would only tax every insert. They stay
-- dropped. Bounding the scan is a btree job: Embedding already has one over
-- (projectId, scope) — Embedding_projectId_scope_idx from init, which the
-- next migration replaces with the unique Embedding_projectId_scope_key over
-- the same two columns; ContinuityNote did not.
DROP INDEX IF EXISTS "Embedding_text_trgm_idx";
DROP INDEX IF EXISTS "ContinuityNote_body_trgm_idx";

-- Both readers of ContinuityNote filter by project. The recency read —
-- loadContinuityNotes in apps/worker/src/generation/generationContext.ts —
-- also orders by createdAt desc, so it walks this index backwards instead of
-- sorting; retrieveLexicalContinuityNotes has to score every candidate row,
-- so what it takes from the index is the project bound (createdAt is only its
-- tiebreak). The only index was pageId, so both scanned every project's
-- notes. This btree is the actual scan bound; GIN cannot serve the ranking
-- functions.
CREATE INDEX "ContinuityNote_projectId_createdAt_idx" ON "ContinuityNote"("projectId", "createdAt");
