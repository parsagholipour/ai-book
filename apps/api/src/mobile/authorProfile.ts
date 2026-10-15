import { BOOK_MATTER_LIMITS, cleanMatterText, type BookMatter } from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { z } from "zod";

/**
 * Who the reader is as an author (`AuthorProfile`): the pen name, biography and
 * publication details every new book takes a copy of.
 *
 * Nothing about it is asked in the creation route. It is filled in Account →
 * Author profile, or once from the "put your name on it" card the app shows
 * while the first book is being written (`setupPromptSeen` remembers that the
 * card was answered, on the account rather than the device). A book copies the
 * profile when it is created and is its own after that, so editing the profile
 * never reprints a published book (`.scratch/book-matter/spec.md`).
 *
 * The account's display name is offered back as `suggestedPenName` and nothing
 * more: books are shared publicly (`/s/`), and a real name printed on one is
 * the reader's choice to make.
 */

export const AUTHOR_PROFILE_LIMITS = {
  penName: BOOK_MATTER_LIMITS.authorName,
  bio: BOOK_MATTER_LIMITS.aboutAuthor,
  website: BOOK_MATTER_LIMITS.authorWebsite,
  copyrightHolder: BOOK_MATTER_LIMITS.copyrightHolder,
  imprint: BOOK_MATTER_LIMITS.imprint
} as const;

/**
 * A text field as the matter pages print it: trimmed per line, blank runs
 * collapsed, and refused — never clipped — past its ceiling. `""` clears it.
 */
export function matterTextField(limit: number, options: { singleLine?: boolean } = {}) {
  return z
    .string()
    .max(limit * 4)
    .transform((value) => cleanMatterText(value, Number.MAX_SAFE_INTEGER, options) ?? null)
    .pipe(z.string().max(limit).nullable())
    .nullable()
    .optional();
}

export const authorProfileBodySchema = z
  .object({
    penName: matterTextField(AUTHOR_PROFILE_LIMITS.penName, { singleLine: true }),
    bio: matterTextField(AUTHOR_PROFILE_LIMITS.bio),
    website: matterTextField(AUTHOR_PROFILE_LIMITS.website, { singleLine: true }),
    copyrightHolder: matterTextField(AUTHOR_PROFILE_LIMITS.copyrightHolder, { singleLine: true }),
    imprint: matterTextField(AUTHOR_PROFILE_LIMITS.imprint, { singleLine: true }),
    allRightsReserved: z.boolean().optional(),
    includeAboutAuthor: z.boolean().optional(),
    setupPromptSeen: z.boolean().optional()
  })
  .strict();
export type AuthorProfileBody = z.infer<typeof authorProfileBodySchema>;

const nullableText = (maxLength: number) => ({ type: ["string", "null"], maxLength: maxLength * 4 });
export const authorProfileOpenApiBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    penName: nullableText(AUTHOR_PROFILE_LIMITS.penName),
    bio: nullableText(AUTHOR_PROFILE_LIMITS.bio),
    website: nullableText(AUTHOR_PROFILE_LIMITS.website),
    copyrightHolder: nullableText(AUTHOR_PROFILE_LIMITS.copyrightHolder),
    imprint: nullableText(AUTHOR_PROFILE_LIMITS.imprint),
    allRightsReserved: { type: "boolean" },
    includeAboutAuthor: { type: "boolean" },
    setupPromptSeen: { type: "boolean" }
  }
} as const;

export type AuthorProfileDto = {
  penName: string | null;
  bio: string | null;
  website: string | null;
  copyrightHolder: string | null;
  imprint: string | null;
  allRightsReserved: boolean;
  includeAboutAuthor: boolean;
  setupPromptSeen: boolean;
  suggestedPenName: string | null;
};

