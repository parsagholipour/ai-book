-- Book matter: the author profile new books copy, and each book's own copy of
-- its dedication, publication details and biography.
ALTER TABLE "Project" ADD COLUMN "bookMatter" JSONB;

CREATE TABLE "AuthorProfile" (
    "userId" TEXT NOT NULL,
    "penName" TEXT,
    "bio" TEXT,
    "website" TEXT,
    "copyrightHolder" TEXT,
    "imprint" TEXT,
    "allRightsReserved" BOOLEAN NOT NULL DEFAULT false,
    "includeAboutAuthor" BOOLEAN NOT NULL DEFAULT true,
    "setupPromptSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthorProfile_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "AuthorProfile" ADD CONSTRAINT "AuthorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
