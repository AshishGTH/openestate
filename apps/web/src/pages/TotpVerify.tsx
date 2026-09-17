import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { totpVerifySchema, type TotpVerifyDto } from '@openestate/shared';
import { useAuth } from '../lib/auth';

interface Props {
  tempToken: string;
  onBack: () => void;
}

export default function TotpVerify({ tempToken, onBack }: Props) {
  const { verifyTotp } = useAuth();
  const [error, setError] = useState('');
  // Only changes the keyboard and wording: the field accepts either kind of
  // code in either mode. A numeric keypad can't type a recovery code's
  // letters or dash.
  const [recoveryMode, setRecoveryMode] = useState(false);

  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<TotpVerifyDto>({ resolver: zodResolver(totpVerifySchema) });

  const onSubmit = async (data: TotpVerifyDto) => {
    setError('');
    const result = await verifyTotp(tempToken, data.code);
    if (!result.ok) {
      setError(result.error);
    }
  };

  const switchMode = () => {
    setRecoveryMode((on) => !on);
    resetField('code');
    setError('');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm">
        <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900 text-center">Two-Factor Authentication</h1>
          <p className="mt-1 text-sm text-slate-500 text-center">
            {recoveryMode
              ? 'Enter one of your recovery codes (XXXXX-XXXXX)'
              : 'Enter the 6-digit code from your authenticator app'}
          </p>

          {error && (
            <div className="mt-4 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
            <div>
              <label htmlFor="code" className="block text-sm font-medium text-slate-700">
                {recoveryMode ? 'Recovery code' : 'Code'}
              </label>
              <input
                id="code"
                type="text"
                inputMode={recoveryMode ? 'text' : 'numeric'}
                autoComplete={recoveryMode ? 'off' : 'one-time-code'}
                autoCapitalize={recoveryMode ? 'characters' : undefined}
                spellCheck={recoveryMode ? false : undefined}
                {...register('code')}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-center text-lg tracking-widest shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {errors.code && (
                <p className="mt-1 text-xs text-red-600">{errors.code.message}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {isSubmitting ? 'Verifying…' : 'Verify'}
            </button>

            <button
              type="button"
              onClick={switchMode}
              className="w-full text-sm text-blue-600 hover:text-blue-700"
            >
              {recoveryMode ? 'Use your authenticator app instead' : 'Lost your phone? Use a recovery code'}
            </button>

            <button
              type="button"
              onClick={onBack}
              className="w-full text-sm text-slate-500 hover:text-slate-700"
            >
              Back to login
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
