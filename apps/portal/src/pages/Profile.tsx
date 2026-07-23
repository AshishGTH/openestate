import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Applicant {
  id: string;
  name: string;
  primaryPhone: string;
  alternatePhones: string[];
  email: string | null;
}

interface ProfileResponse {
  self: Applicant;
  coApplicants: Applicant[];
}

export default function Profile() {
  const { data, isLoading } = useQuery<ProfileResponse>({
    queryKey: ['portal', 'profile'],
    queryFn: () => api('/portal/profile'),
  });

  if (isLoading) return <div className="text-slate-500 text-sm">Loading…</div>;
  if (!data) return <div className="text-slate-500 text-sm">Could not load your profile.</div>;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">My Details</h1>

      <ApplicantCard applicant={data.self} isSelf />
      {data.coApplicants.map((a) => (
        <ApplicantCard key={a.id} applicant={a} isSelf={false} />
      ))}

      <ChangeRequestForm />
    </div>
  );
}

function ApplicantCard({ applicant, isSelf }: { applicant: Applicant; isSelf: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <span className="font-medium text-slate-900">{applicant.name}</span>
        {isSelf && <span className="text-xs rounded-full bg-blue-50 text-blue-700 px-2 py-0.5">You</span>}
        {!isSelf && <span className="text-xs rounded-full bg-slate-100 text-slate-600 px-2 py-0.5">Co-applicant</span>}
      </div>
      <dl className="mt-2 text-sm text-slate-600 space-y-1">
        <div className="flex justify-between">
          <dt>Phone</dt>
          <dd>{applicant.primaryPhone}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Email</dt>
          <dd>{applicant.email ?? '—'}</dd>
        </div>
        {applicant.alternatePhones.length > 0 && (
          <div className="flex justify-between">
            <dt>Alt. phones</dt>
            <dd>{applicant.alternatePhones.join(', ')}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function ChangeRequestForm() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sent' | 'error'>('idle');

  const mutation = useMutation({
    mutationFn: () => api('/portal/profile/change-requests', { method: 'POST', body: JSON.stringify({ email }) }),
    onSuccess: () => {
      setStatus('sent');
      setEmail('');
      qc.invalidateQueries({ queryKey: ['portal', 'profile'] });
    },
    onError: () => setStatus('error'),
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-medium text-slate-900">Request an update</h2>
      <p className="mt-1 text-xs text-slate-500">
        Changes go to our team for approval — nothing updates immediately.
      </p>

      {status === 'sent' && (
        <div className="mt-3 rounded-md bg-green-50 border border-green-200 p-2.5 text-sm text-green-700">
          Request submitted. We&apos;ll review it shortly.
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setStatus('idle');
          if (email.trim()) mutation.mutate();
        }}
        className="mt-3 flex gap-2"
      >
        <input
          type="email"
          placeholder="New email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={mutation.isPending || !email.trim()}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Submit
        </button>
      </form>
    </div>
  );
}
