/**
 * Public legal-document metadata shared by the API and web application.
 *
 * A material Terms update changes the acceptance version. A wording-only
 * correction may change the rendered revision date without changing these
 * values, so existing users are not asked to accept the same terms twice.
 */
export const CURRENT_TERMS_VERSION = "2026-08-08";
export const CURRENT_PRIVACY_VERSION = "2026-08-08";
export const LEGAL_EFFECTIVE_DATE = "2026-08-08";

export const LEGAL_COMPANY_NAME = "Ravanix Technologies L.L.C-FZ";
export const LEGAL_COMPANY_ADDRESS =
  "Meydan Grandstand, 6th floor, Meydan Road, Nad Al Sheba, Dubai, U.A.E.";
export const LEGAL_SUPPORT_EMAIL = "support@ravanix.app";

export const PUBLIC_LEGAL_BASE_URL = "https://tomeza.ravanix.app";
export const PUBLIC_PRIVACY_POLICY_URL = `${PUBLIC_LEGAL_BASE_URL}/privacy`;
export const PUBLIC_TERMS_OF_SERVICE_URL = `${PUBLIC_LEGAL_BASE_URL}/terms`;
export const PUBLIC_ACCOUNT_DELETION_URL = `${PUBLIC_LEGAL_BASE_URL}/account-deletion`;

export type LegalDocumentMetadata = {
  termsVersion: string;
  privacyVersion: string;
  effectiveDate: string;
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
  accountDeletionUrl: string;
  companyName: string;
  companyAddress: string;
  supportEmail: string;
};

export function currentLegalDocumentMetadata(): LegalDocumentMetadata {
  return {
    termsVersion: CURRENT_TERMS_VERSION,
    privacyVersion: CURRENT_PRIVACY_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    privacyPolicyUrl: PUBLIC_PRIVACY_POLICY_URL,
    termsOfServiceUrl: PUBLIC_TERMS_OF_SERVICE_URL,
    accountDeletionUrl: PUBLIC_ACCOUNT_DELETION_URL,
    companyName: LEGAL_COMPANY_NAME,
    companyAddress: LEGAL_COMPANY_ADDRESS,
    supportEmail: LEGAL_SUPPORT_EMAIL
  };
}
