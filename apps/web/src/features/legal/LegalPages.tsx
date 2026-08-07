import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { AppLogo } from "../shared/AppLogo.js";

const company = "Ravanix Technologies L.L.C-FZ";
const address = "Meydan Grandstand, 6th floor, Meydan Road, Nad Al Sheba, Dubai, U.A.E.";
const supportEmail = "support@ravanix.app";
const effectiveDate = "8 August 2026";
const version = "2026-08-08";

export function TermsPage() {
  return (
    <LegalPage title="Terms and Conditions" description="The terms governing use of Tomeza.">
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
          Some operations use credits. The app shows the applicable credit amount before a paid operation. Credits
          are a limited contractual right to use eligible Service features; they are not money, transferable
          property, or redeemable for cash. Purchased credits do not expire unless law requires otherwise. Plan
          allowances reset at the stated period and do not accumulate.
        </p>
        <p>
          Android purchases and subscriptions are processed by Google Play and are also subject to Google&apos;s terms.
          Subscriptions renew unless cancelled through Google Play before renewal. Deleting Tomeza or requesting
          account deletion does not itself cancel a subscription. Prices, taxes, currency conversion, trials, and
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
          Ravanix does not verify ownership, clear rights, guarantee non-infringement, or determine whether material
          is in the public domain or properly licensed. You—not Ravanix—are responsible for deciding whether you may
          copy, translate, continue, imitate, adapt, publish, distribute, sell, or otherwise use content. An
          administrator may enable automated copyright-request restrictions, but those restrictions are limited,
          may not identify every issue, and do not transfer your responsibility to Ravanix.
        </p>
      </Section>

      <Section title="7. Acceptable use">
        <p>You must not use the Service to:</p>
        <ul>
          <li>violate law or another person&apos;s rights;</li>
          <li>create deceptive official records intended to pass as genuine;</li>
          <li>sexually exploit minors or facilitate severe real-world violence or terrorism;</li>
          <li>upload malware, bypass access controls, probe systems without authorization, or disrupt the Service;</li>
          <li>misrepresent AI output as verified professional advice or factual evidence; or</li>
          <li>resell, scrape, reverse engineer, or automate access except as we expressly permit.</li>
        </ul>
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

      <Section title="10. Service availability and changes">
        <p>
          We may add, change, suspend, or discontinue features, models, providers, credit pricing, limits, or the
          Service. We will give notice where required by law. AI and infrastructure providers may be unavailable,
          and generation timing and results vary. You should export important work rather than rely on the Service as
          your only copy.
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
    <LegalPage title="Privacy Policy" description="How Tomeza collects, uses, shares, retains, and protects data.">
      <LegalIntro>
        This Privacy Policy explains how {company} (<q>Ravanix</q>, <q>we</q>, <q>us</q>, or <q>our</q>) processes
        personal data when you use Tomeza and related support services.
      </LegalIntro>

      <Section title="1. Data we collect">
        <h3>Account and device data</h3>
        <p>
          Email address, optional display name, password hash, internal identifiers, account status, session
          metadata, hashed IP information, user-agent information, and security events. We do not store your raw
          account password.
        </p>
        <h3>User content</h3>
        <p>
          Prompts, chats, source notes, uploaded documents and images, titles, plans, generated books and images,
          exports, revisions, annotations, embeddings, and related metadata.
        </p>
        <h3>Voice and audio data</h3>
        <p>
          During a live character call, microphone audio is sent in real time from your device to the selected AI
          voice provider. Ravanix&apos;s server does not retain the live-call audio. We may retain transcript text you
          send, call duration, credit/billing records, and network or call telemetry. If your device offers a local
          call recording, it remains on your device unless you choose to share it. Generated conversations and
          audiobook audio are stored with the associated project.
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
          <li>verify purchases, manage credits, subscriptions, and entitlements;</li>
          <li>provide support and process reports and deletion requests;</li>
          <li>detect fraud, abuse, failures, and security threats;</li>
          <li>diagnose and improve Service reliability and usability;</li>
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
          database, storage, queue, security, support, and analytics infrastructure; Google Play for purchases; and,
          depending on the feature and availability, Google Gemini, OpenAI, DeepSeek, DeepInfra, and Alibaba Cloud for
          AI processing. Submitted content is processed under those providers&apos; applicable service terms and privacy
          arrangements.
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
          <li>Live-call transcripts and generated audio are kept with the associated project.</li>
          <li>
            Billing, fraud, security, moderation, support, dispute, and legal records are kept for as long as
            reasonably required for those purposes and applicable law.
          </li>
        </ul>
        <p>
          Backups and distributed systems may take additional time to cycle after deletion. De-identified or
          aggregated information that no longer identifies you may be retained.
        </p>
      </Section>

      <Section title="7. Account and project deletion">
        <p>
          You can delete projects in the app. You can request account deletion through Account settings or the
          instructions on our <Link to="/account-deletion">Account Deletion page</Link>. We target completion within
          30 days after verifying the request. Account deletion removes or de-identifies projects and user content,
          subject to narrow retention for legal, billing, fraud-prevention, security, and dispute purposes. It does
          not cancel a Google Play subscription; cancellation is handled separately through Google Play.
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
    <LegalPage title="Delete your Tomeza account" description="How to request deletion of your account and data.">
      <LegalIntro>
        You can request deletion in the Tomeza app or by email. There is no charge for submitting a request.
      </LegalIntro>

      <Section title="Delete from the app">
        <ol>
          <li>Open Tomeza and sign in.</li>
          <li>Open <strong>Account</strong>.</li>
          <li>Under <strong>Privacy and support</strong>, choose <strong>Request account deletion</strong>.</li>
          <li>Review the explanation, optionally add a note, and confirm the request.</li>
        </ol>
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
          We target completion within 30 days after verification. We delete or de-identify the account&apos;s projects,
          generated books and images, exports, live-call transcripts, generated audio, and other user content. Source
          uploads may already have expired under the 180-day retention limit.
        </p>
        <p>
          We may retain limited billing, transaction, fraud-prevention, security, moderation, support, dispute, and
          legal records for as long as reasonably required. Retained records are restricted to those purposes. Backup
          copies may take additional time to cycle out.
        </p>
      </Section>

      <Section title="Subscriptions are separate">
        <p>
          Deleting the account, deleting the app, or sending a deletion request does not cancel a Google Play
          subscription. Cancel it separately in Google Play&apos;s subscription center to prevent future renewal. You may
          want to export work and cancel the subscription before requesting deletion.
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

function LegalPage(props: { title: string; description: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${props.title} · Tomeza`;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    description?.setAttribute("content", props.description);
  }, [props.title, props.description]);

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
        <h1>{props.title}</h1>
        <p className="legal-version">Effective {effectiveDate} · Version {version}</p>
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
