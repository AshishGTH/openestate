import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, downloadFile } from '../../lib/api';
import { useApiMutation } from '../../lib/hooks';
import { CustomFieldDisplay, useCustomFieldDefinitions } from '../../components/CustomFieldInputs';

interface Project {
  id: string;
  name: string;
  code: string;
  reraNumber: string | null;
  customFields?: Record<string, unknown> | null;
}

interface Tower {
  id: string;
  name: string;
  code: string;
  /**
   * Planned floor count, captured once on the Add Tower form and never
   * updated afterwards — bulk-generating units creates real Floor rows
   * without touching it. Kept because it IS the admin's stated intent
   * at creation, but never rendered as if it were the actual count.
   */
  totalFloors: number;
  /** Real floor count, computed by the API (`_count: { floors: true }`). */
  _count?: { floors: number };
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

interface UnitPlc {
  id: string;
  amountPaise: string;
  percentage: string | null;
  plcType: MasterOption;
}

interface UnitCharge {
  id: string;
  amountPaise: string;
  chargeType: MasterOption;
}

interface ProjectMediaItem {
  id: string;
  category: string;
  originalName: string;
}

const rupees = (paise: string | number) => `₹${(Number(paise) / 100).toLocaleString('en-IN')}`;

const MEDIA_CATEGORY_LABELS: Record<string, string> = {
  layout_plan: 'Layout Plan',
  brochure: 'Brochure',
  photo: 'Photo',
};

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

  const [pricingUnitId, setPricingUnitId] = useState<string | null>(null);
  const [newPlcTypeId, setNewPlcTypeId] = useState('');
  const [newPlcPercentage, setNewPlcPercentage] = useState('');
  const [newChargeTypeId, setNewChargeTypeId] = useState('');
  const [newChargeAmountRupees, setNewChargeAmountRupees] = useState('');
  const [pricingError, setPricingError] = useState('');

