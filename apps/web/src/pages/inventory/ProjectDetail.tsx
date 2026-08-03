import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/hooks';

interface Project {
  id: string;
  name: string;
  code: string;
  reraNumber: string | null;
}

interface Tower {
  id: string;
  name: string;
  code: string;
  totalFloors: number;
}

interface Unit {
  id: string;
  number: string;
  status: string;
  baseRatePaise: string;
  carpetAreaSqft: string | null;
}

interface RateRevision {
  id: string;
  ratePaise: string;
  effectiveFrom: string;
  reason: string | null;
}

interface MasterOption {
  id: string;
  name: string;
}

const rupees = (paise: string | number) => `₹${(Number(paise) / 100).toLocaleString('en-IN')}`;

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [showTowerForm, setShowTowerForm] = useState(false);
  const [towerName, setTowerName] = useState('');
  const [towerCode, setTowerCode] = useState('');
  const [towerFloors, setTowerFloors] = useState('1');
  const [towerError, setTowerError] = useState('');

  const [showBulkForm, setShowBulkForm] = useState(false);
  const [bulkTowerId, setBulkTowerId] = useState('');
  const [floorStart, setFloorStart] = useState('1');
  const [floorEnd, setFloorEnd] = useState('1');
  const [unitsPerFloor, setUnitsPerFloor] = useState('4');
  const [unitPrefix, setUnitPrefix] = useState('');
  const [unitTypeId, setUnitTypeId] = useState('');
  const [carpetAreaSqft, setCarpetAreaSqft] = useState('');
  const [baseRateRupees, setBaseRateRupees] = useState('');
  const [bulkError, setBulkError] = useState('');

  const [selectedTowerFilter, setSelectedTowerFilter] = useState('');
  const [selectedUnitIds, setSelectedUnitIds] = useState<Set<string>>(new Set());
  const [revisionRateRupees, setRevisionRateRupees] = useState('');
  const [revisionEffectiveFrom, setRevisionEffectiveFrom] = useState('');
  const [revisionReason, setRevisionReason] = useState('');
  const [revisionError, setRevisionError] = useState('');

  const [historyUnitId, setHistoryUnitId] = useState<string | null>(null);

  const { data: project } = useQuery<Project>({
    queryKey: ['project', id],
    queryFn: () => api(`/projects/${id}`),
    enabled: !!id,
  });

  const { data: towersRes } = useQuery<{ data: Tower[] }>({
    queryKey: ['towers', id],
    queryFn: () => api(`/projects/${id}/towers?page=1&limit=100`),
    enabled: !!id,
  });
  const towers = towersRes?.data;

  const { data: unitTypes } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'unit-types', 'all'],
    queryFn: () => api('/masters/unit-types?limit=100'),
  });

  const { data: units, isLoading: unitsLoading } = useQuery<{ data: Unit[] }>({
    queryKey: ['units', id, selectedTowerFilter],
    queryFn: () =>
      api(`/projects/${id}/units?page=1&limit=100${selectedTowerFilter ? `&towerId=${selectedTowerFilter}` : ''}`),
    enabled: !!id,
  });

  const { data: rateHistory } = useQuery<{ data: RateRevision[] }>({
    queryKey: ['rate-history', id, historyUnitId],
    queryFn: () => api(`/projects/${id}/units/${historyUnitId}/rate-history?page=1&limit=50`),
    enabled: !!id && !!historyUnitId,
  });

  const createTowerMutation = useApiMutation<Tower, Record<string, unknown>>(
    'POST',
    `/projects/${id}/towers`,
    [['towers', id ?? '']],
  );

  const handleCreateTower = async () => {
    setTowerError('');
    try {
      await createTowerMutation.mutateAsync({ name: towerName, code: towerCode, totalFloors: Number(towerFloors) });
      setShowTowerForm(false);
      setTowerName('');
      setTowerCode('');
      setTowerFloors('1');
    } catch (err) {
      setTowerError((err as Error).message);
    }
  };

  const handleBulkGenerate = async () => {
    setBulkError('');
    try {
      const body: Record<string, unknown> = {
        towerId: bulkTowerId,
        floorStart: Number(floorStart),
        floorEnd: Number(floorEnd),
        unitsPerFloor: Number(unitsPerFloor),
        unitPrefix,
        baseRatePaise: baseRateRupees.trim() === '' ? undefined : String(Math.round(Number(baseRateRupees) * 100)),
        unitTypeId: unitTypeId === '' ? undefined : unitTypeId,
        carpetAreaSqft: carpetAreaSqft.trim() === '' ? undefined : Number(carpetAreaSqft),
      };
      await api(`/projects/${id}/units/bulk-generate`, { method: 'POST', body: JSON.stringify(body) });
      qc.invalidateQueries({ queryKey: ['units', id] });
      setShowBulkForm(false);
    } catch (err) {
      setBulkError((err as Error).message);
    }
  };

  const toggleUnit = (unitId: string) => {
    setSelectedUnitIds((prev) => {
      const next = new Set(prev);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      return next;
    });
  };

  const handleRateRevision = async () => {
    setRevisionError('');
    try {
      await api(`/projects/${id}/units/change-rate`, {
        method: 'POST',
        body: JSON.stringify({
          unitIds: Array.from(selectedUnitIds),
          ratePaise: String(Math.round(Number(revisionRateRupees) * 100)),
          effectiveFrom: revisionEffectiveFrom,
          reason: revisionReason,
        }),
      });
      qc.invalidateQueries({ queryKey: ['units', id] });
      setSelectedUnitIds(new Set());
      setRevisionRateRupees('');
      setRevisionEffectiveFrom('');
      setRevisionReason('');
    } catch (err) {
      setRevisionError((err as Error).message);
    }
  };

  if (!project) return <div className="text-slate-500">Loading…</div>;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">{project.name}</h1>
      <p className="text-sm text-slate-500">
        Code: {project.code} {project.reraNumber && <>· RERA: {project.reraNumber}</>}
      </p>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-slate-800">Towers</h2>
          <button onClick={() => setShowTowerForm(true)} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
            Add Tower
          </button>
        </div>
        {showTowerForm && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700">Name</label>
                <input type="text" value={towerName} onChange={(e) => setTowerName(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Code</label>
                <input type="text" value={towerCode} onChange={(e) => setTowerCode(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Total Floors</label>
                <input type="number" value={towerFloors} onChange={(e) => setTowerFloors(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="mt-3 flex gap-3">
              <button onClick={handleCreateTower} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Create</button>
              <button onClick={() => setShowTowerForm(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            </div>
            {towerError && <p className="mt-2 text-sm text-red-600">{towerError}</p>}
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {towers?.map((t) => (
            <span key={t.id} className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">
              {t.name} ({t.code}) — {t.totalFloors} floors
            </span>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-slate-800">Units</h2>
          <button onClick={() => setShowBulkForm(true)} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
            Bulk-Generate Units
          </button>
        </div>

        {showBulkForm && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700">Tower</label>
                <select value={bulkTowerId} onChange={(e) => setBulkTowerId(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                  <option value="">Select…</option>
                  {towers?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Floor Start</label>
                <input type="number" value={floorStart} onChange={(e) => setFloorStart(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Floor End</label>
                <input type="number" value={floorEnd} onChange={(e) => setFloorEnd(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Units Per Floor</label>
                <input type="number" value={unitsPerFloor} onChange={(e) => setUnitsPerFloor(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Unit Prefix</label>
                <input type="text" value={unitPrefix} onChange={(e) => setUnitPrefix(e.target.value)} placeholder="e.g. A-" className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Unit Type</label>
                <select value={unitTypeId} onChange={(e) => setUnitTypeId(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                  <option value="">Select…</option>
                  {unitTypes?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Carpet Area (sqft)</label>
                <input type="number" value={carpetAreaSqft} onChange={(e) => setCarpetAreaSqft(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Base Rate (₹)</label>
                <input type="number" value={baseRateRupees} onChange={(e) => setBaseRateRupees(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="mt-3 flex gap-3">
              <button onClick={handleBulkGenerate} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Generate</button>
              <button onClick={() => setShowBulkForm(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            </div>
            {bulkError && <p className="mt-2 text-sm text-red-600">{bulkError}</p>}
          </div>
        )}

        <div className="mt-3 flex items-center gap-3">
          <label className="text-sm font-medium text-slate-700">Filter by Tower</label>
          <select value={selectedTowerFilter} onChange={(e) => setSelectedTowerFilter(e.target.value)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">
            <option value="">All towers</option>
            {towers?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3"></th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Unit Number</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Rate</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Carpet Area</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {unitsLoading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">Loading…</td></tr>
              ) : (units?.data ?? []).length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">No units yet</td></tr>
              ) : (
                units!.data.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selectedUnitIds.has(u.id)} onChange={() => toggleUnit(u.id)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-700">{u.number}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{u.status}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{rupees(u.baseRatePaise)}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{u.carpetAreaSqft ?? '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setHistoryUnitId(u.id)} className="text-blue-600 hover:text-blue-800 text-xs">
                        Rate History
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {selectedUnitIds.size > 0 && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-medium text-slate-800">
              Apply Rate Revision to {selectedUnitIds.size} selected unit{selectedUnitIds.size === 1 ? '' : 's'}
            </h3>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700">New Rate (₹)</label>
                <input type="number" value={revisionRateRupees} onChange={(e) => setRevisionRateRupees(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Effective From</label>
                <input type="date" value={revisionEffectiveFrom} onChange={(e) => setRevisionEffectiveFrom(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Reason</label>
                <input type="text" value={revisionReason} onChange={(e) => setRevisionReason(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="mt-3">
              <button onClick={handleRateRevision} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                Apply Revision
              </button>
            </div>
            {revisionError && <p className="mt-2 text-sm text-red-600">{revisionError}</p>}
          </div>
        )}

        {historyUnitId && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-800">Rate History</h3>
              <button onClick={() => setHistoryUnitId(null)} className="text-xs text-slate-500 hover:text-slate-700">Close</button>
            </div>
            <ul className="mt-2 space-y-1 text-sm text-slate-700">
              {(rateHistory?.data ?? []).length === 0 ? (
                <li className="text-slate-500">No rate revisions yet</li>
              ) : (
                rateHistory!.data.map((r) => (
                  <li key={r.id}>
                    {rupees(r.ratePaise)} effective {new Date(r.effectiveFrom).toLocaleDateString()}
                    {r.reason && <> — {r.reason}</>}
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
