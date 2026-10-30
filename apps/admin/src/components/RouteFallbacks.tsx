import { Link, isRouteErrorResponse, useRouteError } from "react-router-dom";

/** Shown for an unknown address instead of React Router's developer error screen. */
export function NotFoundPage() {
  return (
    <main className="admin-main">
      <h1>Page not found</h1>
      <p className="admin-muted">There is no page at this address.</p>
      <p>
        <Link to="/merchants">Go to merchants</Link>
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
    <main className="admin-main">
      <h1>Something went wrong</h1>
      <p className="admin-error">This page couldn&apos;t be shown. Try again, or go back to the merchant list.</p>
      <p>
        <Link to="/merchants">Go to merchants</Link>
      </p>
    </main>
  );
}
