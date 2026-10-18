-- A creation chat may link the book it builds to one of the reader's finished
-- books, as a continuation of it or a new story inspired by it. The answer is
-- held on the draft beside `originShareId`, for the same reason: every chat
-- turn rebuilds the payload from scratch. Neither column is a foreign key —
-- Build copies what the new book needs into its own mediaSettings, so a
-- deleted earlier book is a link Build skips, never a broken draft.
ALTER TABLE "MobileCreationDraft" ADD COLUMN "seriesSourceProjectId" TEXT;
ALTER TABLE "MobileCreationDraft" ADD COLUMN "seriesMode" TEXT;
