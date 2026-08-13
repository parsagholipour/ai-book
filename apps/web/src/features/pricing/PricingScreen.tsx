import { Coins, History, Loader2, RotateCcw, Save, Undo2 } from "lucide-react";
import { Button } from "../shared/Button.js";
import { PRICING_FIELD_GROUPS } from "./pricingFields.js";
import { ProfitSection } from "./ProfitSection.js";
import type { CreditPricingKey, PricingPreview, PricingRevision } from "./types.js";
import { usePricing } from "./usePricing.js";

/**
 * Operator-facing editor for the fourteen credit prices.
 *
 * Everything here is money that changes for real readers the moment Save
 * lands, so the screen leans on three things: the default is always shown next
 * to the field, a worked example re-prices as you type, and every save is a
 * revision that can be read back and reverted.
 */
export function PricingScreen() {
  const pricing = usePricing();
  const dirty = new Set<CreditPricingKey>(pricing.dirtyKeys);
  const invalid = new Set<CreditPricingKey>(pricing.invalidKeys);
  const canSave = pricing.dirtyKeys.length > 0 && pricing.invalidKeys.length === 0 && !pricing.saving;

  return (
    <div className="admin-page">
      <p className="muted pricing-version-line">
        {pricing.state
          ? `Version ${pricing.state.version}${pricing.state.updatedAt ? ` · ${formatWhen(pricing.state.updatedAt)}` : " · running on the built-in defaults"}`
          : "Loading…"}
      </p>

      {pricing.error ? <div className="error-banner">{pricing.error}</div> : null}
      {pricing.saved ? <div className="pricing-saved">{pricing.saved}</div> : null}

      {pricing.loading || !pricing.state || !pricing.draft ? (
        <div className="empty-state">
          <Loader2 className="spin" size={20} aria-hidden /> Loading prices…
        </div>
      ) : (
        <div className="pricing-grid">
          <div className="pricing-columns">
            {PRICING_FIELD_GROUPS.map((group) => (
              <section className="work-section" key={group.title}>
                <div className="section-title">
                  <Coins size={18} aria-hidden />
                  <h3>{group.title}</h3>
                </div>
                <p className="muted">{group.blurb}</p>
                <div className="pricing-fields">
                  {group.fields.map((field) => {
                    const defaultValue = pricing.state!.defaults[field.key];
                    const isDirty = dirty.has(field.key);
                    const isInvalid = invalid.has(field.key);
                    return (
                      <label className={fieldClass(isDirty, isInvalid)} key={field.key}>
                        <span className="pricing-field-label">
                          {field.label}
                          {isDirty ? <em className="pricing-flag">changed</em> : null}
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={pricing.state!.limits[field.key]}
                          step={1}
                          value={pricing.draft![field.key]}
                          onChange={(event) => pricing.setField(field.key, event.target.value)}
                        />
                        <span className="muted pricing-field-help">
                          {field.help} Default {defaultValue}.
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <div className="pricing-side">
            <section className="tool-panel">
              <div className="panel-title">
                <Save size={18} aria-hidden />
                <h2>Save</h2>
              </div>
              <p className="muted">
                Changes apply to every reader immediately. The console shares one password, so the note is the only
                record of who changed what and why.
              </p>
              <label>
                Note
                <input
                  value={pricing.note}
                  placeholder="e.g. image provider raised prices"
                  onChange={(event) => pricing.setNote(event.target.value)}
                />
              </label>
              {pricing.invalidKeys.length > 0 ? (
                <p className="pricing-invalid">Every price must be a whole number of credits, zero or more.</p>
              ) : null}
              <div className="pricing-actions">
                <Button
                  variant="primary"
                  fullWidth
                  disabled={!canSave}
                  loading={pricing.saving}
                  loadingLabel={`Saving${pricing.dirtyKeys.length > 0 ? ` (${pricing.dirtyKeys.length})` : ""}…`}
                  startIcon={<Save />}
                  onClick={() => void pricing.save()}
                >
                  Save {pricing.dirtyKeys.length > 0 ? `(${pricing.dirtyKeys.length})` : ""}
                </Button>
                <Button
                  size="sm"
                  disabled={pricing.dirtyKeys.length === 0}
                  onClick={pricing.resetToSaved}
                  startIcon={<Undo2 />}
                >
                  Discard
                </Button>
                <Button size="sm" onClick={pricing.resetToDefaults} startIcon={<RotateCcw />}>
                  Load defaults
                </Button>
              </div>
            </section>

            <PreviewPanel preview={pricing.preview} creditUsdValue={pricing.state.creditUsdValue} />
            <HistoryPanel
              revisions={pricing.state.revisions}
              busy={pricing.saving}
              onRevert={(version) => void pricing.revert(version)}
            />
          </div>
        </div>
      )}

      {/* Last, on purpose: the numbers above are the inputs, this is what they earn. */}
      {pricing.state ? (
        <ProfitSection
          draftValues={pricing.values}
          savedValues={pricing.state.values}
          creditUsdValue={pricing.state.creditUsdValue}
        />
      ) : null}
    </div>
  );
}

/** The reader-facing names, so the console and the app say the same words. */
const TIER_LABELS = {
  fast: "Quick draft",
  balanced: "Balanced",
  premium: "Extra polish"
} as const;

function PreviewPanel(props: { preview: PricingPreview | null; creditUsdValue: number }) {
  if (!props.preview) {
    return null;
  }
  return (
    <section className="work-section">
      <div className="section-title">
        <Coins size={18} aria-hidden />
        <h3>What this costs a reader</h3>
      </div>
      <p className="muted">
        A {props.preview.label}, priced by the same estimator the app charges through.
      </p>
      <p className="pricing-total">
        {props.preview.totalCredits.toLocaleString()} credits
        <span className="muted"> ≈ ${props.preview.estimatedUsd.toFixed(2)}</span>
      </p>
      {/* The tiers are priced apart, so one total describes a third of the
          books being sold. The breakdown below stays the balanced one. */}
      <ul className="pricing-lines">
        {(props.preview.tiers ?? []).map((quote) => (
          <li key={quote.tier}>
            <span>{TIER_LABELS[quote.tier]}</span>
            <span className="muted">
              {quote.totalCredits.toLocaleString()} → ${quote.estimatedUsd.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
      <p className="muted">Balanced, line by line:</p>
      <ul className="pricing-lines">
        {props.preview.lineItems.map((item) => (
          <li key={`${item.code}:${item.label}`}>
            <span>{item.label}</span>
            <span className="muted">
              {item.quantity > 0 ? `${item.quantity} × ${item.unitCredits} → ` : ""}
              {item.credits.toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HistoryPanel(props: { revisions: PricingRevision[]; busy: boolean; onRevert: (version: number) => void }) {
  return (
    <section className="work-section">
      <div className="section-title">
        <History size={18} aria-hidden />
        <h3>History</h3>
      </div>
      {props.revisions.length === 0 ? (
        <p className="muted">No changes yet — these are the prices the build shipped with.</p>
      ) : (
        <ul className="pricing-revisions">
          {props.revisions.map((revision) => {
            const changes = Object.entries(revision.changed) as Array<[string, { from: number; to: number }]>;
            return (
              <li key={revision.version}>
                <div className="pricing-revision-head">
                  <strong>v{revision.version}</strong>
                  <span className="muted">{formatWhen(revision.createdAt)}</span>
                  <Button
                    size="sm"
                    disabled={props.busy}
                    onClick={() => props.onRevert(revision.version)}
                    startIcon={<Undo2 />}
                  >
                    Revert to this
                  </Button>
                </div>
                {revision.note ? <p className="pricing-revision-note">{revision.note}</p> : null}
                <ul className="pricing-lines">
                  {changes.map(([key, change]) => (
                    <li key={key}>
                      <span>{key}</span>
                      <span className="muted">
                        {change.from} → {change.to}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function fieldClass(isDirty: boolean, isInvalid: boolean): string {
  return ["pricing-field", isDirty ? "is-dirty" : "", isInvalid ? "is-invalid" : ""].filter(Boolean).join(" ");
}

function formatWhen(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? iso : when.toLocaleString();
}
