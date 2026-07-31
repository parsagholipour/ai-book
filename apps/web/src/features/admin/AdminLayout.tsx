import { ArrowLeft, BarChart3, Coins, ShieldAlert, Users } from "lucide-react";
import { Link, NavLink, Outlet } from "react-router";
import { AppLogo } from "../shared/AppLogo.js";

export const ADMIN_TABS = [
  { to: "/admin", label: "Overview", icon: BarChart3, end: true },
  { to: "/admin/users", label: "Users", icon: Users, end: false },
  { to: "/admin/moderation", label: "Moderation", icon: ShieldAlert, end: false },
  { to: "/admin/pricing", label: "Pricing", icon: Coins, end: false }
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
        <Link className="icon-text-button" to="/">
          <ArrowLeft size={16} aria-hidden />
          Back to console
        </Link>
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
