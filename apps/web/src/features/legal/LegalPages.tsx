import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  LEGAL_COMPANY_ADDRESS,
  LEGAL_COMPANY_NAME,
  LEGAL_EFFECTIVE_DATE,
  LEGAL_SUPPORT_EMAIL,
  PUBLIC_ACCOUNT_DELETION_URL,
  PUBLIC_PRIVACY_POLICY_URL,
  PUBLIC_TERMS_OF_SERVICE_URL
} from "@book-maker/core/legal";
import { AppLogo } from "../shared/AppLogo.js";

const company = LEGAL_COMPANY_NAME;
const address = LEGAL_COMPANY_ADDRESS;
const supportEmail = LEGAL_SUPPORT_EMAIL;

/**
 * What each public legal page is called, where it lives and which acceptance
 * version it is. The SPA renders these through the routes in `App.tsx`, and the
 * web build writes each one to `<path>/index.html` as static HTML
 * (`legalPrerender.tsx`), so the policy text is readable without JavaScript.
 */
export type LegalDocument = {
  path: "/terms" | "/privacy" | "/account-deletion";
  title: string;
  description: string;
  version: string;
  canonicalUrl: string;
};

export const TERMS_DOCUMENT: LegalDocument = {
  path: "/terms",
  title: "Terms and Conditions",
  description: "The terms governing use of Tomeza.",
  version: CURRENT_TERMS_VERSION,
  canonicalUrl: PUBLIC_TERMS_OF_SERVICE_URL
};

export const PRIVACY_DOCUMENT: LegalDocument = {
  path: "/privacy",
  title: "Privacy Policy",
  description: "How Tomeza collects, uses, shares, retains, and protects data.",
  version: CURRENT_PRIVACY_VERSION,
  canonicalUrl: PUBLIC_PRIVACY_POLICY_URL
};

/** Part of the privacy disclosures, so it carries the privacy version. */
export const ACCOUNT_DELETION_DOCUMENT: LegalDocument = {
  path: "/account-deletion",
  title: "Delete your Tomeza account",
  description: "How to request deletion of your account and data.",
  version: CURRENT_PRIVACY_VERSION,
  canonicalUrl: PUBLIC_ACCOUNT_DELETION_URL
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
] as const;

/**
 * `2026-10-13` → `13 October 2026`, by string arithmetic rather than `Date`, so
 * the build machine's time zone and locale cannot move the printed day.
 */
export function formatLegalDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = match ? MONTH_NAMES[Number(match[2]) - 1] : undefined;
  if (!match || !month) {
    throw new Error(`Legal dates are YYYY-MM-DD; got ${JSON.stringify(isoDate)}.`);
  }
  return `${Number(match[3])} ${month} ${match[1]}`;
}

