import { ArrowLeft, BarChart3, Coins, Receipt, Settings, ShieldAlert, Sparkles, Users, Workflow } from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { AppLogo } from "../shared/AppLogo.js";
import { ButtonLink } from "../shared/Button.js";

export const ADMIN_TABS = [
  { to: "/admin", label: "Overview", icon: BarChart3, end: true },
  { to: "/admin/operations", label: "Operations", icon: Workflow, end: false },
  { to: "/admin/costs", label: "Costs", icon: Receipt, end: false },
  { to: "/admin/users", label: "Users", icon: Users, end: false },
  { to: "/admin/moderation", label: "Moderation", icon: ShieldAlert, end: false },
  { to: "/admin/settings", label: "Safety", icon: Settings, end: false },
  { to: "/admin/pricing", label: "Pricing", icon: Coins, end: false },
  { to: "/admin/quality", label: "Quality", icon: Sparkles, end: false }
] as const;

/**
 * Shell for the operator dashboard.
 *
 * A layout route rather than a wrapper each screen renders itself: the tab bar
 * then survives navigation between tabs instead of unmounting and remounting,
 * so switching tabs never flashes the chrome.
 */
export function AdminLayout() {
  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div className="brand-row">
          <AppLogo aria-hidden={true} />
          <div>
            <h1>Operations</h1>
            <p>Revenue, usage, and the levers behind them</p>
          </div>
        </div>
        <ButtonLink to="/" size="sm" startIcon={<ArrowLeft />}>
          Back to console
        </ButtonLink>
      </header>

      <nav className="admin-tabs" aria-label="Dashboard sections">
        {ADMIN_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => `admin-tab${isActive ? " is-active" : ""}`}
          >
            <tab.icon size={16} aria-hidden />
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </main>
  );
}
