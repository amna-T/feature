import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { RequireRole } from "../auth/RequireRole.js";
import { describeError } from "../api/client.js";
import { BrandMark } from "./BrandMark.js";
import { BusinessDayClock } from "./BusinessDayClock.js";
import "../dashboard.css";

const ICONS = {
  overview: "M4 20V10m6 10V4m6 16v-7m4 7H2",
  transactions: "M4 7h13l-3-3M20 17H7l3 3",
  links: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  webhooks: "M12 3v6m0 6v6M3 12h6m6 0h6",
  settlement: "M3 10h18M5 10v8m4-8v8m6-8v8m4-8v8M2 21h20M12 3l9 5H3z",
  reconciliation: "M5 12l4 4L19 6",
} as const;

function NavIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="dash-nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Nav shell for every merchant dashboard screen. No impersonation banner
 *  here — nothing in the merchant plane impersonates anyone; when an admin
 *  "views as merchant", they arrive with a `support`-role session and see
 *  exactly what a support user sees. */
export function DashboardLayout() {
  const { me, signOut } = useDashboardAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // sign out clears the cookie server side, local merchantId stays — am
  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/dashboard/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="dash-shell">
      <header className="dash-header">
        <div className="dash-brand">
          <BrandMark tagline="Merchant" />
        </div>
        <nav className="dash-nav">
          <NavLink to="/dashboard/overview">
            <NavIcon name="overview" />
            Overview
          </NavLink>
          <NavLink to="/dashboard/transactions">
            <NavIcon name="transactions" />
            Transactions
          </NavLink>
          <NavLink to="/dashboard/payment-links">
            <NavIcon name="links" />
            Payment links
          </NavLink>
          <NavLink to="/dashboard/settlement">
            <NavIcon name="settlement" />
            Settlement
          </NavLink>
          {/* Every webhook route — including the plain list read — is
              owner/finance-only server-side, so the link itself is
              hidden from support rather than offered and then refused. */}
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/reconciliation">
              <NavIcon name="reconciliation" />
              Reconciliation
            </NavLink>
          </RequireRole>
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/webhooks">
              <NavIcon name="webhooks" />
              Webhooks
            </NavLink>
          </RequireRole>
        </nav>
        <div className="dash-identity">
          {me ? (
            <div className="dash-identity-card">
              <span className="dash-avatar" aria-hidden="true">
                {me.merchant.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="dash-identity-text">
                <strong>{me.merchant.displayName}</strong>
                <span className="dash-muted">{me.email}</span>
                <span className="dash-role-chip">{me.role}</span>
              </span>
            </div>
          ) : null}
          <button type="button" className="dash-button dash-button-ghost" onClick={() => void handleSignOut()}>
            Log out
          </button>
        </div>
      </header>

      <div className="dash-content">
        <div className="dash-topbar">
          <BusinessDayClock />
        </div>
        {error ? <p className="dash-error">{error}</p> : null}
        <main className="dash-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
