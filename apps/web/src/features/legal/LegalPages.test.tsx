import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION, LEGAL_EFFECTIVE_DATE } from "@book-maker/core/legal";
import { AccountDeletionPage, formatLegalDate, PrivacyPage, TermsPage } from "./LegalPages.js";

describe("legal pages", () => {
  it("discloses the default Balanced planning credit charge", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <TermsPage />
      </MemoryRouter>
    );

    expect(markup).toContain("Building a book plan uses credits");
    expect(markup).toContain("Balanced planning uses 40 credits");
  });

  it("says a finished book downloads with no further charge, and only the Word file needs a plan", () => {
    // The per-book export unlock was removed on 2026-10-15: the book's one
    // charge is taken when its plan is approved.
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <TermsPage />
      </MemoryRouter>
    );

    expect(markup).toContain("downloading the finished book as a PDF or EPUB uses no further credits");
    expect(markup).toContain("Word (.docx) download");
    expect(markup).not.toMatch(/export unlock|unlock the (?:PDF|EPUB|download)/i);
  });

  it("names the Google SDKs the app uses and says the voice relay keeps no audio", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>
    );

    expect(markup).toContain("Firebase Crashlytics");
    expect(markup).toContain("Firebase Cloud Messaging");
    expect(markup).toContain("Google Sign-In");
    expect(markup).toContain("voice relay server");
    expect(markup).toContain("does not store it");
    // Live-call audio goes through Tomeza's relay (relay-v1), never straight from the app to Google.
    expect(markup).not.toContain("directly to Google");
  });

  it("discloses install attribution: the Play referrer's campaign fields and share link, and no advertising ID", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>
    );

    // apps/mobile/lib/features/attribution/ reads the Play install referrer once and posts
    // `install_attributed` (source, medium, campaign, share slug — productEventBody.ts) after sign-in;
    // ProductEvent rows are pruned at 400 days (tablePruneSweep.ts) and deleted with the account.
    expect(markup).toContain("How you found the app");
    expect(markup).toContain("install referrer");
    expect(markup).toContain("campaign source, medium, and campaign name");
    expect(markup).toContain("Tomeza share link");
    expect(markup).toContain("start a book like the one that was shared with you");
    expect(markup).toContain("does not read your device&#x27;s advertising ID");
    expect(markup).toContain("Install attribution details are kept for about 400 days.");
    // Still the undeployed 2026-10-13 version; this is not a new revision.
    expect(markup).toContain("Version 2026-10-13");
  });

  it("covers photos of other people and children, where they go, and how long deleted copies last", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>
    );

    expect(markup).toContain("Photos of people, including children");
    expect(markup).toContain("of another person who has agreed");
    expect(markup).toContain("parent or legal guardian");
    // The character-photo vision read is Gemini (GeminiCharacterPhotoVisionAdapter).
    expect(markup).toContain("currently Google Gemini");
    expect(markup).toContain("until you delete that picture, the character, or your account");
    // S3 keeps a deleted or replaced object as a noncurrent version for 30 days. Daily EBS snapshots live
    // 14 days, but every deploy's database dump lives 30 (+1 to expire), so the database bound is a month.
    expect(markup).toContain("about 30 days");
    expect(markup).toContain("deleted records can remain in a backup for up to about a month");
    expect(markup).not.toContain("two weeks");
    expect(markup).not.toContain("14 days");
  });

  it("gives the deletion page the same backup bounds as the policy", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AccountDeletionPage />
      </MemoryRouter>
    );

    expect(markup).toContain("database backups for up to about a month");
    expect(markup).not.toContain("two weeks");
  });

  it("walks the in-app deletion path the app actually labels", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AccountDeletionPage />
      </MemoryRouter>
    );

    // apps/mobile/lib/features/account/presentation/account_screen.dart and account_privacy_screen.dart.
    expect(markup).toContain("Under <strong>Privacy &amp; help</strong>, tap <strong>Privacy &amp; data</strong>.");
    expect(markup).toContain(
      "In the <strong>Delete account</strong> section, tap <strong>Request account deletion</strong>."
    );
    expect(markup).toContain("tap <strong>Send request</strong>");
    expect(markup).not.toContain("Privacy and support");
    // ACCOUNT_DELETION_GRACE_MS in apps/api/src/accountDeletion.ts.
    expect(markup).toContain("deleted a day after you send the request");
  });

  it("says an account deletion cancels the Google Play subscription, on every page that mentions it", () => {
    // The deletion executor cancels the subscription through the Play API (play-billing lane);
    // only uninstalling the app leaves it running.
    const pages = [TermsPage, PrivacyPage, AccountDeletionPage].map((Page) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <Page />
        </MemoryRouter>
      )
    );
    const [terms, privacy, deletion] = pages;

    expect(terms).toContain("we also cancel that account&#x27;s Google Play subscription");
    expect(privacy).toContain("Deleting your account also cancels your Google Play subscription");
    expect(deletion).toContain("Deleting your account also cancels your Google Play subscription");
    for (const markup of pages) {
      expect(markup).toContain("Payments &amp; subscriptions › Subscriptions");
      expect(markup).not.toMatch(/does not (itself )?cancel a (Google Play )?subscription\. Cancel/);
      expect(markup).not.toContain("request does not cancel");
      expect(markup).not.toContain("account deletion does not itself cancel");
      expect(markup).not.toContain("It does not cancel a Google Play subscription");
    }
  });

  it("prints the acceptance version the API records, not a copy of it", () => {
    const terms = renderToStaticMarkup(
      <MemoryRouter>
        <TermsPage />
      </MemoryRouter>
    );
    const privacy = renderToStaticMarkup(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>
    );

    expect(terms).toContain(`Version ${CURRENT_TERMS_VERSION}`);
    expect(privacy).toContain(`Version ${CURRENT_PRIVACY_VERSION}`);
    expect(privacy).toContain(`Effective ${formatLegalDate(LEGAL_EFFECTIVE_DATE)}`);
  });

  it("formats the effective date without consulting the clock's time zone", () => {
    expect(formatLegalDate("2026-10-13")).toBe("13 October 2026");
    expect(formatLegalDate("2027-01-01")).toBe("1 January 2027");
    expect(() => formatLegalDate("2026-13-01")).toThrow(/YYYY-MM-DD/);
    expect(() => formatLegalDate("13 October 2026")).toThrow(/YYYY-MM-DD/);
  });
});