export function TermsPage() {
  return (
    <LegalPage document={TERMS_DOCUMENT}>
      <LegalIntro>
        These Terms and Conditions (the <q>Terms</q>) are a binding agreement between you and {company} (
        <q>Ravanix</q>, <q>we</q>, <q>us</q>, or <q>our</q>) governing your access to and use of Tomeza, including its
        mobile application, website, AI-assisted book creation, voice, storage, editing, and export features (the
        <q>Service</q>).
      </LegalIntro>

      <Section title="1. Acceptance and eligibility">
        <p>
          By creating an account, accepting these Terms, or using the Service, you agree to these Terms and
          acknowledge our <Link to="/privacy">Privacy Policy</Link>. You must be at least 13 years old. If you are
          below the age of majority where you live, you represent that a parent or legal guardian has reviewed and
          accepted these Terms for you and authorized your use.
        </p>
        <p>Do not use the Service if you cannot lawfully enter this agreement or do not accept these Terms.</p>
      </Section>

      <Section title="2. Accounts and security">
        <p>
          You must provide accurate account information, keep your password and devices secure, and promptly tell us
          about suspected unauthorized access. You are responsible for activity through your account except to the
          extent caused by our breach of law or these Terms. Accounts may not be sold, shared commercially, or used
          to impersonate another person.
        </p>
      </Section>

      <Section title="3. Credits, purchases, and subscriptions">
        <p>
          Some operations use credits. Building a book plan uses credits at the then-current rate for the effort
          setting you choose. At the default rates, Balanced planning uses 40 credits; other effort settings use a
          different amount. Writing the book after you approve the plan is a separate, single charge, and
          downloading the finished book as a PDF or EPUB uses no further credits. Some features, such as the Word
          (.docx) download, voice calls, and audiobooks, are available only with a paid plan. Current amounts are
          shown in Account and in Effort settings. The app shows the applicable credit amount before you approve
          writing, apply an edit, or start another paid operation.
        </p>
        <p>
          Credits are a limited contractual right to use eligible Service features; they are not money, transferable
          property, or redeemable for cash. Purchased credits do not expire while the Service operates, unless law
          requires otherwise. Plan allowances reset at the stated period and do not accumulate. If we discontinue the
          Service, all credits end on the date it ends, as section 10 explains.
        </p>
        <p>
          Welcome credits are an optional, one-time promotional gift. Availability and amounts may vary by signup
          region and offer, subject to applicable law. Eligibility checks help prevent repeated claims. The amount
          actually granted appears in your credit history and does not expire. Changes to future offers do not
          remove credits already granted. Contact <EmailLink /> if your region or eligibility was determined incorrectly.
        </p>
        <p>
          Android purchases and subscriptions are processed by Google Play and are also subject to Google&apos;s terms.
          Subscriptions renew unless cancelled through Google Play before renewal. Uninstalling Tomeza does not cancel
          a subscription. When we carry out an account deletion, we also cancel that account&apos;s Google Play
          subscription so it does not renew; you can check or cancel it yourself in Google Play under{" "}
          <strong>Payments &amp; subscriptions › Subscriptions</strong>. Prices, taxes, currency conversion, trials, and
          billing timing may be controlled by Google Play.
        </p>
        <p>
          Refund requests are handled under applicable law and Google Play&apos;s refund process. Except where mandatory
          law requires otherwise, consumed credits and completed digital services are not refundable. Failed priced
          operations are refunded in credits when the product indicates that policy applies.
        </p>
      </Section>

      <Section title="4. The AI service and its limitations">
        <p>
          The Service uses artificial intelligence. Outputs may be inaccurate, incomplete, biased, offensive,
          non-unique, similar to third-party material, or unavailable for copyright protection. You must review and
          fact-check outputs before relying on, publishing, or distributing them. We do not promise that an output is
          original, accurate, suitable, lawful, or free of third-party rights.
        </p>
        <p>
          The Service does not provide legal, medical, financial, safety, or other professional advice. Obtain advice
          from a qualified professional for decisions where errors could cause harm.
        </p>
      </Section>

      <Section title="5. Your content and ownership">
        <p>
          You retain ownership of content you submit, including prompts, notes, manuscripts, documents, images, and
          recordings (<q>Inputs</q>). As between you and Ravanix, you own generated outputs to the extent ownership is
          legally available. These Terms do not transfer to you any rights in third-party material that may appear in
          an output, and laws in some places may not recognize ownership of AI-generated material.
        </p>
        <p>
          You grant Ravanix, its affiliates, and service providers a limited, worldwide, non-exclusive license to
          host, reproduce, transmit, transform, and process your Inputs and outputs only as reasonably necessary to
          operate, secure, maintain, support, improve Service reliability, enforce these Terms, and comply with law.
          This license ends when the content is deleted except for limited retained copies and records described in
          the Privacy Policy or required by law.
        </p>
      </Section>

      <Section title="6. Your rights, permissions, and copyright responsibility">
        <p>
          You represent and warrant that you have all rights, licenses, permissions, releases, and lawful bases
          required for your Inputs, instructions, requested transformations, generated outputs, publication,
          distribution, and commercial use. This includes copyright, trademark, publicity, privacy, confidentiality,
          data-protection, and contractual rights.
        </p>
        <p>
          Upload a photo of a person only if it is you, or the person has agreed to its use in the Service. For a
          child, that agreement must come from the child&apos;s parent or legal guardian. The Privacy Policy explains
          how photos are used, shared with AI providers, and deleted.
        </p>
        <p>
          Ravanix does not verify ownership, clear rights, guarantee non-infringement, or determine whether material
          is in the public domain or properly licensed. You—not Ravanix—are responsible for deciding whether you may
          copy, translate, continue, imitate, adapt, publish, distribute, sell, or otherwise use content. An
          administrator may enable automated copyright-request restrictions, but those restrictions are limited,
          may not identify every issue, and do not transfer your responsibility to Ravanix.
        </p>
      </Section>

      <Section title="7. Acceptable use">
        <p>You must not use the Service to create, upload, share, or request content that:</p>
        <ul>
          <li>violates law or another person&apos;s rights;</li>
          <li>sexually exploits or endangers minors in any way, or is sexually explicit or pornographic;</li>
          <li>promotes hatred or violence against people based on a protected characteristic, or harasses, bullies,
            or threatens anyone;</li>
          <li>depicts graphic violence for its own sake, or encourages self-harm, suicide, or eating disorders;</li>
          <li>facilitates severe real-world violence, terrorism, or dangerous illegal activity;</li>
          <li>impersonates a real person or organization in a way intended to deceive, or creates deceptive official
            records intended to pass as genuine;</li>
          <li>misrepresents AI output as verified professional advice or factual evidence.</li>
        </ul>
        <p>
          You must also not upload malware, bypass access controls, probe systems without authorization, disrupt the
          Service, or resell, scrape, reverse engineer, or automate access except as we expressly permit.
        </p>
        <p>
          <strong>Public sharing.</strong> When you share a book through a public link, anyone with the link can read
          it, and you are responsible for what it contains and for having the rights to share it. Shared books must
          follow these rules. Readers can report a shared book, and we may remove a share, disable sharing for an
          account, or take the other actions in section 8 without notice. You can stop sharing at any time.
        </p>
        <p>
          You can report AI-generated content you find offensive or harmful — a book, a picture, a chat reply, or a
          voice call — from inside the app. We review reports and act on content that breaks these rules.
        </p>
      </Section>

      <Section title="8. Moderation and intellectual-property notices">
        <p>
          We may review reports and formal notices, restrict content or accounts, preserve evidence, or take other
          legally necessary action. We do not undertake a general duty to monitor user content. Reports do not
          automatically establish wrongdoing or require automatic deletion. Send a sufficiently detailed
          intellectual-property notice to <EmailLink /> with your identity, the protected work, the challenged
          material and location, your contact details, and a good-faith statement that the use is unauthorized.
        </p>
      </Section>

      <Section title="9. Indemnity">
        <p>
          To the fullest extent permitted by mandatory law, you will indemnify and hold harmless Ravanix, its
          affiliates, officers, employees, contractors, and service providers from third-party claims, losses,
          damages, liabilities, and reasonable legal costs arising from your Inputs, instructions, publication or
          distribution of outputs, breach of these Terms, or violation of third-party rights. This obligation does
          not apply to the extent a claim was caused by Ravanix&apos;s own unlawful conduct and cannot legally be shifted
          to you.
        </p>
      </Section>

      <Section title="10. Service availability, changes, and discontinuation">
        <p>
          We may add, change, suspend, or discontinue features, models, providers, credit pricing, limits, or the
          Service. We will give notice where required by law. AI and infrastructure providers may be unavailable,
          and generation timing and results vary. You should export important work rather than rely on the Service as
          your only copy.
        </p>
        <h3>If we discontinue the Service</h3>
        <p>
          If we decide to shut down the Service permanently, we will give at least 60 days&apos; notice by email to
          the address on your account and in the app or on our website. The notice will state the date the Service
          ends (the <q>end date</q>). From the notice, we will stop selling credits and new subscriptions and will
          cancel subscription renewals through Google Play, so no renewal charges you for time after the end date.
          Until the end date, you can keep using your credits and download your books as usual.
        </p>
        <p>
          Credits left unused on the end date, whether purchased, granted with a plan, or given as a welcome or
          promotional gift, expire on that date. They have no cash value and are not refunded or exchanged, and
          subscription fees already paid are not refunded for time after the end date, except where mandatory law
          requires otherwise. It is your responsibility to use your credits and download your books before the end
          date. Once we have given that notice, Ravanix is not liable for unused credits, or for content or access
          you lose, when the Service ends.
        </p>
        <p>
          We may give shorter notice only where 60 days is not reasonably possible: for example, where continuing
          would be unlawful, a court or regulator requires us to stop, a provider the Service depends on stops
          serving us, or a serious security threat or other event beyond our reasonable control occurs. We will then
          give as much notice as we reasonably can, and the rest of this section still applies. After the end date,
          you will no longer be able to sign in or download your books, and we will delete accounts and content
          except the limited records described in section 6 of the <Link to="/privacy">Privacy Policy</Link>.
        </p>
      </Section>

      <Section title="11. Suspension and termination">
        <p>
          You may stop using the Service and request account deletion at any time. We may restrict or terminate access
          where reasonably necessary for security, non-payment, legal compliance, material or repeated breach, or
          protection of users and third parties. Where appropriate and legally required, we will provide notice and
          an opportunity to address the issue. Provisions that by nature should survive termination do survive,
          including ownership, payment, indemnity, disclaimers, liability limits, and dispute terms.
        </p>
      </Section>

      <Section title="12. Disclaimers">
        <p>
          TO THE FULLEST EXTENT PERMITTED BY LAW, THE SERVICE IS PROVIDED <q>AS IS</q> AND <q>AS AVAILABLE</q>. RAVANIX
          DISCLAIMS IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT,
          ACCURACY, QUIET ENJOYMENT, AND UNINTERRUPTED OR ERROR-FREE OPERATION. MANDATORY CONSUMER WARRANTIES REMAIN
          UNAFFECTED.
        </p>
      </Section>

      <Section title="13. Limitation of liability">
        <p>
          TO THE FULLEST EXTENT PERMITTED BY LAW, RAVANIX AND ITS AFFILIATES AND SERVICE PROVIDERS WILL NOT BE LIABLE
          FOR INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE, OR CONSEQUENTIAL LOSS, OR LOSS OF PROFITS, REVENUE,
          DATA, GOODWILL, OR BUSINESS OPPORTUNITY. OUR AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO THE SERVICE
          WILL NOT EXCEED THE FEES YOU PAID TO RAVANIX FOR THE SERVICE DURING THE 12 MONTHS BEFORE THE EVENT GIVING
          RISE TO THE CLAIM.
        </p>
        <p>
          These exclusions and the cap do not apply to liabilities that cannot lawfully be excluded or limited,
          including liability for fraud, wilful misconduct, or other liability protected by mandatory law.
        </p>
      </Section>

      <Section title="14. Governing law and courts">
        <p>
          These Terms are governed by the laws of the United Arab Emirates as applicable in the Emirate of Dubai,
          without regard to conflict-of-law rules. Subject to any mandatory consumer forum rights, the courts of
          Dubai have exclusive jurisdiction over disputes arising from these Terms or the Service.
        </p>
      </Section>

      <Section title="15. General terms">
        <p>
          If a provision is unenforceable, it will be limited to the minimum extent necessary and the remainder stays
          effective. Our failure to enforce a provision is not a waiver. You may not assign this agreement without
          our consent; we may assign it as part of a reorganization, financing, merger, sale, or transfer of the
          Service. These Terms and incorporated policies are the entire agreement about the Service.
        </p>
      </Section>

      <Section title="16. Changes and contact">
        <p>
          We may update these Terms. A material update will have a new version and require acceptance before further
          content mutations. A non-material correction may update the displayed revision date without requiring new
          acceptance. Contact <EmailLink /> with questions or notices.
        </p>
        <CompanyBlock />
      </Section>
    </LegalPage>
  );
}

