import { useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function Login() {
  const { user, login, verifyTotp, isLoading } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [needsTotp, setNeedsTotp] = useState(false);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-500">Loading…</div>
      </div>
    );
  }

  if (user) return <Navigate to="/profile" replace />;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      if (needsTotp) {
        const result = await verifyTotp(totpCode);
        if (!result.ok) setError(result.error);
      } else {
        const result = await login(identifier, password);
        if (!result.ok) {
          if ('requiresTwoFactor' in result) {
            setNeedsTotp(true);
          } else {
            setError(result.error);
          }
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900 text-center">OpenEstate</h1>
          <p className="mt-1 text-sm text-slate-500 text-center">Customer &amp; broker portal</p>

          {error && (
            <div className="mt-4 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {needsTotp ? (
              <div>
                <label htmlFor="totp" className="block text-sm font-medium text-slate-700">
                  6-digit code
                </label>
                <input
                  id="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            ) : (
              <>
                <div>
                  <label htmlFor="identifier" className="block text-sm font-medium text-slate-700">
                    Phone or email
                  </label>
                  <input
                    id="identifier"
                    autoComplete="username"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {submitting ? 'Please wait…' : needsTotp ? 'Verify' : 'Sign in'}
            </button>
          </form>

          {!needsTotp && (
            <Link to="/forgot-password" className="mt-4 block text-center text-sm text-blue-600">
              Forgot password?
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
