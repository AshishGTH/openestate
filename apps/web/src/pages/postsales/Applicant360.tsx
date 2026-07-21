import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatInr } from '@openestate/shared';
import { api, downloadFile } from '../../lib/api';

interface Applicant {
  id: string;
  name: string;
  primaryPhone: string;
  email: string | null;
  city: string | null;
}

interface Booking {
  id: string;
  bookingNumber: string;
  status: string;
  agreedPricePaise: string;
  unit: { number: string; floor: { name: string; tower: { name: string } } };
}

interface FollowUp {
  id: string;
  notes: string | null;
  outcome: string | null;
  scheduledAt: string | null;
  createdAt: string;
}

interface Inquiry {
  id: string;
  status: string;
  createdAt: string;
  followUps: FollowUp[];
}

interface GeneratedDoc {
  id: string;
  documentType: string;
  originalName: string;
  isDuplicate: boolean;
  createdAt: string;
}

interface Dispatch {
  id: string;
  channel: string;
  recipientAddress: string;
  status: string;
  createdAt: string;
}

interface ThreeSixty {
  applicant: Applicant;
  bookings: Booking[];
  inquiries: Inquiry[];
  documents: GeneratedDoc[];
  dispatches: Dispatch[];
}

interface LedgerEntry {
  id: string;
  entryType: string;
  effectiveDate: string;
  reason: string | null;
  signedAmountPaise: string;
  runningBalancePaise: string;
}

interface LedgerReport {
  bookingNumber: string;
  entries: LedgerEntry[];
  balancePaise: string;
}

export default function Applicant360() {
  const { applicantId } = useParams<{ applicantId: string }>();
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<ThreeSixty>({
    queryKey: ['applicant-360', applicantId],
    queryFn: () => api(`/applicants/${applicantId}/360`),
    enabled: !!applicantId,
  });

  const bookingId = selectedBookingId ?? data?.bookings?.[0]?.id ?? null;

  const { data: ledger } = useQuery<LedgerReport>({
    queryKey: ['applicant-ledger', bookingId],
    queryFn: () => api(`/reports/postsales/applicant-ledger/${bookingId}`),
    enabled: !!bookingId,
  });

  if (isLoading || !data) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }

  const { applicant, bookings, inquiries, documents, dispatches } = data;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">{applicant.name}</h1>
      <div className="mt-1 flex gap-4 text-sm text-slate-600">
        <span>{applicant.primaryPhone}</span>
        {applicant.email && <span>{applicant.email}</span>}
        {applicant.city && <span>{applicant.city}</span>}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Bookings</h2>
          <ul className="mt-2 space-y-1">
            {bookings.length === 0 && <li className="text-xs text-slate-500">No bookings.</li>}
            {bookings.map((b) => (
              <li key={b.id}>
                <button
                  onClick={() => setSelectedBookingId(b.id)}
                  className={`block w-full rounded-md px-3 py-2 text-left text-sm ${
                    bookingId === b.id ? 'bg-blue-50 text-blue-900' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="font-medium">{b.bookingNumber} — {b.status}</div>
                  <div className="text-xs text-slate-500">
                    {b.unit.floor.tower.name}/{b.unit.floor.name}/{b.unit.number} · {formatInr(BigInt(b.agreedPricePaise))}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">
            Ledger {ledger && `— ${ledger.bookingNumber} (balance ${formatInr(BigInt(ledger.balancePaise))})`}
          </h2>
          <div className="mt-2 max-h-64 overflow-y-auto">
            {!ledger || ledger.entries.length === 0 ? (
              <p className="text-xs text-slate-500">No ledger entries.</p>
            ) : (
              <table className="min-w-full text-xs">
                <tbody className="divide-y divide-slate-100">
                  {ledger.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="py-1 pr-2 text-slate-500">{e.effectiveDate}</td>
                      <td className="py-1 pr-2 font-medium text-slate-700">{e.entryType}</td>
                      <td className="py-1 pr-2 text-slate-500">{e.reason ?? ''}</td>
                      <td className={`py-1 text-right ${BigInt(e.signedAmountPaise) < 0n ? 'text-emerald-600' : 'text-slate-700'}`}>
                        {formatInr(BigInt(e.signedAmountPaise))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Follow-up & inquiry timeline</h2>
          <ul className="mt-2 space-y-3">
            {inquiries.length === 0 && <li className="text-xs text-slate-500">No inquiries.</li>}
            {inquiries.map((inq) => (
              <li key={inq.id}>
                <div className="text-xs font-medium text-slate-700">
                  Inquiry — {inq.status} ({new Date(inq.createdAt).toLocaleDateString('en-IN')})
                </div>
                <ul className="ml-3 mt-1 space-y-1 border-l border-slate-200 pl-3">
                  {inq.followUps.map((f) => (
                    <li key={f.id} className="text-xs text-slate-500">
                      {new Date(f.createdAt).toLocaleDateString('en-IN')} — {f.outcome ?? 'pending'} {f.notes && `— ${f.notes}`}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Documents & dispatch history</h2>
          <ul className="mt-2 space-y-1">
            {documents.length === 0 && <li className="text-xs text-slate-500">No generated documents.</li>}
            {documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between text-xs">
                <span>
                  {d.documentType} {d.isDuplicate && <span className="text-red-600">(DUPLICATE)</span>} — {new Date(d.createdAt).toLocaleDateString('en-IN')}
                </span>
                <button
                  onClick={() => downloadFile(`/documents/${d.id}/download`, d.originalName)}
                  className="font-medium text-blue-600 hover:text-blue-800"
                >
                  Download
                </button>
              </li>
            ))}
          </ul>
          <h3 className="mt-3 text-xs font-semibold text-slate-700">Dispatch history</h3>
          <ul className="mt-1 space-y-1">
            {dispatches.length === 0 && <li className="text-xs text-slate-500">No dispatches.</li>}
            {dispatches.map((d) => (
              <li key={d.id} className="text-xs text-slate-500">
                {d.channel} to {d.recipientAddress} — {d.status} ({new Date(d.createdAt).toLocaleDateString('en-IN')})
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