const nullableString = { type: ["string", "null"] } as const;
export const authorProfileResponseSchema = {
  type: "object",
  properties: {
    profile: {
      type: "object",
      properties: {
        penName: nullableString,
        bio: nullableString,
        website: nullableString,
        copyrightHolder: nullableString,
        imprint: nullableString,
        allRightsReserved: { type: "boolean" },
        includeAboutAuthor: { type: "boolean" },
        setupPromptSeen: { type: "boolean" },
        suggestedPenName: nullableString
      },
      required: [
        "penName",
        "bio",
        "website",
        "copyrightHolder",
        "imprint",
        "allRightsReserved",
        "includeAboutAuthor",
        "setupPromptSeen",
        "suggestedPenName"
      ]
    }
  },
  required: ["profile"]
} as const;

type AuthorProfileRow = Prisma.AuthorProfileGetPayload<object>;

export function serializeAuthorProfile(row: AuthorProfileRow | null, displayName: string | null): AuthorProfileDto {
  return {
    penName: row?.penName ?? null,
    bio: row?.bio ?? null,
    website: row?.website ?? null,
    copyrightHolder: row?.copyrightHolder ?? null,
    imprint: row?.imprint ?? null,
    allRightsReserved: row?.allRightsReserved ?? false,
    includeAboutAuthor: row?.includeAboutAuthor ?? true,
    setupPromptSeen: row?.setupPromptSeenAt != null,
    suggestedPenName: displayName?.trim() || null
  };
}

/** `displayName` is the signed-in account's, which the auth check already read. */
export async function readAuthorProfile(userId: string, displayName: string | null): Promise<AuthorProfileDto> {
  return serializeAuthorProfile(await prisma.authorProfile.findUnique({ where: { userId } }), displayName);
}

/**
 * Writes what the body carries and nothing else; an absent key keeps its
 * value, `null` clears it. Answering the setup card is sticky: once seen, a
 * later `setupPromptSeen: false` does not bring the card back.
 */
export async function writeAuthorProfile(
  userId: string,
  displayName: string | null,
  body: AuthorProfileBody
): Promise<AuthorProfileDto> {
  const fields = {
    ...(body.penName !== undefined ? { penName: body.penName } : {}),
    ...(body.bio !== undefined ? { bio: body.bio } : {}),
    ...(body.website !== undefined ? { website: body.website } : {}),
    ...(body.copyrightHolder !== undefined ? { copyrightHolder: body.copyrightHolder } : {}),
    ...(body.imprint !== undefined ? { imprint: body.imprint } : {}),
    ...(body.allRightsReserved !== undefined ? { allRightsReserved: body.allRightsReserved } : {}),
    ...(body.includeAboutAuthor !== undefined ? { includeAboutAuthor: body.includeAboutAuthor } : {})
  };
  const seen = body.setupPromptSeen === true ? { setupPromptSeenAt: new Date() } : {};
  await prisma.$transaction(async (tx) => {
    const existing = await tx.authorProfile.findUnique({ where: { userId }, select: { setupPromptSeenAt: true } });
    const markSeen = existing?.setupPromptSeenAt ? {} : seen;
    await tx.authorProfile.upsert({
      where: { userId },
      create: { userId, ...fields, ...seen },
      update: { ...fields, ...markSeen }
    });
  });
  return readAuthorProfile(userId, displayName);
}

/**
 * What a new book copies from its owner's profile: the pen name (unless the
 * creation already named an author) and the matter. Empty for an account with
 * no profile, so a book created before anyone filled one in compiles exactly
 * as it would have.
 */
export async function authorDefaultsForNewBook(
  userId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<{ authorName?: string; bookMatter?: BookMatter }> {
  const profile = await db.authorProfile.findUnique({ where: { userId } });
  if (!profile) return {};
  const bookMatter: BookMatter = {
    ...(profile.includeAboutAuthor && profile.bio ? { aboutAuthor: profile.bio } : {}),
    ...(profile.website ? { authorWebsite: profile.website } : {}),
    ...(profile.copyrightHolder ? { copyrightHolder: profile.copyrightHolder } : {}),
    ...(profile.imprint ? { imprint: profile.imprint } : {}),
    ...(profile.allRightsReserved ? { allRightsReserved: true } : {})
  };
  return {
    ...(profile.penName ? { authorName: profile.penName } : {}),
    ...(Object.keys(bookMatter).length > 0 ? { bookMatter } : {})
  };
}
