import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Dashboard {
  brokerName: string;
  commission: {
    accruedFormatted: string;
    paidFormatted: string;
    tdsFormatted: string;
    clawedBackFormatted: string;
    outstandingFormatted: string;
  };
  soldUnitsCount: number;
  pendingNocCount: number;
}

export default function BrokerDashboard() {
  const { data, isLoading } = useQuery<Dashboard>({
    queryKey: ['portal', 'broker', 'dashboard'],
    queryFn: () => api('/portal/broker/dashboard'),
  });

  if (isLoading) return <div className="text-slate-500 text-sm">Loading…</div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">{data.brokerName}</h1>

      <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
        <h2 className="font-medium text-slate-900">Commission</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-slate-500">Accrued</div>
            <div className="font-medium text-slate-900">{data.commission.accruedFormatted}</div>
          </div>
          <div>
            <div className="text-slate-500">Paid</div>
            <div className="font-medium text-slate-900">{data.commission.paidFormatted}</div>
          </div>
          <div>
            <div className="text-slate-500">TDS withheld</div>
            <div className="font-medium text-slate-900">{data.commission.tdsFormatted}</div>
          </div>
          <div>
            <div className="text-slate-500">Clawed back</div>
            <div className="font-medium text-slate-900">{data.commission.clawedBackFormatted}</div>
          </div>
        </div>
        <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
          <span className="text-slate-700 font-medium">Outstanding</span>
          <span className="text-slate-900 font-semibold">{data.commission.outstandingFormatted}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
          <div className="text-2xl font-semibold text-slate-900">{data.soldUnitsCount}</div>
          <div className="text-xs text-slate-500 mt-1">Units sold</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
          <div className="text-2xl font-semibold text-slate-900">{data.pendingNocCount}</div>
          <div className="text-xs text-slate-500 mt-1">Pending NOCs</div>
        </div>
      </div>
    </div>
  );
}
