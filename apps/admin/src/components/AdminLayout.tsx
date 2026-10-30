import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { describeError, WEB_BASE_URL } from "../api/client.js";
import { ImpersonationBanner } from "./ImpersonationBanner.js";

/** Nav shell for every admin-plane screen: who you are signed in as, the
 *  section links, a logout, and — above all of it — the impersonation
 *  banner when a grant is live. */
// YA: nav order per Huda's request (Credits first)
export function AdminLayout() {
  const { admin, signOut, impersonation } = useAdminAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="admin-shell">
      <ImpersonationBanner />

      <header className="admin-header">
        <div className="admin-brand">
          <svg className="admin-brand-pearl" viewBox="0 0 32 32" aria-hidden="true">
            <defs>
              <radialGradient id="admin-pearl" cx="35%" cy="30%" r="75%">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="45%" stopColor="#f1e9dc" />
                <stop offset="100%" stopColor="#c8a96a" />
              </radialGradient>
            </defs>
            <circle cx="16" cy="16" r="13" fill="url(#admin-pearl)" />
            <circle cx="11.5" cy="11" r="3.2" fill="#fff" opacity="0.85" />
          </svg>
          <span>
            Fils<b>Pay</b>
            <span className="admin-brand-tag">Operations</span>
          </span>
        </div>
        <nav className="admin-nav">
          <span className="admin-nav-heading">Console</span>
          <NavLink to="/merchants">Merchants</NavLink>
          <NavLink to="/credits">Credits</NavLink>
          <NavLink to="/settlement">Settlement ops</NavLink>
          <NavLink to="/adjustment-imports">Import adjustments</NavLink>
          <NavLink to="/webhooks">Webhook replay</NavLink>
        </nav>
        <div className="admin-identity">
          {admin ? (
            <span className="admin-identity-text">
              <span>{admin.email}</span>
              <span className="admin-role-chip">{admin.role}</span>
            </span>
          ) : null}
          <button type="button" className="admin-button-ghost" onClick={() => void handleSignOut()}>
            Log out
          </button>
        </div>
      </header>

      <div className="admin-content">
      {error ? <p className="admin-error">{error}</p> : null}

      {impersonation ? (
        // An explicit "exit view-as-merchant" action is required before
        // admin-plane screens are shown again. This is a UX safeguard so the
        // two modes are never confused on screen; the privilege boundary
        // itself does not depend on it — /v1/admin/* never reads the
        // impersonation cookie, and the merchant side never reads the admin
        // session cookie.
        <main className="admin-main">
          <h1>Admin screens are paused</h1>
          <p>
            An impersonation grant is active. Use <strong>Exit impersonation</strong> above to end it
            and return to the admin console.
          </p>
          <p>
            Merchant screens are at <code>{WEB_BASE_URL}</code> while the grant lasts.
          </p>
        </main>
      ) : (
        <main className="admin-main">
          <Outlet />
        </main>
      )}
      </div>
    </div>
  );
}
