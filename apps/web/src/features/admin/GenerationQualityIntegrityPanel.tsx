import { MANDATORY_INTEGRITY_CHECKS } from "@book-maker/core/qualityGates";

export function GenerationQualityIntegrityPanel() {
  return (
    <div className="quality-integrity-panel">
      <strong>Mandatory integrity</strong>
      <p className="muted">
        These checks run at every Effort tier. They are not checkboxes and cannot
        be turned off by a quality revision.
      </p>
      <ul>
        {MANDATORY_INTEGRITY_CHECKS.map((check) => (
          <li key={check.id}>
            <strong>{check.label}</strong>
            <small>{check.summary}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
