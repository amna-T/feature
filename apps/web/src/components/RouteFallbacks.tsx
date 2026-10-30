import { Link, isRouteErrorResponse, useRouteError } from "react-router-dom";
import "../dashboard.css";

/**
 * Shown for an address the app has no page for, instead of React Router's
 * developer error screen ("Unexpected Application Error! 404 Not Found"),
 * which is what a customer with a mistyped or old link used to see.
 */
export function NotFoundPage() {
  return (
    <main className="dash-centered">
      <h1>Page not found</h1>
      <p className="dash-muted">There is no page at this address.</p>
      <p>
        <Link to="/dashboard">Go to the merchant dashboard</Link>
      </p>
    </main>
  );
}

/** Shown when a page fails to render, instead of the developer error screen. */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundPage />;
  }
  return (
    <main className="dash-centered">
      <h1>Something went wrong</h1>
      <p className="dash-error">
        This page couldn&apos;t be shown. Try again, or go back to the
        dashboard.
      </p>
      <p>
        <Link to="/dashboard">Go to the merchant dashboard</Link>
      </p>
    </main>
  );
}
