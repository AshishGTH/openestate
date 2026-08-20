import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatInr } from '@openestate/shared';
import { api } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';

interface Installment {
  id: string;
  seq: number;
  label: string;
  /** Null for an unraised STAGE_LINKED installment — see
   * docs/plans/construction-linked-demand-fix.md §2. */
  dueDate: string | null;
  amountPaise: string;
  allocatedPaise: string;
  status: string;
}

interface PlanVersion {
  id: string;
  name: string;
  version: number;
  isActive: boolean;
  isCustom: boolean;
  createdAt: string;
  installments: Installment[];
}

interface BookingRow {
  brokerId: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  PAID: 'bg-emerald-50 text-emerald-700',
  PARTIAL: 'bg-amber-50 text-amber-700',
  UNPAID: 'bg-slate-100 text-slate-600',
};

export default function InstallmentSchedule() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const [showHistory, setShowHistory] = useState(false);

  const { data: versions, isLoading } = useQuery<PlanVersion[]>({
    queryKey: ['plan-history', bookingId],
    queryFn: () => api(`/bookings/${bookingId}/plan-history`),
    enabled: !!bookingId,
  });

  const { data: booking } = useQuery<BookingRow>({
    queryKey: ['booking', bookingId],
    queryFn: () => api(`/bookings/${bookingId}`),
    enabled: !!bookingId,
  });

  const [accruing, setAccruing] = useState(false);
  const [accrueMessage, setAccrueMessage] = useState('');

  async function accrueCommission() {
    setAccruing(true);
    setAccrueMessage('');
    try {
      await api(`/bookings/${bookingId}/commission/accrue`, { method: 'POST' });
      setAccrueMessage('Commission accrued.');
    } catch (err) {
      setAccrueMessage((err as Error).message);
    } finally {
      setAccruing(false);
    }
  }

  const active = versions?.find((v) => v.isActive) ?? versions?.[0];
  const dues = (active?.installments ?? []).reduce(
    (sum, i) => sum + (BigInt(i.amountPaise) - BigInt(i.allocatedPaise)),
    0n,
  );

  const columns: Column<Installment>[] = [
    { key: 'seq', header: '#', render: (i) => i.seq },
    { key: 'label', header: 'Installment', render: (i) => i.label },
    {
      key: 'dueDate',
      header: 'Due Date',
      // new Date(null) silently resolves to 1970-01-01 in JavaScript — it
      // does NOT throw — so this branch is not defensive decoration, it's
      // the actual fix. See docs/plans/construction-linked-demand-fix.md
      // §2, consumer #10.
      render: (i) =>
        i.dueDate ? (
          new Date(i.dueDate).toLocaleDateString('en-IN')
        ) : (
          <span className="italic text-slate-400">Not yet due — awaiting stage completion</span>
        ),
    },
    { key: 'amount', header: 'Amount', className: 'text-right', render: (i) => formatInr(BigInt(i.amountPaise)) },
    { key: 'allocated', header: 'Received', className: 'text-right', render: (i) => formatInr(BigInt(i.allocatedPaise)) },
    {
      key: 'due',
      header: 'Due',
      className: 'text-right',
      render: (i) => formatInr(BigInt(i.amountPaise) - BigInt(i.allocatedPaise)),
    },
    {
      key: 'status',
      header: 'Status',
      render: (i) => (
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[i.status] ?? ''}`}>
          {i.status}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Installment Schedule</h1>
        {versions && versions.length > 1 && (
          <button
            onClick={() => setShowHistory((s) => !s)}
            className="text-sm font-medium text-blue-600 hover:text-blue-800"
          >
            {showHistory ? 'Hide' : 'Show'} plan version history ({versions.length})
          </button>
        )}
      </div>

      {active && (
        <div className="mt-2 flex gap-6 text-sm text-slate-600">
          <span>Plan: <strong>{active.name}</strong> (v{active.version})</span>
          <span>Total due: <strong className={dues > 0n ? 'text-red-600' : 'text-emerald-600'}>{formatInr(dues)}</strong></span>
        </div>
      )}

      {booking?.brokerId && (
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={accrueCommission}
            disabled={accruing}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {accruing ? 'Accruing…' : 'Accrue Broker Commission'}
          </button>
          {accrueMessage && <span className="text-sm text-slate-600">{accrueMessage}</span>}
        </div>
      )}

      <div className="mt-4">
        <DataTable
          columns={columns}
          data={active?.installments ?? []}
          isLoading={isLoading}
          emptyText="No payment plan created yet for this booking."
        />
      </div>

      {showHistory && versions && versions.length > 1 && (
        <div className="mt-6 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900">Earlier versions</h2>
          {versions
            .filter((v) => v.id !== active?.id)
            .map((v) => (
              <div key={v.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-sm text-slate-600">
                  {v.name} (v{v.version}) — created {new Date(v.createdAt).toLocaleString()}
                </div>
                <DataTable columns={columns} data={v.installments} />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
