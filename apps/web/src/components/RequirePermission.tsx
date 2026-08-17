import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/**
 * Gates a route by permission. Before this existed, navigating directly to
 * an admin URL rendered the full page shell (buttons, layout, forms)
 * regardless of the user's permissions — the backend correctly 403'd the
 * underlying data fetch, but the frontend had no way to tell "no data yet"
 * apart from "not allowed to be here." AppShell's nav already hides links
 * a user can't use; this closes the other half — reaching the same page
 * by typing/bookmarking the URL directly.
 */
export default function RequirePermission({
  perm,
  children,
}: {
  perm: string;
  children: ReactNode;
}) {
  const { hasPermission } = useAuth();
  if (!hasPermission(perm)) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-slate-200 bg-white p-12 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Access denied</h1>
        <p className="mt-2 max-w-sm text-sm text-slate-500">
          You don't have permission to view this page. If you think this is
          a mistake, ask an admin to grant it.
        </p>
        <Link
          to="/"
          className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          Back to Dashboard
        </Link>
      </div>
    );
  }
  return <>{children}</>;
}
