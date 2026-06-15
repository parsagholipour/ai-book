# Phase 11 Legal And Policy Assets

Policy review date: 2026-06-15.

## Official Guidance Checked

- Google Play AI-Generated Content policy: apps that generate AI content need in-app reporting/flagging and must prevent restricted content.
  Source: https://support.google.com/googleplay/android-developer/answer/13985936
- Google Play User Data policy: apps need transparent user-data handling, a privacy policy in Play Console and in app, retention/deletion disclosure, secure handling, and account deletion paths when accounts can be created.
  Source: https://support.google.com/googleplay/android-developer/answer/10144311
- Google Play Data Safety form guidance: developers are responsible for accurate declarations; data collection includes user data transmitted off-device; privacy policy is required.
  Source: https://support.google.com/googleplay/android-developer/answer/10787469
- Google Play account deletion requirements: apps with account creation need an in-app deletion path plus a web deletion resource; retained data for security, fraud prevention, or legal compliance must be disclosed.
  Source: https://support.google.com/googleplay/android-developer/answer/13327111

## Config Placeholders

Backend environment variables:

- `PRIVACY_POLICY_URL`: defaults to `https://example.com/tomeza/privacy`.
- `TERMS_OF_SERVICE_URL`: defaults to `https://example.com/tomeza/terms`.
- `ACCOUNT_DELETION_URL`: defaults to `https://example.com/tomeza/account-deletion`.
- `SUPPORT_EMAIL`: defaults to `support@example.com`.

Flutter build-time values:

- `PRIVACY_POLICY_URL`
- `TERMS_OF_SERVICE_URL`
- `ACCOUNT_DELETION_URL`
- `SUPPORT_EMAIL`

Replace placeholders before any public or closed Google Play submission.

## In-App Disclosures And Controls

- Account screen shows support email, privacy policy URL, terms URL, account deletion URL, AI-generated content disclosure, and retention notes.
- Generated preview shows AI-generated content disclosure.
- Generated book preview includes `Report book`.
- Generated cover/page visuals include `Report visual`.
- Account screen includes `Request account deletion`.
- Project detail includes `Delete project`.

## Data Retention Notes

- Project deletion removes the project database record and generated project files from book, image, and voice storage.
- Provider call logs may retain diagnostic/cost records with project/job references cleared by database delete rules.
- Moderation reports may retain target snapshots after a project or asset is deleted so abuse/safety review remains auditable.
- Billing, subscription, ledger, purchase, safety, moderation, abuse-prevention, and support records may be retained where needed for fraud prevention, compliance, support, chargebacks, or legal obligations.

## Draft Privacy Policy Requirements

The production privacy policy must clearly cover:

- Developer/app identity: `Tomeza: AI Book Maker`.
- Privacy contact: production `SUPPORT_EMAIL`.
- Data collected: account email/display name, auth/session records, project prompts/titles/generated text/generated images/export state, moderation reports, account deletion requests, purchase/entitlement records, server logs, and support messages.
- Use purposes: account access, book generation, export/download, billing entitlement, safety/moderation, abuse prevention, support, diagnostics, and legal compliance.
- Sharing: AI providers, cloud hosting/storage/database/queue providers, Google Play purchase verification, support/error monitoring providers when added, and legal/compliance disclosures. No sale of personal/sensitive data.
- Security: production HTTPS, hashed tokens, hashed Google Play purchase tokens, redacted server logs, backend ownership enforcement.
- Retention/deletion: project deletion, account deletion request flow, retained records categories, expected processing time.
- AI content: generated books and visuals are AI-assisted and may be reviewed through user reports.

## Terms Of Service Requirements

The production terms must cover:

- User ownership/responsibility for prompts and generated content.
- AI-generated content limitations and no professional advice guarantees for health, legal, financial, safety, or other sensitive topics.
- Prohibited content and restricted-content enforcement.
- Credit-based paid usage with bounded products only; no unlimited AI usage.
- Google Play Billing handling and refund/support path.
- Account termination, project deletion, report handling, and retained compliance records.

## Google Play Data Safety Draft Answers

This is a draft for Play Console review, not a legal final.

| Data type | Collected | Shared | Purpose | Required | Notes |
| --- | --- | --- | --- | --- | --- |
| Email address | Yes | Service providers only | Account management, support, abuse prevention | Required | Stored in `User.email`. |
| Name/display name | Optional | Service providers only | Account personalization, support | Optional | Stored only if user enters it. |
| User IDs | Yes | Service providers only | Auth, ownership, billing, moderation | Required | Internal ids and session ids. |
| User-generated text/content | Yes | AI/service providers | App functionality, AI generation, moderation, support | Required for generation | Prompts, project titles, book text, revision notes, report comments. |
| Photos/videos/files | Yes, generated images/files | Service providers only | App functionality, export/download, moderation | Generated by app | App does not request user photo library/camera in MVP. |
| Purchase history | Yes | Google Play / service providers | Billing, entitlement, fraud prevention | Required for paid products | Raw purchase tokens are verified then hashed/stored server-side. |
| App interactions | Yes | Service providers only | Diagnostics, abuse prevention, product support | Required | Endpoint usage, generation/reporting/deletion events; update if analytics SDK is added. |
| Crash logs/diagnostics | Planned | Error monitoring provider when added | Reliability | Optional/planned | Phase 12 must update this when error tracking is selected. |
| Device/location/contacts/microphone/camera/SMS | No | No | Not used | No | Reassess if future features add permissions. |

Security practices draft:

- Data encrypted in transit for staging/production API URLs.
- Users can request account deletion in app and through `ACCOUNT_DELETION_URL`.
- Users can delete projects.
- No data sale.

## Reliability And Abuse Plan

- Existing health check: `GET /api/health`.
- Production deployment should monitor API health, worker health, queue depth, Redis/Postgres availability, Google Play verification errors, generation failure rates, moderation report volume, and account deletion request queue age.
- Error tracking should redact request headers, cookies, passwords, refresh tokens, purchase tokens, report comments, deletion reasons, and review notes. Server logger now redacts these common fields.
- Add alerting before launch for API 5xx spikes, failed billing verification spikes, queue stalls, storage write failures, and report/deletion review backlog.

## Manual Review Blockers

- Replace placeholder privacy policy, terms, account deletion URL, and support email.
- Legal review for privacy policy, terms, data retention, deletion processing SLA, and sensitive-topic disclaimers.
- Data Safety answers must be checked against final production SDKs, analytics/error tracking choices, hosting providers, and any added Android permissions.
- Confirm no child-directed store listing language before launch.
