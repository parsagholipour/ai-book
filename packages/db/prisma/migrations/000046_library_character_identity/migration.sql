-- Two halves of one problem: a book could name the reader's saved character but
-- never carry their identity.
--
-- `appearance` is what the character LOOKS like, in words. `description` is who
-- they are, written by the user, and routinely says nothing about the look —
-- the look lived only in the portrait's pixels, which the planner (a text model)
-- never sees. So the planner invented one, and the invented look won at render
-- time because a scene prompt outranks the reference images attached beside it.
ALTER TABLE "LibraryCharacter" ADD COLUMN "appearance" TEXT;

-- `libraryCharacterId` is the link the cast sheet never had. VoiceCharacter rows
-- are built one-for-one from plan.characters, so a saved character reached the
-- list as a same-named twin with a planner-written description and a re-drawn
-- face. No relation and no FK: a book outlives the library row it was made from,
-- exactly as the plan snapshot does.
ALTER TABLE "VoiceCharacter" ADD COLUMN "libraryCharacterId" TEXT;

CREATE INDEX "VoiceCharacter_libraryCharacterId_idx" ON "VoiceCharacter"("libraryCharacterId");

-- No backfill for either column. Both are absences rather than wrong values:
-- an existing cast row genuinely has no recorded provenance, and re-deriving one
-- here by name would re-run the fuzzy match this migration exists to stop
-- relying on — against a library that has changed since the book was built.