  const [mediaCategory, setMediaCategory] = useState<'layout_plan' | 'brochure' | 'photo'>('layout_plan');
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaError, setMediaError] = useState('');

  const { data: project } = useQuery<Project>({
    queryKey: ['project', id],
    queryFn: () => api(`/projects/${id}`),
    enabled: !!id,
  });
  const { definitions: projectDefs } = useCustomFieldDefinitions('PROJECT');

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

  const { data: plcTypes } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'plc-types', 'all'],
    queryFn: () => api('/masters/plc-types?limit=100'),
  });
  const { data: chargeTypes } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'charge-types', 'all'],
    queryFn: () => api('/masters/charge-types?limit=100'),
  });
  const { data: unitPlcs } = useQuery<UnitPlc[]>({
    queryKey: ['unit-plcs', id, pricingUnitId],
    queryFn: () => api(`/projects/${id}/units/${pricingUnitId}/plcs`),
    enabled: !!id && !!pricingUnitId,
  });
  const { data: unitCharges } = useQuery<UnitCharge[]>({
    queryKey: ['unit-charges', id, pricingUnitId],
    queryFn: () => api(`/projects/${id}/units/${pricingUnitId}/charges`),
    enabled: !!id && !!pricingUnitId,
  });

  const { data: projectMedia } = useQuery<ProjectMediaItem[]>({
    queryKey: ['project-media', id],
    queryFn: () => api(`/projects/${id}/media`),
    enabled: !!id,
  });

  const addPlcMutation = useApiMutation<UnitPlc, Record<string, unknown>>(
    'POST',
    `/projects/${id}/units/${pricingUnitId}/plcs`,
    [['unit-plcs', id ?? '', pricingUnitId ?? '']],
  );
  const removePlcMutation = useApiMutation<unknown, { plcId: string }>(
    'DELETE',
    (body) => `/projects/${id}/units/${pricingUnitId}/plcs/${body.plcId}`,
    [['unit-plcs', id ?? '', pricingUnitId ?? '']],
  );
  const addChargeMutation = useApiMutation<UnitCharge, Record<string, unknown>>(
    'POST',
    `/projects/${id}/units/${pricingUnitId}/charges`,
    [['unit-charges', id ?? '', pricingUnitId ?? '']],
  );
  const removeChargeMutation = useApiMutation<unknown, { chargeId: string }>(
    'DELETE',
    (body) => `/projects/${id}/units/${pricingUnitId}/charges/${body.chargeId}`,
    [['unit-charges', id ?? '', pricingUnitId ?? '']],
  );

  const handleAddPlc = async () => {
    setPricingError('');
    try {
      await addPlcMutation.mutateAsync({ plcTypeId: newPlcTypeId, percentage: Number(newPlcPercentage) });
      setNewPlcTypeId('');
      setNewPlcPercentage('');
    } catch (err) {
      setPricingError((err as Error).message);
    }
  };

  const handleAddCharge = async () => {
    setPricingError('');
    try {
      await addChargeMutation.mutateAsync({
        chargeTypeId: newChargeTypeId,
        amountPaise: String(Math.round(Number(newChargeAmountRupees) * 100)),
      });
      setNewChargeTypeId('');
      setNewChargeAmountRupees('');
    } catch (err) {
      setPricingError((err as Error).message);
    }
  };

  const handleUploadMedia = async () => {
    setMediaError('');
    if (!mediaFile) {
      setMediaError('Choose a file first');
      return;
    }
    try {
      const formData = new FormData();
      formData.append('category', mediaCategory);
      formData.append('file', mediaFile);
      await api(`/projects/${id}/media`, { method: 'POST', body: formData });
      setMediaFile(null);
      qc.invalidateQueries({ queryKey: ['project-media', id] });
    } catch (err) {
      setMediaError((err as Error).message);
    }
  };

  const handleDeleteMedia = async (mediaId: string) => {
    await api(`/projects/${id}/media/${mediaId}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['project-media', id] });
  };

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
      <CustomFieldDisplay definitions={projectDefs} values={project.customFields} />

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
              {t.name} ({t.code}) — {t._count?.floors ?? 0} floors
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
                    <td className="px-4 py-3 text-right space-x-3">
                      <button onClick={() => setHistoryUnitId(u.id)} className="text-blue-600 hover:text-blue-800 text-xs">
                        Rate History
                      </button>
                      <button onClick={() => setPricingUnitId(u.id)} className="text-blue-600 hover:text-blue-800 text-xs">
                        Pricing
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

        {pricingUnitId && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-800">Pricing — PLCs and extra charges</h3>
              <button onClick={() => setPricingUnitId(null)} className="text-xs text-slate-500 hover:text-slate-700">Close</button>
            </div>
            {pricingError && <p className="mt-2 text-sm text-red-600">{pricingError}</p>}

            <div className="mt-3">
              <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">PLCs</h4>
              <ul className="mt-1 space-y-1 text-sm text-slate-700">
                {(unitPlcs ?? []).length === 0 ? (
                  <li className="text-slate-500">None assigned</li>
                ) : (
                  unitPlcs!.map((p) => (
                    <li key={p.id} className="flex items-center justify-between">
                      <span>
                        {p.plcType.name} — {rupees(p.amountPaise)}
                        {p.percentage && ` (${p.percentage}%)`}
                      </span>
                      <button
                        onClick={() => removePlcMutation.mutate({ plcId: p.id })}
                        className="text-xs text-red-600 hover:text-red-800"
                      >
                        Remove
                      </button>
                    </li>
                  ))
                )}
              </ul>
              <div className="mt-2 flex items-end gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700">PLC Type</label>
                  <select value={newPlcTypeId} onChange={(e) => setNewPlcTypeId(e.target.value)} className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                    <option value="">Select…</option>
                    {plcTypes?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Percentage of base rate</label>
                  <input type="number" value={newPlcPercentage} onChange={(e) => setNewPlcPercentage(e.target.value)} className="mt-1 w-28 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                </div>
                <button onClick={handleAddPlc} disabled={!newPlcTypeId || !newPlcPercentage} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  Add PLC
                </button>
              </div>
            </div>

            <div className="mt-4">
              <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">Extra charges</h4>
              <ul className="mt-1 space-y-1 text-sm text-slate-700">
                {(unitCharges ?? []).length === 0 ? (
                  <li className="text-slate-500">None assigned</li>
                ) : (
                  unitCharges!.map((c) => (
                    <li key={c.id} className="flex items-center justify-between">
                      <span>{c.chargeType.name} — {rupees(c.amountPaise)}</span>
                      <button
                        onClick={() => removeChargeMutation.mutate({ chargeId: c.id })}
                        className="text-xs text-red-600 hover:text-red-800"
                      >
                        Remove
                      </button>
                    </li>
                  ))
                )}
              </ul>
              <div className="mt-2 flex items-end gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Charge Type</label>
                  <select value={newChargeTypeId} onChange={(e) => setNewChargeTypeId(e.target.value)} className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                    <option value="">Select…</option>
                    {chargeTypes?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Amount (₹)</label>
                  <input type="number" value={newChargeAmountRupees} onChange={(e) => setNewChargeAmountRupees(e.target.value)} className="mt-1 w-28 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                </div>
                <button onClick={handleAddCharge} disabled={!newChargeTypeId || !newChargeAmountRupees} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  Add Charge
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-medium text-slate-800">Media</h2>
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
          <ul className="space-y-1 text-sm text-slate-700">
            {(projectMedia ?? []).length === 0 ? (
              <li className="text-slate-500">No layout plans, brochures, or photos yet</li>
            ) : (
              projectMedia!.map((m) => (
                <li key={m.id} className="flex items-center justify-between">
                  <span>
                    <span className="mr-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {MEDIA_CATEGORY_LABELS[m.category] ?? m.category}
                    </span>
                    {m.originalName}
                  </span>
                  <span className="space-x-3">
                    <button
                      onClick={() => downloadFile(`/projects/${id}/media/${m.id}/download`, m.originalName)}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      Download
                    </button>
                    <button onClick={() => handleDeleteMedia(m.id)} className="text-xs text-red-600 hover:text-red-800">
                      Delete
                    </button>
                  </span>
                </li>
              ))
            )}
          </ul>
          <div className="mt-3 flex items-end gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-700">Category</label>
              <select
                value={mediaCategory}
                onChange={(e) => setMediaCategory(e.target.value as typeof mediaCategory)}
                className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                <option value="layout_plan">Layout Plan</option>
                <option value="brochure">Brochure</option>
                <option value="photo">Photo</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">File</label>
              <input type="file" onChange={(e) => setMediaFile(e.target.files?.[0] ?? null)} className="mt-1 block text-sm" />
            </div>
            <button
              onClick={handleUploadMedia}
              disabled={!mediaFile}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Upload
            </button>
          </div>
          {mediaError && <p className="mt-2 text-sm text-red-600">{mediaError}</p>}
        </div>
      </section>
    </div>
  );
}
