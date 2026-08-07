import { Loader2 } from "lucide-react";
import { Navigate, Route, Routes } from "react-router";
import { AuthShell } from "./features/auth/AuthShell.js";
import { LoginScreen } from "./features/auth/LoginScreen.js";
import { useAuth } from "./features/auth/useAuth.js";
import { AdminLayout } from "./features/admin/AdminLayout.js";
import { CostsScreen } from "./features/admin/CostsScreen.js";
import { ModerationScreen } from "./features/admin/ModerationScreen.js";
import { OperationsScreen } from "./features/admin/OperationsScreen.js";
import { OverviewScreen } from "./features/admin/OverviewScreen.js";
import { UsersScreen } from "./features/admin/UsersScreen.js";
import { SafetySettingsScreen } from "./features/admin/SafetySettingsScreen.js";
import { ConsoleScreen } from "./features/console/ConsoleScreen.js";
import { PricingScreen } from "./features/pricing/PricingScreen.js";
import { ADMIN_PATH, PRICING_PATH } from "./features/projects/routing.js";
import { AccountDeletionPage, PrivacyPage, TermsPage } from "./features/legal/LegalPages.js";

/**
 * Auth gate, then routing. Nothing else — the console's own wiring lives in
 * {@link ConsoleScreen}.
 *
 * `/` and `/projects/:projectId` deliberately render the *same* element so React
 * reconciles rather than remounts when a project is selected. A remount would
 * tear down and re-open the console's SSE subscription on every selection.
 */
export function App() {
  return (
    <Routes>
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/account-deletion" element={<AccountDeletionPage />} />
      <Route path="*" element={<AuthenticatedApp />} />
    </Routes>
  );
}

function AuthenticatedApp() {
  const auth = useAuth();

  if (!auth.authStatus) {
    return (
      <AuthShell>
        <Loader2 className="spin" size={26} aria-hidden />
        <p>Checking access…</p>
      </AuthShell>
    );
  }

  if (!auth.authStatus.authenticated) {
    return (
      <LoginScreen
        password={auth.authPassword}
        busy={auth.authBusy}
        error={auth.authError}
        onPasswordChange={auth.setAuthPassword}
        onSubmit={auth.login}
      />
    );
  }

  return (
    <Routes>
      <Route path="/" element={<ConsoleScreen auth={auth} />} />
      <Route path="/projects/:projectId" element={<ConsoleScreen auth={auth} />} />
      <Route path={ADMIN_PATH} element={<AdminLayout />}>
        <Route index element={<OverviewScreen />} />
        <Route path="operations" element={<OperationsScreen />} />
        <Route path="costs" element={<CostsScreen />} />
        <Route path="users" element={<UsersScreen />} />
        <Route path="moderation" element={<ModerationScreen />} />
        <Route path="settings" element={<SafetySettingsScreen />} />
        <Route path="pricing" element={<PricingScreen />} />
      </Route>
      {/* Pricing shipped at its own path before the dashboard grew around it. */}
      <Route path={PRICING_PATH} element={<Navigate to={`${ADMIN_PATH}/pricing`} replace />} />
      {/* Unknown paths used to fall through to "no project selected"; keep that. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