export function PrivacyPage() {
  return (
    <LegalPage document={PRIVACY_DOCUMENT}>
      <LegalIntro>
        This Privacy Policy explains how {company} (<q>Ravanix</q>, <q>we</q>, <q>us</q>, or <q>our</q>) processes
        personal data when you use Tomeza and related support services.
      </LegalIntro>

      <Section title="1. Data we collect">
        <h3>Account and device data</h3>
        <p>
          Email address, optional display name, password hash, internal identifiers, account status, session
          metadata, hashed IP information, approximate signup country, user-agent information, and security events. We do not store your raw
          account password.
        </p>
        <p>
          We estimate your signup country from your IP address to apply regional welcome-credit offers and prevent
          repeated claims. This lookup runs on our server without sending your IP address to a location provider.
          We retain the country code, not precise location coordinates. This product includes GeoLite2 data created
          by <a href="https://www.maxmind.com/">MaxMind</a>.
        </p>
        <p>
          If you sign in with Google, Google Sign-In confirms your identity to us. We check the sign-in token Google
          issues with Google and do not store it, and we keep your Google account identifier, your verified email
          address, and, for a new account, the name on your Google account. We do not receive your Google password
          and do not keep your Google profile photo. Your Tomeza session is managed by our own servers.
        </p>
        <h3>User content</h3>
        <p>
          Prompts, chats, source notes, uploaded documents and images, titles, plans, generated books and images,
          exports, revisions, annotations, embeddings, and related metadata.
        </p>
        <h3>Photos of people, including children</h3>
        <p>
          You can add a photo to a saved character so that books draw that character with a consistent look, and you
          can add pictures to books you write. Only upload a photo of yourself, or of another person who has agreed
          to it. For a photo of a child, you must be the child&apos;s parent or legal guardian or have their
          permission.
        </p>
        <p>
          When you add a photo to a character, we send it to an AI provider that reads images (currently Google
          Gemini) to suggest a written description of the character and to tell whether the picture is a photograph
          or a drawing. If you then ask us to draw the character, we send the photo to an AI image provider as the
          reference for that drawing. These providers are listed in section 4. We use the photo only to create and
          draw your character; we do not use it to identify anyone, and we do not create face templates or other
          biometric identifiers from it.
        </p>
        <p>
          A character&apos;s photo and the pictures drawn from it are kept with the character until you delete that
          picture, the character, or your account. Illustrations already drawn for a book stay with that book until
          you delete the book. Section 6 explains how long deleted files can remain in backups.
        </p>
        <h3>Voice and audio data</h3>
        <p>
          During a live character call, microphone audio is sent in real time from your device to Ravanix&apos;s
          voice relay server, which passes it to the AI voice provider (Google Gemini) and passes the character&apos;s
          spoken reply back to you. The relay forwards the audio as it arrives and does not store it. We retain the
          call&apos;s transcript text, which the app sends us so a character can remember earlier conversations, along
          with call duration, credit/billing records, and network or call telemetry. If your device offers a local
          call recording, it remains on your device unless you choose to share it. Generated conversations and
          audiobook audio are stored with the associated project.
        </p>
        <h3>Notifications</h3>
        <p>
          If you allow notifications, the app registers a device token from Firebase Cloud Messaging (a Google
          service) with our server, linked to your signed-in session. While a book is being written, we send that
          book&apos;s title, a short progress line, and how far along it is through Firebase Cloud Messaging, so your
          device can show its progress and tell you when it is ready or needs attention. Signing out stops these
          notifications, and deleting your account deletes the token.
        </p>
        <h3>How you found the app</h3>
        <p>
          When you install Tomeza from Google Play, the app asks Google Play once, on your device, for the install
          referrer: the campaign details carried by the Play Store link you followed. After you sign in, the app sends
          us only the campaign source, medium, and campaign name, and, if you came from a Tomeza share link, the
          identifier of that shared book&apos;s link. We record these with your account to attribute the install,
          which tells us which links bring people to Tomeza, and to offer you, once, to start a book like the one that
          was shared with you. The rest of the referrer stays on your device. The app does not read your
          device&apos;s advertising ID, and we do not share these details with advertisers. They are deleted after
          about 400 days, or sooner if you delete your account.
        </p>
        <h3>Crash reports</h3>
        <p>
          Release versions of the app send crash reports to Firebase Crashlytics (a Google service) when the app
          crashes or a feature stops working. A report contains the error and a technical trace of where it
          happened, your device model, operating-system and app version, basic device state such as free memory,
          the time, and a random installation identifier created by Firebase. We do not attach your name, email
          address, or account identifier to crash reports.
        </p>
        <h3>Billing, support, and service records</h3>
        <p>
          Google Play purchase and subscription status, entitlement and ledger records, hashed purchase-token
          information, reports, deletion requests, support correspondence, service logs, diagnostics, and abuse or
          security records. Ravanix does not receive full payment-card details from Google Play.
        </p>
      </Section>

      <Section title="2. Why we process data">
        <p>We process data to:</p>
        <ul>
          <li>create and secure accounts and deliver the Service;</li>
          <li>generate, edit, store, narrate, and export user projects;</li>
          <li>provide live voice and character-memory features;</li>
          <li>notify you about books being written, if you allow notifications;</li>
          <li>
            attribute app installs to the link that led to them, such as a shared book, and offer to start a book like
            one that was shared with you;
          </li>
          <li>verify purchases, manage credits, subscriptions, and entitlements;</li>
          <li>determine eligibility and amounts for regional welcome-credit offers;</li>
          <li>provide support and process reports and deletion requests;</li>
          <li>detect fraud, abuse, failures, and security threats;</li>
          <li>diagnose crashes and improve Service reliability and usability;</li>
          <li>enforce our Terms and comply with legal obligations; and</li>
          <li>establish, exercise, or defend legal claims.</li>
        </ul>
      </Section>

      <Section title="3. Legal grounds">
        <p>
          Depending on your location and the processing, we rely on performance of our contract with you, your
          consent, compliance with legal obligations, and legitimate interests such as securing, supporting, and
          improving the Service. Where consent is required, you may withdraw it, without affecting earlier lawful
          processing. Certain data is necessary to provide an account or requested feature.
        </p>
      </Section>

      <Section title="4. Service providers and sharing">
        <p>
          We share data only as reasonably needed with providers that help operate the Service, including hosting,
          database, storage, queue, security, support, and analytics infrastructure (including Amazon Web Services for
          hosting and storage, and an email delivery provider for account emails); Google Play for purchases; Google
          Firebase Crashlytics for crash reports and Firebase Cloud Messaging for book notifications; Google Sign-In
          if you choose to sign in with Google; and, depending on the feature and availability, Google (Gemini,
          including live voice calls, whose microphone audio our own relay server passes to Google without storing
          it, Google Search grounding, speech, and document reading),
          OpenAI, DeepSeek, DeepInfra, Alibaba Cloud, OpenRouter, and the Vercel AI Gateway for AI processing, and
          Cloudflare for relaying some voice-call connections. Research features send search terms (not your account
          details) to public catalogues such as the Internet Archive, Project Gutenberg, and Wikisource. Submitted
          content is processed under those providers&apos; applicable service terms and privacy arrangements.
        </p>
        <p>
          We may also disclose data when required by law, to protect rights and safety, during a corporate transaction
          subject to appropriate safeguards, or when you direct or consent to sharing. We do not sell personal data,
          use it for behavioral advertising, or train a proprietary Ravanix foundation model on private user content.
        </p>
      </Section>

      <Section title="5. International processing">
        <p>
          Ravanix is based in the UAE. Our providers may process data in other countries, including countries whose
          data-protection laws differ from yours. Where legally required, we use contractual commitments or other
          recognized safeguards for international transfers.
        </p>
      </Section>

      <Section title="6. Retention">
        <ul>
          <li>Uploaded source files are retained for up to 180 days.</li>
          <li>Projects and generated assets are kept until you delete the project or account.</li>
          <li>
            Character photos and character pictures are kept until you delete the picture, the character, or your
            account.
          </li>
          <li>Live-call transcripts and generated audio are kept with the associated project.</li>
          <li>Install attribution details are kept for about 400 days.</li>
          <li>
            Billing, fraud, security, moderation, support, dispute, and legal records are kept for as long as
            reasonably required for those purposes and applicable law.
          </li>
        </ul>
        <p>
          When you delete something, or when an account deletion is carried out, it is removed from the Service, but
          copies can remain in our backups for a limited time. Stored files you delete or replace, such as book
          files, exports, and pictures, remain as previous versions in our storage for about 30 days before they are
          permanently removed. Our database is backed up daily and whenever we update the Service, and those
          backups are kept for up to about a month, so deleted records can remain in a backup for up to about a
          month. We use backups only to recover from data loss or a security incident. De-identified or aggregated information that no longer identifies you may be retained.
        </p>
      </Section>

      <Section title="7. Account and project deletion">
        <p>
          You can delete projects in the app. You can request account deletion in the app (Account, then Privacy &amp;
          data) or by following the instructions on our <Link to="/account-deletion">Account Deletion page</Link>. A
          request made in the app is carried out a day after you make it. A request made by email is completed
          within 30 days after we verify it. Account deletion removes or de-identifies projects and user content,
          subject to narrow retention for legal, billing, fraud-prevention, security, and dispute purposes. Deleting
          your account also cancels your Google Play subscription so it does not renew; you can check or cancel it
          yourself in Google Play under <strong>Payments &amp; subscriptions › Subscriptions</strong>.
        </p>
      </Section>

      <Section title="8. Your choices and rights">
        <p>
          Subject to applicable law, you may request access to, correction of, or deletion of personal data; restrict
          or object to processing; withdraw consent where processing depends on consent; and complain to an
          appropriate regulator. UAE data-protection rights and additional rights in your country may apply. To make
          a request, email <EmailLink /> from your account email address. We may verify your identity and may decline
          or limit a request where law permits or requires it.
        </p>
      </Section>

      <Section title="9. Children">
        <p>
          Tomeza is not intended for anyone under 13, and we do not knowingly collect personal data from children
          under 13. A user below the applicable age of majority must have authorization from a parent or guardian. If
          you believe a child under 13 provided data, contact us so we can investigate and delete it where required.
        </p>
        <p>
          A parent or guardian may upload a photo of their own child to create a character. That photo is the
          account holder&apos;s content, is handled as described under <q>Photos of people, including children</q> in
          section 1, and can be deleted at any time.
        </p>
      </Section>

      <Section title="10. Security">
        <p>
          We use technical and organizational safeguards appropriate to the nature of the data, including hashed
          passwords and tokens, access controls, encrypted transport, scoped service access, logging, and security
          monitoring. No internet service is perfectly secure, so we cannot guarantee absolute security. Protect your
          password and tell us promptly about suspected account compromise.
        </p>
      </Section>

      <Section title="11. Updates and contact">
        <p>
          We may update this Policy to reflect changes in law, providers, or the Service. We will update the date and,
          where required, provide additional notice or request a new acknowledgment. Questions and rights requests
          can be sent to <EmailLink />.
        </p>
        <CompanyBlock />
      </Section>
    </LegalPage>
  );
}

