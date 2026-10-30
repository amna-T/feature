import type { ReactNode } from "react";
import { useDashboardAuth } from "./DashboardAuthContext.js";
import { roleGateDecision } from "./roleGate.js";
import type { MerchantRole } from "../types.js";

/**
 * A UI-only convenience gate. It is **not** the security boundary for
 * anything it wraps: every action and page it hides is also role-checked by
 * the API (capture/void, payment-link create/cancel, refunds, every webhook
 * route, reconciliation), which answers 403 regardless.
 *
 * Until `me` has loaded the role is unknown, so nothing is rendered. It used
 * to show the children in that window, so a support user saw owner-only
 * buttons and pages flash up (and could click them into a 403).
 */
export function RequireRole({
  allow,
  children,
  fallback = null,
  loading = null,
}: {
  allow: MerchantRole[];
  children: ReactNode;
  fallback?: ReactNode;
  loading?: ReactNode;
}) {
  const { me } = useDashboardAuth();
  const decision = roleGateDecision(me, allow);
  if (decision === "loading") return <>{loading}</>;
  if (decision === "denied") return <>{fallback}</>;
  return <>{children}</>;
}

/**
 * The page-level form of the same gate, for the three routes whose server
 * side is role-gated end to end (payment-link create, both webhook write
 * pages). It exists only so a `support` user who typed or bookmarked the URL
 * gets a sentence instead of a blank page — `RequireRole`'s `null` fallback
 * is right for hiding a button and wrong for hiding a whole screen.
 *
 * Still not the boundary: the server answers `403` to the request regardless
 * of what renders here.
 */
/** UI-only: hides the page, does not protect the endpoint behind it. */
export function RoleGatedPage({
  allow,
  title,
  children,
}: {
  allow: MerchantRole[];
  title: string;
  children: ReactNode;
}) {
  return (
    <RequireRole
      allow={allow}
      loading={<p>Loading...</p>}
      fallback={
        <section>
          <h1>{title}</h1>
          <p className="dash-error">
            You don&apos;t have permission to use this page — ask an owner or finance
            user on your account.
          </p>
        </section>
      }
    >
      {children}
    </RequireRole>
  );
}
