import type { ReactNode } from "react";

export function AuthShell(props: { children: ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">{props.children}</section>
    </main>
  );
}
