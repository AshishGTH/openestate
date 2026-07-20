import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface CompanyConfigData {
  id: string;
  companyId: string;
  labelOverrides: Record<string, string>;
  enabledModules: string[];
  currency: string;
  timezone: string;
  fyStartMonth: number;
  dateFormat: string;
}

const MODULES = ['presales', 'postsales', 'accounts'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export default function CompanyConfigPage() {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [labels, setLabels] = useState<Record<string, string>>({});
  const [enabledModules, setEnabledModules] = useState<string[]>([]);
  const [currency, setCurrency] = useState('INR');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [fyStartMonth, setFyStartMonth] = useState(4);
  const [dateFormat, setDateFormat] = useState('DD-MM-YYYY');

  const { data: config, isLoading } = useQuery<CompanyConfigData>({
    queryKey: ['company-config'],
    queryFn: () => api('/company/config'),
  });

  useEffect(() => {
    if (config) {
      setLabels(config.labelOverrides ?? {});
      setEnabledModules(config.enabledModules ?? []);
      setCurrency(config.currency);
      setTimezone(config.timezone);
      setFyStartMonth(config.fyStartMonth);
      setDateFormat(config.dateFormat);
    }
  }, [config]);

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      await api('/company/config', {
        method: 'PATCH',
        body: JSON.stringify({
          labelOverrides: labels,
          enabledModules,
          currency,
          timezone,
          fyStartMonth,
          dateFormat,
        }),
      });
      qc.invalidateQueries({ queryKey: ['company-config'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return <div className="text-slate-500">Loading…</div>;
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-slate-900">Company Configuration</h1>

      {error && (
        <div className="mt-4 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-6 space-y-6">
        <section>
          <h2 className="text-lg font-medium text-slate-800">Terminology</h2>
          <p className="text-sm text-slate-500">Customize labels used throughout the application</p>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {['unit', 'project', 'tower', 'floor', 'booking', 'inquiry'].map((key) => (
              <div key={key}>
                <label className="block text-sm font-medium text-slate-700 capitalize">
                  {key}
                </label>
                <input
                  type="text"
                  value={labels[key] ?? ''}
                  onChange={(e) =>
                    setLabels((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-lg font-medium text-slate-800">Modules</h2>
          <div className="mt-3 space-y-2">
            {MODULES.map((mod) => (
              <label key={mod} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabledModules.includes(mod)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setEnabledModules((prev) => [...prev, mod]);
                    } else {
                      setEnabledModules((prev) => prev.filter((m) => m !== mod));
                    }
                  }}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span className="text-sm text-slate-700 capitalize">{mod}</span>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-lg font-medium text-slate-800">Locale</h2>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Currency</label>
              <input
                type="text"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Timezone</label>
              <input
                type="text"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">FY Start Month</label>
              <select
                value={fyStartMonth}
                onChange={(e) => setFyStartMonth(Number(e.target.value))}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                {MONTHS.map((m, i) => (
                  <option key={i} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Date Format</label>
              <select
                value={dateFormat}
                onChange={(e) => setDateFormat(e.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="DD-MM-YYYY">DD-MM-YYYY</option>
                <option value="MM-DD-YYYY">MM-DD-YYYY</option>
                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
              </select>
            </div>
          </div>
        </section>

        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save Configuration'}
        </button>
      </div>
    </div>
  );
}