export function AccountDeletionPage() {
  const deletionMail = `mailto:${supportEmail}?subject=${encodeURIComponent("Tomeza account deletion request")}`;
  return (
    <LegalPage document={ACCOUNT_DELETION_DOCUMENT}>
      <LegalIntro>
        You can request deletion in the Tomeza app or by email. There is no charge for submitting a request.
      </LegalIntro>

      <Section title="Delete from the app">
        <ol>
          <li>Open Tomeza and sign in.</li>
          <li>Open <strong>Account</strong>.</li>
          <li>Under <strong>Privacy &amp; help</strong>, tap <strong>Privacy &amp; data</strong>.</li>
          <li>In the <strong>Delete account</strong> section, tap <strong>Request account deletion</strong>.</li>
          <li>Review the explanation, optionally add a note, and tap <strong>Send request</strong>.</li>
        </ol>
        <p>
          Your account and everything in it are deleted a day after you send the request. Write to <EmailLink />{" "}
          before then if you change your mind.
        </p>
      </Section>

      <Section title="Request deletion by email">
        <p>
          Email us from the address used for your Tomeza account so we can verify the request. Use the subject
          <q>Tomeza account deletion request</q> and identify the account email if it differs from the sending address.
        </p>
        <p>
          <a className="legal-primary-link" href={deletionMail}>Email an account deletion request</a>
        </p>
      </Section>

      <Section title="What happens next">
        <p>
          A request made in the app is carried out a day after you send it. A request made by email is completed
          within 30 days after we verify it. We delete or de-identify the account&apos;s projects, generated books and
          images, exports, saved characters and their photos, live-call transcripts, generated audio, and other user
          content. Source uploads may already have expired under the 180-day retention limit.
        </p>
        <p>
          We may retain limited billing, transaction, fraud-prevention, security, moderation, support, dispute, and
          legal records for as long as reasonably required. Retained records are restricted to those purposes.
          Deleted files can remain as previous versions in our storage for about 30 days, and deleted records in our
          database backups for up to about a month, before they are permanently removed.
        </p>
      </Section>

      <Section title="Your Google Play subscription">
        <p>
          Deleting your account also cancels your Google Play subscription: when the deletion is carried out, we
          cancel the subscription with Google Play so it does not renew. You can check or cancel it yourself at any
          time in Google Play under <strong>Payments &amp; subscriptions › Subscriptions</strong>. Uninstalling the app
          does not cancel a subscription. You may want to export your work before requesting deletion.
        </p>
      </Section>

      <Section title="Need help?">
        <p>
          Contact <EmailLink />. For more information, read the <Link to="/privacy">Privacy Policy</Link> and
          {" "}<Link to="/terms">Terms and Conditions</Link>.
        </p>
        <CompanyBlock />
      </Section>
    </LegalPage>
  );
}

