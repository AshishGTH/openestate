import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatInr } from '@openestate/shared';
import { api } from '../../lib/api';

interface ApplicantRow {
  id: string;
  name: string;
  primaryPhone: string;
  email: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  code: string;
}

interface UnitRow {
  id: string;
  number: string;
  baseRatePaise: string;
  status: string;
  // null for a LAND_BASED unit (Phase A) — every read must check it, not
  // assume it, per plotted-farmhouse-inventory.md §13.1.
  floor: { name: string; tower: { name: string } } | null;
}

function unitLabel(u: UnitRow): string {
  return u.floor ? `${u.floor.tower.name} / ${u.floor.name} / ${u.number}` : u.number;
}

// The generic master-factory list endpoint returns plain PaymentPlanTemplate
// rows with no relations included (it's shared across 15 master models with
// no per-model include config), so milestones are deliberately not modeled
// here — the wizard only needs the template's id/name to instantiate a plan
// server-side via /bookings/:id/plan/from-template.
interface PlanTemplateRow {
  id: string;
  name: string;
  description: string | null;
}

interface CustomInstallmentRow {
  label: string;
  dueDate: string;
  amountPaise: string;
}

interface BrokerRow {
  id: string;
  name: string;
}

interface UnitPlcRow {
  id: string;
  amountPaise: string;
  plcType: { id: string; name: string };
}

interface UnitChargeRow {
  id: string;
  amountPaise: string;
  chargeType: { id: string; name: string };
}

interface GstRateRow {
  id: string;
  rate: string;
  description: string;
  isActive: boolean;
}

interface DraftData {
  step: number;
  primaryApplicantId?: string;
  primaryApplicantName?: string;
  coApplicantIds: string[];
  coApplicantNames: string[];
  projectId?: string;
  unitId?: string;
  unitLabel?: string;
  bookingDate: string;
  basePricePaise: string;
  planMode: 'template' | 'custom';
  paymentPlanTemplateId?: string;
  customInstallments: CustomInstallmentRow[];
  brokerId?: string;
  gstRateId?: string;
}

interface BookingDraftRecord {
  id: string;
  label: string | null;
  draftData: DraftData;
  updatedAt: string;
}

const STEPS = ['Applicant', 'Unit', 'Co-applicants', 'Payment plan', 'Confirm'];

function emptyDraft(): DraftData {
  return {
    step: 0,
    coApplicantIds: [],
    coApplicantNames: [],
    bookingDate: new Date().toISOString().slice(0, 10),
    basePricePaise: '',
    planMode: 'template',
    customInstallments: [],
  };
}

