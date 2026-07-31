import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../api.js";
import { readError } from "../shared/formatters.js";
import type { CreditPricingKey, CreditPricingValues } from "./types.js";

export type PricingDrivers = Record<CreditPricingKey, number>;

export type PricingDriverReport = {
  window: { days: number; since: string; until: string };
  drivers: PricingDrivers;
  providerUsd: number;
  books: number;
  voiceMinutes: number;
  edits: number;
  coverage: { chargedCredits: number; modelledCredits: number; accuracyPercent: number | null };
};

export function useProfitDrivers(days: number) {
  const [data, setData] = useState<PricingDriverReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(true);

  const load = useCallback(async () => {
    setStale(true);
    try {
      setData(await apiGet<PricingDriverReport>(`/api/admin/pricing/drivers?days=${days}`));
      setError(null);
    } catch (loadError) {
      setError(readError(loadError));
    } finally {
      setStale(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, stale };
}

/**
 * Revenue is linear in the price list, so this is a dot product rather than a
 * replay of the pricing formulas — which is what lets the projection update on
 * every keystroke without another request.
 */
export function revenueAt(drivers: PricingDrivers, values: CreditPricingValues): number {
  return (Object.keys(drivers) as CreditPricingKey[]).reduce((total, key) => total + drivers[key] * values[key], 0);
}
