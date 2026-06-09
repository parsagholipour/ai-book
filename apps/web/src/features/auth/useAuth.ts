import { useEffect, useState, type FormEvent } from "react";
import { apiGet, apiPost, type AuthStatus } from "../../api.js";
import { readError } from "../shared/formatters.js";

export function useAuth() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    void refreshAuthStatus();
  }, []);

  async function refreshAuthStatus() {
    try {
      setAuthError(null);
      setAuthStatus(await apiGet<AuthStatus>("/api/auth/status"));
    } catch (authStatusError) {
      setAuthStatus({ enabled: true, authenticated: false });
      setAuthError(readError(authStatusError));
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      const nextAuthStatus = await apiPost<AuthStatus>("/api/auth/login", { password: authPassword });
      setAuthStatus(nextAuthStatus);
      setAuthPassword("");
    } catch (loginError) {
      setAuthError(readError(loginError));
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout(onSuccess?: () => Promise<void>) {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const nextAuthStatus = await apiPost<AuthStatus>("/api/auth/logout");
      setAuthStatus(nextAuthStatus);
      await onSuccess?.();
    } catch (logoutError) {
      setAuthError(readError(logoutError));
    } finally {
      setAuthBusy(false);
    }
  }

  return {
    authStatus,
    authPassword,
    authBusy,
    authError,
    setAuthPassword,
    login,
    logout,
    refreshAuthStatus
  };
}