function ApplicantSearch({
  onPick,
  excludeIds = [],
}: {
  onPick: (a: ApplicantRow) => void;
  excludeIds?: string[];
}) {
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newPan, setNewPan] = useState('');
  const [createError, setCreateError] = useState('');

  const { data, isFetching } = useQuery<{ data: ApplicantRow[] }>({
    queryKey: ['applicant-search', search],
    queryFn: () => api(`/applicants?search=${encodeURIComponent(search)}&limit=10`),
    enabled: search.length >= 2,
  });

  const results = (data?.data ?? []).filter((a) => !excludeIds.includes(a.id));

  const createApplicant = async () => {
    setCreateError('');
    try {
      const res = await api<{ applicant: ApplicantRow } | ApplicantRow>('/applicants', {
        method: 'POST',
        body: JSON.stringify({
          name: newName,
          primaryPhone: newPhone,
          alternatePhones: [],
          ...(newPan ? { pan: newPan } : {}),
        }),
      });
      const applicant = 'applicant' in res ? res.applicant : res;
      onPick(applicant);
      setShowCreate(false);
      setNewName('');
      setNewPhone('');
      setNewPan('');
    } catch (err) {
      setCreateError((err as Error).message);
    }
  };

  return (
    <div>
      <input
        type="text"
        placeholder="Search by name or phone…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      {search.length >= 2 && (
        <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white">
          {isFetching && <div className="px-3 py-2 text-xs text-slate-400">Searching…</div>}
          {!isFetching && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-500">No matches.</div>
          )}
          {results.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onPick(a)}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
            >
              <span className="font-medium text-slate-900">{a.name}</span>{' '}
              <span className="text-slate-500">{a.primaryPhone}</span>
            </button>
          ))}
        </div>
      )}

      {!showCreate ? (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-800"
        >
          + New applicant not found above
        </button>
      ) : (
        <div className="mt-2 space-y-2 rounded-md border border-slate-200 p-3">
          {createError && <p className="text-xs text-red-600">{createError}</p>}
          <input
            type="text"
            placeholder="Full name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="text"
            placeholder="Phone"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
            className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="text"
            placeholder="PAN (optional, e.g. ABCDE1234F)"
            value={newPan}
            maxLength={10}
            onChange={(e) => setNewPan(e.target.value.toUpperCase())}
            className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!newName || !newPhone}
              onClick={createApplicant}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Create & select
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BookingWizard() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<DraftData>(emptyDraft());
  const [draftId, setDraftId] = useState<string | null>(null);
  const [resumeOffer, setResumeOffer] = useState<BookingDraftRecord | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: myDrafts } = useQuery<BookingDraftRecord[]>({
    queryKey: ['booking-drafts-mine'],
    queryFn: () => api('/booking-drafts'),
  });

  useEffect(() => {
    if (myDrafts && myDrafts.length > 0 && !draftId && !resumeOffer) {
      setResumeOffer(myDrafts[0]);
    }
  }, [myDrafts, draftId, resumeOffer]);

  const { data: projects } = useQuery<{ data: ProjectRow[] }>({
    queryKey: ['projects-all'],
    queryFn: () => api('/projects?limit=100'),
  });

  const { data: units } = useQuery<{ data: UnitRow[] }>({
    queryKey: ['available-units', draft.projectId],
    queryFn: () => api(`/projects/${draft.projectId}/units?status=AVAILABLE&limit=100`),
    enabled: !!draft.projectId,
  });

  // Ride along into costLines on submit — the API resolves each PLC/
  // charge line's GST rate itself (its own chargeType's rate, falling
  // back to the base line's), so the wizard doesn't need to know about
  // that at all, just forward the amounts.
  const { data: unitPlcs } = useQuery<UnitPlcRow[]>({
    queryKey: ['booking-wizard-unit-plcs', draft.projectId, draft.unitId],
    queryFn: () => api(`/projects/${draft.projectId}/units/${draft.unitId}/plcs`),
    enabled: !!draft.projectId && !!draft.unitId,
  });
  const { data: unitCharges } = useQuery<UnitChargeRow[]>({
    queryKey: ['booking-wizard-unit-charges', draft.projectId, draft.unitId],
    queryFn: () => api(`/projects/${draft.projectId}/units/${draft.unitId}/charges`),
    enabled: !!draft.projectId && !!draft.unitId,
  });

  const { data: templates } = useQuery<{ data: PlanTemplateRow[] }>({
    queryKey: ['plan-templates'],
    queryFn: () => api('/masters/payment-plan-templates?limit=100'),
  });

  const { data: brokers } = useQuery<{ data: BrokerRow[] }>({
    queryKey: ['brokers-all'],
    queryFn: () => api('/brokers?limit=100'),
  });

  const { data: gstRates } = useQuery<{ data: GstRateRow[] }>({
    queryKey: ['gst-rates-all'],
    queryFn: () => api('/masters/gst-rates?limit=100'),
  });
  const activeGstRates = (gstRates?.data ?? []).filter((r) => r.isActive);

  // Never guess a rate — except when there is only one active option, in
  // which case there is nothing to guess: it's the only choice, and
  // forcing an explicit pick from a list of one is pure friction.
  useEffect(() => {
    if (!draft.gstRateId && activeGstRates.length === 1) {
      setDraft((d) => (d.gstRateId ? d : { ...d, gstRateId: activeGstRates[0].id }));
    }
  }, [activeGstRates.length]);

  async function persistDraft(next: DraftData) {
    try {
      if (draftId) {
        await api(`/booking-drafts/${draftId}`, { method: 'PATCH', body: JSON.stringify({ draftData: next }) });
      } else {
        const created = await api<BookingDraftRecord>('/booking-drafts', {
          method: 'POST',
          body: JSON.stringify({ label: 'Booking wizard draft', draftData: next }),
        });
        setDraftId(created.id);
      }
    } catch {
      // Autosave failures shouldn't block the wizard — the user can still submit at the end.
    }
  }

  function goToStep(step: number) {
    const next = { ...draft, step };
    setDraft(next);
    void persistDraft(next);
  }

  function resumeDraft() {
    if (!resumeOffer) return;
    setDraft(resumeOffer.draftData);
    setDraftId(resumeOffer.id);
    setResumeOffer(null);
  }

  async function discardDraft() {
    if (!resumeOffer) return;
    try {
      await api(`/booking-drafts/${resumeOffer.id}`, { method: 'DELETE' });
    } catch {
      // already gone — fine
    }
    setResumeOffer(null);
  }

  const canProceedFromStep = [
    !!draft.primaryApplicantId,
    !!draft.unitId && !!draft.basePricePaise && !!draft.gstRateId,
    true,
    draft.planMode === 'template' ? !!draft.paymentPlanTemplateId : draft.customInstallments.length > 0,
    true,
  ];

  async function submitBooking() {
    setError('');
    // The base line can never fall back to anything else — every other
    // line falls back to IT, and the server rejects the whole booking if
    // any line's GST rate can't be resolved. Catching this here means a
    // real reason on screen instead of a round trip to find out.
    if (!draft.gstRateId) {
      setError(
        'Select a GST rate for the base sale price before booking — every PLC/charge line ' +
          "that doesn't carry its own rate falls back to this one.",
      );
      return;
    }
    setSubmitting(true);
    try {
      const booking = await api<{ id: string }>('/bookings', {
        method: 'POST',
        body: JSON.stringify({
          unitId: draft.unitId,
          primaryApplicantId: draft.primaryApplicantId,
          coApplicantIds: draft.coApplicantIds,
          bookingDate: draft.bookingDate,
          paymentPlanTemplateId: draft.planMode === 'template' ? draft.paymentPlanTemplateId : undefined,
          costLines: [
            { kind: 'BASE', label: 'Base Sale Price', baseAmountPaise: draft.basePricePaise, gstRateId: draft.gstRateId },
            ...(unitPlcs ?? []).map((p) => ({ kind: 'PLC', label: p.plcType.name, baseAmountPaise: p.amountPaise })),
            ...(unitCharges ?? []).map((c) => ({
              kind: 'OTHER',
              chargeTypeId: c.chargeType.id,
              label: c.chargeType.name,
              baseAmountPaise: c.amountPaise,
            })),
          ],
        }),
      });

      if (draft.planMode === 'template') {
        await api(`/bookings/${booking.id}/plan/from-template`, {
          method: 'POST',
          body: JSON.stringify({ templateId: draft.paymentPlanTemplateId }),
        });
      } else {
        await api(`/bookings/${booking.id}/plan/custom`, {
          method: 'POST',
          body: JSON.stringify({
            name: 'Custom Plan',
            isCustom: true,
            installments: draft.customInstallments.map((i) => ({
              label: i.label,
              dueDate: i.dueDate,
              amountPaise: i.amountPaise,
            })),
          }),
        });
      }

      if (draft.brokerId) {
        await api(`/bookings/${booking.id}/broker`, {
          method: 'POST',
          body: JSON.stringify({ brokerId: draft.brokerId }),
        });
      }

      if (draftId) {
        await api(`/booking-drafts/${draftId}`, { method: 'DELETE' }).catch(() => {});
      }

      navigate(`/postsales/bookings/${booking.id}/installments`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const selectedUnit = units?.data?.find((u) => u.id === draft.unitId);
  // Excl. GST — each line's actual tax rate (and any fallback to the base
  // line's rate) is resolved server-side at booking creation, same as it
  // already was for a plain base-only booking.
  const totalBeforeGstPaise =
    (draft.basePricePaise ? BigInt(draft.basePricePaise) : 0n) +
    (unitPlcs ?? []).reduce((s, p) => s + BigInt(p.amountPaise), 0n) +
    (unitCharges ?? []).reduce((s, c) => s + BigInt(c.amountPaise), 0n);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-slate-900">New Booking</h1>

      {resumeOffer && (
        <div className="mt-4 flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <span>
            You have an unfinished draft from {new Date(resumeOffer.updatedAt).toLocaleString()}.
          </span>
          <div className="flex gap-2">
            <button onClick={resumeDraft} className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700">
              Resume
            </button>
            <button onClick={discardDraft} className="rounded-md border border-amber-300 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100">
              Discard
            </button>
          </div>
        </div>
      )}

      <ol className="mt-6 flex flex-wrap gap-2">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              disabled={i > draft.step && !canProceedFromStep.slice(0, i).every(Boolean)}
              onClick={() => (i <= draft.step ? goToStep(i) : undefined)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                i === draft.step
                  ? 'bg-blue-600 text-white'
                  : i < draft.step
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-slate-100 text-slate-400'
              }`}
            >
              {i + 1}. {label}
            </button>
          </li>
        ))}
      </ol>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5">
        {draft.step === 0 && (
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Primary applicant</h2>
            {draft.primaryApplicantId ? (
              <div className="mt-3 flex items-center justify-between rounded-md bg-blue-50 px-3 py-2 text-sm">
                <span className="font-medium text-blue-900">{draft.primaryApplicantName}</span>
                <button
                  onClick={() => setDraft({ ...draft, primaryApplicantId: undefined, primaryApplicantName: undefined })}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="mt-3">
                <ApplicantSearch
                  onPick={(a) => setDraft({ ...draft, primaryApplicantId: a.id, primaryApplicantName: a.name })}
                />
              </div>
            )}
          </div>
        )}

        {draft.step === 1 && (
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Unit selection</h2>
            <div className="mt-3 space-y-3">
              <select
                value={draft.projectId ?? ''}
                onChange={(e) => setDraft({ ...draft, projectId: e.target.value, unitId: undefined })}
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Select a project</option>
                {projects?.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code})
                  </option>
                ))}
              </select>

              {draft.projectId && (
                <select
                  value={draft.unitId ?? ''}
                  onChange={(e) => {
                    const u = units?.data?.find((x) => x.id === e.target.value);
                    setDraft({
                      ...draft,
                      unitId: e.target.value,
                      unitLabel: u ? unitLabel(u) : undefined,
                      basePricePaise: draft.basePricePaise || (u ? u.baseRatePaise : ''),
                    });
                  }}
                  className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Select an available unit</option>
                  {units?.data?.map((u) => (
                    <option key={u.id} value={u.id}>
                      {unitLabel(u)} — {formatInr(BigInt(u.baseRatePaise))}
                    </option>
                  ))}
                </select>
              )}

              {selectedUnit && (
                <div>
                  <label className="block text-sm font-medium text-slate-700">Agreed base price (₹)</label>
                  <input
                    type="number"
                    min={1}
                    value={draft.basePricePaise ? Number(draft.basePricePaise) / 100 : ''}
                    onChange={(e) => setDraft({ ...draft, basePricePaise: String(Math.round(Number(e.target.value) * 100)) })}
                    className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              )}

              {selectedUnit && (
                <div>
                  <label className="block text-sm font-medium text-slate-700">GST rate for base price</label>
                  <select
                    value={draft.gstRateId ?? ''}
                    onChange={(e) => setDraft({ ...draft, gstRateId: e.target.value || undefined })}
                    className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">Select…</option>
                    {activeGstRates.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.rate}% — {r.description}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-slate-500">
                    Any PLC or charge line without its own GST rate falls back to this one — leave it
                    unset and booking will be blocked, not silently taxed at 0%.
                  </p>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700">Booking date</label>
                <input
                  type="date"
                  value={draft.bookingDate}
                  onChange={(e) => setDraft({ ...draft, bookingDate: e.target.value })}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>
        )}

        {draft.step === 2 && (
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Co-applicants (optional, up to 5)</h2>
            <ul className="mt-3 space-y-1">
              {draft.coApplicantNames.map((name, i) => (
                <li key={draft.coApplicantIds[i]} className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-1.5 text-sm">
                  {name}
                  <button
                    onClick={() =>
                      setDraft({
                        ...draft,
                        coApplicantIds: draft.coApplicantIds.filter((_, idx) => idx !== i),
                        coApplicantNames: draft.coApplicantNames.filter((_, idx) => idx !== i),
                      })
                    }
                    className="text-xs text-red-600 hover:text-red-800"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            {draft.coApplicantIds.length < 5 && (
              <div className="mt-3">
                <ApplicantSearch
                  excludeIds={[draft.primaryApplicantId ?? '', ...draft.coApplicantIds]}
                  onPick={(a) =>
                    setDraft({
                      ...draft,
                      coApplicantIds: [...draft.coApplicantIds, a.id],
                      coApplicantNames: [...draft.coApplicantNames, a.name],
                    })
                  }
                />
              </div>
            )}
          </div>
        )}

        {draft.step === 3 && (
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Payment plan</h2>
            <div className="mt-3 flex gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={draft.planMode === 'template'}
                  onChange={() => setDraft({ ...draft, planMode: 'template' })}
                />
                From template
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={draft.planMode === 'custom'}
                  onChange={() => setDraft({ ...draft, planMode: 'custom' })}
                />
                Custom schedule
              </label>
            </div>

            {draft.planMode === 'template' ? (
              <select
                value={draft.paymentPlanTemplateId ?? ''}
                onChange={(e) => setDraft({ ...draft, paymentPlanTemplateId: e.target.value })}
                className="mt-3 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Select a template</option>
                {templates?.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="mt-3 space-y-2">
                {draft.customInstallments.map((inst, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Label"
                      value={inst.label}
                      onChange={(e) => {
                        const rows = [...draft.customInstallments];
                        rows[i] = { ...rows[i], label: e.target.value };
                        setDraft({ ...draft, customInstallments: rows });
                      }}
                      className="w-1/3 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    />
                    <input
                      type="date"
                      value={inst.dueDate}
                      onChange={(e) => {
                        const rows = [...draft.customInstallments];
                        rows[i] = { ...rows[i], dueDate: e.target.value };
                        setDraft({ ...draft, customInstallments: rows });
                      }}
                      className="w-1/3 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    />
                    <input
                      type="number"
                      placeholder="Amount (₹)"
                      value={inst.amountPaise ? Number(inst.amountPaise) / 100 : ''}
                      onChange={(e) => {
                        const rows = [...draft.customInstallments];
                        rows[i] = { ...rows[i], amountPaise: String(Math.round(Number(e.target.value) * 100)) };
                        setDraft({ ...draft, customInstallments: rows });
                      }}
                      className="w-1/3 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    />
                    <button
                      onClick={() =>
                        setDraft({ ...draft, customInstallments: draft.customInstallments.filter((_, idx) => idx !== i) })
                      }
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      customInstallments: [...draft.customInstallments, { label: '', dueDate: draft.bookingDate, amountPaise: '' }],
                    })
                  }
                  className="text-xs font-medium text-blue-600 hover:text-blue-800"
                >
                  + Add installment
                </button>
              </div>
            )}
          </div>
        )}

        {draft.step === 4 && (
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Confirm & book</h2>
            <div className="mt-3">
              <label className="block text-sm font-medium text-slate-700">Sourcing broker (optional)</label>
              <select
                value={draft.brokerId ?? ''}
                onChange={(e) => setDraft({ ...draft, brokerId: e.target.value || undefined })}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">No broker</option>
                {brokers?.data?.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Applicant</dt><dd className="font-medium">{draft.primaryApplicantName}</dd></div>
              {draft.coApplicantNames.length > 0 && (
                <div className="flex justify-between"><dt className="text-slate-500">Co-applicants</dt><dd className="font-medium">{draft.coApplicantNames.join(', ')}</dd></div>
              )}
              <div className="flex justify-between"><dt className="text-slate-500">Unit</dt><dd className="font-medium">{draft.unitLabel}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Base price</dt><dd className="font-medium">{draft.basePricePaise ? formatInr(BigInt(draft.basePricePaise)) : '—'}</dd></div>
              <div className="flex justify-between">
                <dt className="text-slate-500">GST rate (base line)</dt>
                <dd className={`font-medium ${draft.gstRateId ? '' : 'text-red-600'}`}>
                  {draft.gstRateId
                    ? activeGstRates.find((r) => r.id === draft.gstRateId)?.rate + '%'
                    : 'Not set — booking will be rejected'}
                </dd>
              </div>
              {unitPlcs?.map((p) => (
                <div key={p.id} className="flex justify-between"><dt className="text-slate-500">{p.plcType.name}</dt><dd className="font-medium">{formatInr(BigInt(p.amountPaise))}</dd></div>
              ))}
              {unitCharges?.map((c) => (
                <div key={c.id} className="flex justify-between"><dt className="text-slate-500">{c.chargeType.name}</dt><dd className="font-medium">{formatInr(BigInt(c.amountPaise))}</dd></div>
              ))}
              {((unitPlcs?.length ?? 0) > 0 || (unitCharges?.length ?? 0) > 0) && (
                <div className="flex justify-between border-t border-slate-100 pt-1.5">
                  <dt className="font-medium text-slate-700">Total (excl. GST)</dt>
                  <dd className="font-semibold">{formatInr(totalBeforeGstPaise)}</dd>
                </div>
              )}
              <div className="flex justify-between"><dt className="text-slate-500">Booking date</dt><dd className="font-medium">{draft.bookingDate}</dd></div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Payment plan</dt>
                <dd className="font-medium">
                  {draft.planMode === 'template'
                    ? templates?.data?.find((t) => t.id === draft.paymentPlanTemplateId)?.name
                    : `Custom (${draft.customInstallments.length} installments)`}
                </dd>
              </div>
            </dl>
          </div>
        )}

        <div className="mt-6 flex justify-between border-t border-slate-100 pt-4">
          <button
            type="button"
            disabled={draft.step === 0}
            onClick={() => goToStep(draft.step - 1)}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Back
          </button>
          {draft.step < STEPS.length - 1 ? (
            <button
              type="button"
              disabled={!canProceedFromStep[draft.step]}
              onClick={() => goToStep(draft.step + 1)}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting}
              onClick={submitBooking}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
            >
              {submitting ? 'Booking…' : 'Confirm & Book'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