/** The browser-tab title, shared with the static build so both say the same thing. */
export function legalDocumentTitle(legalDocument: LegalDocument): string {
  return `${legalDocument.title} · Tomeza`;
}

function LegalPage(props: { document: LegalDocument; children: ReactNode }) {
  const { title, description, version, canonicalUrl } = props.document;
  useEffect(() => {
    document.title = legalDocumentTitle(props.document);
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    meta?.setAttribute("content", description);
    // Present only when the page was served from its static copy; keep it true
    // after the router moves to a sibling legal page.
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", canonicalUrl);
  }, [props.document, description, canonicalUrl]);

  return (
    <div className="legal-site">
      <header className="legal-header">
        <Link className="legal-brand" to="/" aria-label="Tomeza home">
          <AppLogo aria-hidden={true} />
          <span>Tomeza</span>
        </Link>
        <nav aria-label="Legal documents">
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/account-deletion">Account deletion</Link>
        </nav>
      </header>
      <main className="legal-document">
        <p className="legal-eyebrow">Tomeza legal</p>
        <h1>{title}</h1>
        <p className="legal-version">
          Effective {formatLegalDate(LEGAL_EFFECTIVE_DATE)} · Version {version}
        </p>
        {props.children}
      </main>
      <footer className="legal-footer">
        <span>© {new Date().getFullYear()} {company}</span>
        <span>{address}</span>
      </footer>
    </div>
  );
}

function LegalIntro(props: { children: ReactNode }) {
  return <p className="legal-intro">{props.children}</p>;
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

function EmailLink() {
  return <a href={`mailto:${supportEmail}`}>{supportEmail}</a>;
}

function CompanyBlock() {
  return (
    <address>
      <strong>{company}</strong>
      <br />
      {address}
      <br />
      <EmailLink />
    </address>
  );
}
