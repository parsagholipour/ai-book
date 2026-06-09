import type { FormEvent } from "react";
import { Loader2, LockKeyhole } from "lucide-react";
import { AuthShell } from "./AuthShell.js";

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
        <LockKeyhole size={28} aria-hidden />
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
        <button className="primary-button" type="submit" disabled={props.busy || !props.password.trim()}>
          {props.busy ? <Loader2 className="spin" size={18} /> : <LockKeyhole size={18} />}
          Unlock
        </button>
      </form>
    </AuthShell>
  );
}
