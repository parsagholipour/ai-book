-- A chat title change: the book retitled in one API transaction, and its AI
-- cover redrawn when it has one. Recorded only for the priced kind, whose row
-- claims the proposal against a concurrent Cancel. Kept to the ALTER TYPE alone:
-- Postgres refuses to *use* an enum value in the same transaction that added it.
ALTER TYPE "BookEditOperationKind" ADD VALUE IF NOT EXISTS 'BOOK_TITLE';
