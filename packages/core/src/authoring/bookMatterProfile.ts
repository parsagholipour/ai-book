import { BOOK_MATTER_LIMITS, cleanMatterText } from "../schemas/bookMatter.js";
import type { BookMatterChatAnswer, BookMatterChatField } from "./bookMatterChatEdit.js";
import { fold } from "./bookMatterWords.js";

/**
 * The reader's saved author profile, as the chat's matter composer is shown it:
 * what a new book would copy from Account → Author profile
 * (`authorDefaultsForNewBook` in the API), keyed by the matter field each value
 * prints in. Only the fields that hold something are present.
 *
 * A book copies the profile once, when it is created, so a book made before the
 * profile was filled in has none of it — and "use my profile", "add my author
 * info" or "whatever I added in my profile" was answered with a question asking
 * the reader to type it all out again (2026-10-17, "The Last Table"). The values
 * are the reader's own words, so they ground a change like the reader's message
 * does; *which* of them may change the book is the profile door in
 * `bookMatterAskedFor.ts`, read off {@link namesAuthorProfile} and
 * {@link copiesAuthorProfile}.
 */
export type BookMatterChatProfile = {
  authorName?: string;
  aboutAuthor?: string;
  authorWebsite?: string;
  copyrightHolder?: string;
  imprint?: string;
  allRightsReserved?: true;
};

/** The profile's printed values, the text a change may be grounded in. */
export function authorProfileTexts(profile: BookMatterChatProfile | undefined): string[] {
  return Object.values(profile ?? {}).filter((value): value is string => typeof value === "string");
}

const W = String.raw`(?<![\p{L}\p{N}])`;

/**
 * Words that point at the saved profile rather than at a field: "profile" in
 * the app's languages, and in English the reader's "author info" or "my
 * details". Read on folded text (`fold`: NFKC, Arabic-script letters unified,
 * lower case). Unspaced scripts are matched inside the run, as their words are.
 */
const PROFILE_CUE = new RegExp(
  [
    String.raw`${W}(?:profiles?|profil\p{L}*|profilo|perfil\p{L}*|профил\p{L}*|профіл\p{L}*|προφίλ|פרופיל\p{L}*)`,
    String.raw`${W}(?:my|author|author['’]s|the\s+author['’]s|saved)\s+(?:own\s+|saved\s+)?(?:author\s+)?(?:info|information|details|data|bio\s+info)(?![\p{L}\p{N}])`,
    String.raw`پروفایل|پروفائل|نمایه|الملف\s+الشخصي|ملفي\s+الشخصي|प्रोफ़ाइल|प्रोफाइल|hồ\s+sơ`,
    String.raw`个人资料|個人資料|我的资料|我的資料|作者资料|作者資料|プロフィール|프로필|โปรไฟล์`
  ].join("|"),
  "u"
);

/** Whether the reader's words point at their saved profile. */
export function namesAuthorProfile(words: string | undefined): boolean {
  return typeof words === "string" && PROFILE_CUE.test(fold(words));
}

type Change = BookMatterChatAnswer["changes"][number];

/**
 * Whether a change prints exactly what the profile holds for its field — a set,
 * never a removal, so pointing at a profile with no bio takes no bio off the
 * book. The dedication and the ISBN are never in a profile.
 */
export function copiesAuthorProfile(change: Change, profile: BookMatterChatProfile | undefined): boolean {
  if (!profile || change.action !== "set") return false;
  if (change.field === "allRightsReserved") return profile.allRightsReserved === true;
  const field: BookMatterChatField = change.field;
  if (field === "dedication" || field === "isbn") return false;
  const saved = profile[field];
  const singleLine = field !== "aboutAuthor";
  const same = (text: unknown) => cleanMatterText(text, BOOK_MATTER_LIMITS[field] * 4, { singleLine });
  return saved !== undefined && same(change.text) !== undefined && same(change.text) === same(saved);
}
