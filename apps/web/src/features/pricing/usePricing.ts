import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost, apiPut } from "../../api.js";
import { readError } from "../shared/formatters.js";
import type { CreditPricingKey, PricingPreview, PricingSaveResponse, PricingState } from "./types.js";

/** Long enough that typing "120" does not fire three previews; short enough to feel live. */
const PREVIEW_DEBOUNCE_MS = 400;

export function usePricing() {
  const [state, setState] = useState<PricingState | null>(null);
  const [draft, setDraft] = useState<Record<CreditPricingKey, string> | null>(null);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<PricingPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const applyState = useCallback((next: PricingState) => {
    setState(next);
    setDraft(asText(next.values));
    setPreview(next.preview);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      applyState(await apiGet<PricingState>("/api/admin/pricing"));
      setError(null);
    } catch (loadError) {
      setError(readError(loadError));
    } finally {
      setLoading(false);
    }
  }, [applyState]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = draft ? parseDraft(draft) : null;
  const dirtyKeys =
    state && parsed
      ? (Object.keys(parsed.values) as CreditPricingKey[]).filter((key) => parsed.values[key] !== state.values[key])
      : [];

  // Preview the numbers as typed, priced by the server so the arithmetic can
  // never drift from what production would actually charge.
  useEffect(() => {
    if (!parsed || parsed.invalidKeys.length > 0) {
      return;
    }
    const values = parsed.values;
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      void apiPost<PricingPreview>("/api/admin/pricing/preview", { values })
        .then(setPreview)
        .catch(() => {
          /* the editor keeps working without a preview */
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(previewTimer.current);
  }, [draft]);

  function setField(key: CreditPricingKey, value: string) {
    setSaved(null);
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function resetToSaved() {
    if (state) {
      setDraft(asText(state.values));
      setSaved(null);
      setError(null);
    }
  }

  function resetToDefaults() {
    if (state) {
      setDraft(asText(state.defaults));
      setSaved(null);
    }
  }

  async function save() {
    if (!state || !parsed || parsed.invalidKeys.length > 0) {
      return;
    }
    setSaving(true);
    try {
      const response = await apiPut<PricingSaveResponse>("/api/admin/pricing", {
        values: parsed.values,
        expectedVersion: state.version,
        ...(note.trim() ? { note: note.trim() } : {})
      });
      setSaved(response.applied ? `Saved as version ${response.version}.` : "Nothing changed.");
      setNote("");
      setError(null);
      await load();
    } catch (saveError) {
      setError(readError(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function revert(version: number) {
    setSaving(true);
    try {
      const response = await apiPost<PricingSaveResponse>("/api/admin/pricing/revert", { version });
      setSaved(`Reverted to version ${version}, saved as version ${response.version}.`);
      setError(null);
      await load();
    } catch (revertError) {
      setError(readError(revertError));
    } finally {
      setSaving(false);
    }
  }

  return {
    state,
    draft,
    /** The draft parsed to numbers, or null while any field is mid-edit and invalid. */
    values: parsed && parsed.invalidKeys.length === 0 ? parsed.values : null,
    note,
    setNote,
    preview,
    error,
    saved,
    loading,
    saving,
    dirtyKeys,
    invalidKeys: parsed?.invalidKeys ?? [],
    setField,
    resetToSaved,
    resetToDefaults,
    save,
    revert,
    reload: load
  };
}

/**
 * Prices are edited as text, not numbers.
 *
 * A number input bound to a number turns a half-typed "" or "-" into 0 or NaN
 * under the operator's cursor, which is how a stray keystroke becomes a free
 * book. Text keeps the field exactly as typed and defers judgement to save time.
 */
function asText(values: Record<CreditPricingKey, number>): Record<CreditPricingKey, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) as Record<
    CreditPricingKey,
    string
  >;
}

function parseDraft(draft: Record<CreditPricingKey, string>): {
  values: Record<CreditPricingKey, number>;
  invalidKeys: CreditPricingKey[];
} {
  const values = {} as Record<CreditPricingKey, number>;
  const invalidKeys: CreditPricingKey[] = [];
  for (const [key, raw] of Object.entries(draft) as Array<[CreditPricingKey, string]>) {
    const trimmed = raw.trim();
    const parsedValue = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(parsedValue) || parsedValue < 0) {
      invalidKeys.push(key);
      values[key] = Number.NaN;
      continue;
    }
    values[key] = parsedValue;
  }
  return { values, invalidKeys };
}
