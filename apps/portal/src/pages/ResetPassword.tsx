import { useState } from 'react';
import { useSearchParams, Link, Navigate } from 'react-router-dom';
import { api } from '../lib/api';

/** Reached via the link the password-reset request emails/texts: /reset-password?token=... */
export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  if (done) return <Navigate to="/login" replace />;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api('/portal/auth/password-reset/confirm', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword }),
      });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900 text-center">Set a new password</h1>

          {error && (
            <div className="mt-4 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
          )}
          {!token && (
            <p className="mt-4 text-sm text-amber-700 text-center">
              This link is missing its reset code. Request a new one.
            </p>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="newPassword" className="block text-sm font-medium text-slate-700">
                New password
              </label>
              <input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base shadow-sm"
              />
            </div>
            <button
              type="submit"
              disabled={submitting || !token || newPassword.length < 8}
              className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm disabled:opacity-50"
            >
              {submitting ? 'Please wait…' : 'Reset password'}
            </button>
          </form>

          <Link to="/login" className="mt-4 block text-center text-sm text-blue-600">
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
