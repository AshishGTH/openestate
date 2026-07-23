import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

export default function ForgotPassword() {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api('/portal/auth/password-reset/request', {
        method: 'POST',
        body: JSON.stringify({ identifier }),
      });
    } finally {
      // Always show the same confirmation regardless of outcome — the
      // backend is deliberately timing- and response-equal whether or not
      // the identifier exists (see CLAUDE.md Phase 6 decisions).
      setSent(true);
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900 text-center">Reset password</h1>

          {sent ? (
            <p className="mt-4 text-sm text-slate-600 text-center">
              If that account exists, a reset link has been sent. Check your phone or email.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
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
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? 'Please wait…' : 'Send reset link'}
              </button>
            </form>
          )}

          <Link to="/login" className="mt-4 block text-center text-sm text-blue-600">
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
