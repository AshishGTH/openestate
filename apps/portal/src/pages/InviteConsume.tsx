import { useState } from 'react';
import { useParams, useSearchParams, Navigate } from 'react-router-dom';
import { api, setAccessToken } from '../lib/api';
import { useAuth } from '../lib/auth';

/** Reached via the link staff sends (SMS/email): /invite/:inviteId?token=... */
export default function InviteConsume() {
  const { inviteId } = useParams<{ inviteId: string }>();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const [token, setToken] = useState(searchParams.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // "/" branches to the right home tab for either portal principal — see App.tsx's PortalHome.
  if (user) return <Navigate to="/" replace />;
  if (done) return <Navigate to="/" replace />;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api<{ accessToken: string }>(`/portal/auth/invite/${inviteId}/consume`, {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setAccessToken(res.accessToken);
      setDone(true);
      // Full reload so AuthProvider re-runs its refresh check and picks up
      // the new session cookie cleanly; "/" branches to the right home tab.
      window.location.href = '/';
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
          <h1 className="text-xl font-semibold text-slate-900 text-center">Set your password</h1>
          <p className="mt-1 text-sm text-slate-500 text-center">Welcome to the OpenEstate portal</p>

          {error && (
            <div className="mt-4 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {!searchParams.get('token') && (
              <div>
                <label htmlFor="token" className="block text-sm font-medium text-slate-700">
                  Invite code
                </label>
                <input
                  id="token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base shadow-sm"
                />
              </div>
            )}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                New password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base shadow-sm"
              />
            </div>
            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-700">
                Confirm password
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base shadow-sm"
              />
            </div>
            <button
              type="submit"
              disabled={submitting || !token || password.length < 8}
              className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm disabled:opacity-50"
            >
              {submitting ? 'Please wait…' : 'Set password and continue'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
