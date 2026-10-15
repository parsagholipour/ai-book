import { useState } from "react";
import { BellRing } from "lucide-react";
import { apiPost } from "../../api.js";
import { Button } from "../shared/Button.js";
import { readError } from "../shared/formatters.js";

/**
 * `POST /api/admin/monitoring/test-alert`: one email to `OPERATOR_ALERT_EMAIL`
 * through the transport the alerts use — the runbook's step after every deploy
 * (docs/deployment.md, "Send a test alert after every deploy"). The answer is
 * shown beside the button: where it went, or why it did not (409 no address,
 * 503 no SMTP, 502 the mail server's refusal).
 */
export function TestAlertButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const sent = await apiPost<{ ok: true; sentTo: string; sentAt: string }>("/api/admin/monitoring/test-alert");
      setResult({ ok: true, text: `Sent to ${sent.sentTo}. Check that it arrived.` });
    } catch (error) {
      setResult({ ok: false, text: `Not sent: ${readError(error)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="test-alert">
      <Button size="sm" onClick={() => void send()} loading={busy} loadingLabel="Sending…" startIcon={<BellRing />}>
        Send test alert
      </Button>
      {result ? (
        <span role="status" className={result.ok ? "muted" : "test-alert-failed"}>
          {result.text}
        </span>
      ) : null}
    </span>
  );
}
