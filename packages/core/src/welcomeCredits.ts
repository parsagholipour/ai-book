import { creditPricing, type CreditPricing } from "./creditPricing.js";

// World Bank FY2027 (July 2026–June 2027), checked 2026-10-03:
// https://datahelpdesk.worldbank.org/knowledgebase/articles/906519-world-bank-country-and-lending-groups
// ISO-2 codes from https://api.worldbank.org/v2/country?format=json&per_page=400
// Pin this snapshot: an upstream reclassification must not change live offers.
// Taiwan is in the published table but absent from the API. Channel Islands
// (API code JG) maps to Jersey (JE) and Guernsey (GG) for IP country lookups.
const HIGH_INCOME = new Set(
  (
    "AD AE AG AS AT AU AW BB BE BG BH BM BN BS CA CH CL CR CW CY CZ DE DK EE ES FI FO FR GB GG GI GL GR GU GY HK HR HU IE IL IM IS IT JE " +
    "JP KN KR KW KY LI LT LU LV MC MF MO MP MT NC NL NO NR NZ OM PA PF PL PR PT PW QA RO RU SA SC SE SG SI SK SM SX TC TT TW US UY VG VI"
  ).split(" ")
);
// Combines the Bank's low, lower-middle and upper-middle income categories.
const LOW_MIDDLE_INCOME = new Set(
  (
    "AF BF BI CD CF ER ET GM GW KP LR MG ML MW MZ NE RW SD SL SO SS SY TD UG YE " +
    "AO BD BJ BO BT CG CI CM DJ EG GH GN HN HT IN KE KG KH KI KM LA LB LS MA MM MR NA NG NI NP PG PK PS SB SN ST SZ TG TJ TL TN TZ UZ VE VU ZM ZW " +
    "AL AM AR AZ BA BR BW BY BZ CN CO CU CV DM DO DZ EC FJ FM GA GD GE GQ GT ID IQ IR JM JO KZ LC LK LY MD ME MH MK MN MU MV MX MY PE PH PY RS SR SV TH TM TO TR TV UA VC VN WS XK ZA"
  ).split(" ")
);
// Product policy: keep all EU/EEA members and EU outermost territories on the
// same offer, including territories not separately classified by the Bank.
const EU_EEA = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO AX GF GP MQ MF RE YT".split(" ")
);

export type WelcomeCreditRegion = "HIGH_INCOME" | "LOW_MIDDLE_INCOME" | "OTHER";

export function welcomeCreditRegion(countryCode: string | null | undefined): WelcomeCreditRegion {
  const country = countryCode?.trim().toUpperCase();
  if (country && (EU_EEA.has(country) || HIGH_INCOME.has(country))) return "HIGH_INCOME";
  if (country && LOW_MIDDLE_INCOME.has(country)) return "LOW_MIDDLE_INCOME";
  return "OTHER";
}

export function welcomeCreditIpLimit(
  countryCode: string | null | undefined,
  pricing: CreditPricing = creditPricing()
): number {
  return welcomeCreditRegion(countryCode) === "HIGH_INCOME"
    ? pricing.welcomeCreditsAccountsPerIpHighIncome
    : pricing.welcomeCreditsAccountsPerIpLowMiddleIncome;
}

export function welcomeCreditAmount(
  countryCode: string | null | undefined,
  pricing: CreditPricing = creditPricing()
): number {
  if (pricing.welcomeCreditsEnabled <= 0) return 0;
  if (pricing.welcomeCreditsRegionalEnabled > 0) {
    switch (welcomeCreditRegion(countryCode)) {
      case "HIGH_INCOME": return pricing.welcomeCreditsHighIncome;
      case "LOW_MIDDLE_INCOME": return pricing.welcomeCreditsLowMiddleIncome;
    }
  }
  return pricing.welcomeCredits;
}
