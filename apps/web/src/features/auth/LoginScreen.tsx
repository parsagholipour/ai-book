import type { FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { AuthShell } from "./AuthShell.js";
import { AppLogo } from "../shared/AppLogo.js";
import { Button } from "../shared/Button.js";

export function LoginScreen(props: {
  password: string;
  busy: boolean;
  error: string | null;
  onPasswordChange: (password: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <AuthShell>
      <div className="auth-icon">
        <AppLogo aria-hidden={true} />
      </div>
      <div>
        <p className="eyebrow">Protected console</p>
        <h1>AI Book Maker</h1>
        <p className="muted">Enter the password from your `.env` file to continue.</p>
      </div>
      <form className="auth-form" onSubmit={props.onSubmit}>
        <label>
          Password
          <input
            autoFocus
            type="password"
            value={props.password}
            onChange={(event) => props.onPasswordChange(event.target.value)}
            placeholder="WEB_PASSWORD"
          />
        </label>
        {props.error ? <div className="error-banner">{props.error}</div> : null}
        <Button
          variant="primary"
          fullWidth
          type="submit"
          disabled={props.busy || !props.password.trim()}
          loading={props.busy}
          loadingLabel="Unlocking…"
          startIcon={<LockKeyhole />}
        >
          Unlock
        </Button>
      </form>
    </AuthShell>
  );
}
