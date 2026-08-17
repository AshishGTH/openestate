import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  CustomFieldDisplay,
  useCustomFieldDefinitions,
} from '../../components/CustomFieldInputs';

interface Inquiry {
  id: string;
  status: string;
  applicant: {
    id: string;
    name: string;
    primaryPhone: string;
    customFields?: Record<string, unknown> | null;
  };
  project: { id: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
  customFields?: Record<string, unknown> | null;
}

interface FollowUp {
  id: string;
  notes: string | null;
  outcome: string | null;
  scheduledAt: string | null;
  venue: string | null;
  createdAt: string;
  type: { name: string } | null;
  createdBy: { id: string; name: string } | null;
}

interface MasterOption {
  id: string;
  name: string;
}

interface UserOption {
  id: string;
  name: string;
}

const STATUSES = ['OPEN', 'CONTINUED', 'DUMPED', 'SUCCESSFUL'];

export default function InquiryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [typeId, setTypeId] = useState('');
  const [notes, setNotes] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [venue, setVenue] = useState('');
  const [followUpError, setFollowUpError] = useState('');

  const { definitions: inquiryDefs } = useCustomFieldDefinitions('INQUIRY');
  const { definitions: applicantDefs } = useCustomFieldDefinitions('APPLICANT');

  const [toUserId, setToUserId] = useState('');
  const [assignReason, setAssignReason] = useState('');
  const [assignError, setAssignError] = useState('');

  const [statusError, setStatusError] = useState('');

  const { data: inquiry } = useQuery<Inquiry>({
    queryKey: ['inquiry', id],
    queryFn: () => api(`/inquiries/${id}`),
    enabled: !!id,
  });

  const { data: followUps } = useQuery<FollowUp[]>({
    queryKey: ['follow-ups', id],
    queryFn: () => api(`/inquiries/${id}/follow-ups`),
    enabled: !!id,
  });

  const { data: followUpTypes } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'follow-up-types', 'all'],
    queryFn: () => api('/masters/follow-up-types?limit=100'),
  });

  const { data: users } = useQuery<{ data: UserOption[] }>({
    queryKey: ['users', 'all'],
    queryFn: () => api('/users?page=1&limit=100'),
  });

  const handleAddFollowUp = async () => {
    setFollowUpError('');
    try {
      await api(`/inquiries/${id}/follow-ups`, {
        method: 'POST',
        body: JSON.stringify({
          typeId: typeId === '' ? undefined : typeId,
          notes: notes.trim() === '' ? undefined : notes.trim(),
          scheduledAt: scheduledAt === '' ? undefined : scheduledAt,
          venue: venue.trim() === '' ? undefined : venue.trim(),
        }),
      });
      qc.invalidateQueries({ queryKey: ['follow-ups', id] });
      setTypeId('');
      setNotes('');
      setScheduledAt('');
      setVenue('');
    } catch (err) {
      setFollowUpError((err as Error).message);
    }
  };

  const handleReassign = async () => {
    setAssignError('');
    try {
      await api(`/inquiries/${id}/assign`, {
        method: 'PATCH',
        body: JSON.stringify({ toUserId, reason: assignReason.trim() === '' ? undefined : assignReason.trim() }),
      });
      qc.invalidateQueries({ queryKey: ['inquiry', id] });
      setToUserId('');
      setAssignReason('');
    } catch (err) {
      setAssignError((err as Error).message);
    }
  };

  const handleStatusChange = async (status: string) => {
    setStatusError('');
    try {
      await api(`/inquiries/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      qc.invalidateQueries({ queryKey: ['inquiry', id] });
    } catch (err) {
      setStatusError((err as Error).message);
    }
  };

  if (!inquiry) return <div className="text-slate-500">Loading…</div>;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">{inquiry.applicant.name}</h1>
      <p className="text-sm text-slate-500">
        {inquiry.applicant.primaryPhone} {inquiry.project && <>· {inquiry.project.name}</>}
        {inquiry.assignedTo && <> · Assigned to {inquiry.assignedTo.name}</>}
      </p>

      <section className="mt-4">
        <h2 className="text-lg font-medium text-slate-800">Status: {inquiry.status}</h2>
        <div className="mt-2 flex gap-2">
          {STATUSES.filter((s) => s !== inquiry.status).map((s) => (
            <button
              key={s}
              onClick={() => handleStatusChange(s)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              Mark {s}
            </button>
          ))}
        </div>
        {statusError && <p className="mt-2 text-sm text-red-600">{statusError}</p>}
      </section>

      <section className="mt-6" data-testid="inquiry-custom-field-display">
        <CustomFieldDisplay definitions={inquiryDefs} values={inquiry.customFields} />
        <CustomFieldDisplay definitions={applicantDefs} values={inquiry.applicant.customFields} />
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-medium text-slate-800">Reassign</h2>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-700">Assign To</label>
            <select value={toUserId} onChange={(e) => setToUserId(e.target.value)} className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="">Select…</option>
              {users?.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Reason</label>
            <input type="text" value={assignReason} onChange={(e) => setAssignReason(e.target.value)} className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <button onClick={handleReassign} disabled={!toUserId} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            Reassign
          </button>
        </div>
        {assignError && <p className="mt-2 text-sm text-red-600">{assignError}</p>}
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-medium text-slate-800">Follow-ups &amp; Site Visits</h2>
        <p className="text-sm text-slate-500">
          To log a site visit, pick the "Site Visit" type and fill in the date/venue below.
        </p>
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Type</label>
              <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                <option value="">Select…</option>
                {followUpTypes?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Scheduled At (for site visits)</label>
              <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Venue</label>
              <input type="text" value={venue} onChange={(e) => setVenue(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-slate-700">Notes</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="mt-3">
            <button onClick={handleAddFollowUp} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              Log Follow-up
            </button>
          </div>
          {followUpError && <p className="mt-2 text-sm text-red-600">{followUpError}</p>}
        </div>

        <ul className="mt-3 space-y-2">
          {(followUps ?? []).length === 0 ? (
            <li className="text-sm text-slate-500">No follow-ups yet</li>
          ) : (
            followUps!.map((f) => (
              <li key={f.id} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
                <div className="font-medium text-slate-800">
                  {f.type?.name ?? 'Follow-up'} — {new Date(f.createdAt).toLocaleString()}
                  {f.createdBy && <span className="font-normal text-slate-500"> by {f.createdBy.name}</span>}
                </div>
                {f.scheduledAt && <div className="text-slate-600">Scheduled: {new Date(f.scheduledAt).toLocaleString()} {f.venue && `at ${f.venue}`}</div>}
                {f.notes && <div className="text-slate-600">{f.notes}</div>}
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}
