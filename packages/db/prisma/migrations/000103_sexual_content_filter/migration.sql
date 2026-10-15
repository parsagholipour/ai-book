-- The operator's switch for the sexual-content filter: the fixed rule every
-- text-generation prompt carries and the model screens on book requests, chat
-- edits and public shares. Default ON, and every existing revision reads ON:
-- the filter is off only when an operator writes a revision that says so.
ALTER TABLE "SafetySettingsRevision" ADD COLUMN "sexualContentFilterEnabled" BOOLEAN NOT NULL DEFAULT true;
