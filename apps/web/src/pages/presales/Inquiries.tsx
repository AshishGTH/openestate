import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { usePaginatedQuery } from '../../lib/hooks';
import { api, downloadFile } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';
import CustomFieldInputs, {
  useCustomFieldDefinitions,
  buildCustomFieldPayload,
} from '../../components/CustomFieldInputs';

interface Inquiry {
  id: string;
  status: string;
  applicant: { id: string; name: string; primaryPhone: string };
  project: { id: string; name: string } | null;
  temperature: { id: string; name: string } | null;
  createdAt: string;
}

interface MasterOption {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
}

export default function InquiriesPage() {
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [duplicateWarning, setDuplicateWarning] = useState<string[]>([]);
  const [applicantName, setApplicantName] = useState('');
  const [applicantPhone, setApplicantPhone] = useState('');
  const [projectId, setProjectId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [temperatureId, setTemperatureId] = useState('');
  const [inquiryCf, setInquiryCf] = useState<Record<string, unknown>>({});
  const [applicantCf, setApplicantCf] = useState<Record<string, unknown>>({});

  const { definitions: inquiryDefs } = useCustomFieldDefinitions('INQUIRY');
  const { definitions: applicantDefs } = useCustomFieldDefinitions('APPLICANT');

  const qc = useQueryClient();
  const { data, isLoading } = usePaginatedQuery<Inquiry>(['inquiries'], '/inquiries', { page, limit: 20 });

  const { data: projects } = useQuery<{ data: Project[] }>({
    queryKey: ['projects', 'all'],
    queryFn: () => api('/projects?limit=100'),
  });
  const { data: sources } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'inquiry-sources', 'all'],
    queryFn: () => api('/masters/inquiry-sources?limit=100'),
  });
  const { data: temperatures } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'inquiry-temperatures', 'all'],
    queryFn: () => api('/masters/inquiry-temperatures?limit=100'),
  });

  const handleCreate = async () => {
    setError('');
    setDuplicateWarning([]);
    try {
      const res = await api<{ possibleDuplicateApplicantIds?: string[] }>('/inquiries', {
        method: 'POST',
        body: JSON.stringify({
          applicant: {
            name: applicantName,
            primaryPhone: applicantPhone,
            alternatePhones: [],
            customFields: buildCustomFieldPayload(applicantDefs, applicantCf),
          },
          projectId: projectId === '' ? undefined : projectId,
          sourceId: sourceId === '' ? undefined : sourceId,
          temperatureId: temperatureId === '' ? undefined : temperatureId,
          customFields: buildCustomFieldPayload(inquiryDefs, inquiryCf),
        }),
      });
      if (res.possibleDuplicateApplicantIds && res.possibleDuplicateApplicantIds.length > 0) {
        setDuplicateWarning(res.possibleDuplicateApplicantIds);
      }
      qc.invalidateQueries({ queryKey: ['inquiries'] });
      setShowForm(false);
      setApplicantName('');
      setApplicantPhone('');
      setProjectId('');
      setSourceId('');
      setTemperatureId('');
      setInquiryCf({});
      setApplicantCf({});
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const columns: Column<Inquiry>[] = [
    { key: 'applicant', header: 'Applicant', render: (i) => <Link to={`/presales/inquiries/${i.id}`} className="text-blue-600 hover:underline">{i.applicant.name}</Link> },
    { key: 'phone', header: 'Phone', render: (i) => i.applicant.primaryPhone },
    { key: 'project', header: 'Project', render: (i) => i.project?.name ?? '—' },
    { key: 'temperature', header: 'Temperature', render: (i) => i.temperature?.name ?? '—' },
    { key: 'status', header: 'Status', render: (i) => i.status },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Inquiries</h1>
        <div className="flex gap-2">
          <button
            onClick={() => downloadFile('/reports/presales/inquiries-export?format=csv', 'inquiries-export.csv')}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Export CSV
          </button>
          <button onClick={() => setShowForm(true)} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700">
            Add Inquiry
          </button>
        </div>
      </div>

      {duplicateWarning.length > 0 && (
        <div className="mt-4 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          Inquiry created, but {duplicateWarning.length} possible duplicate applicant(s) were found with the same
          phone/email. Review before proceeding.
        </div>
      )}

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Applicant Name</label>
              <input type="text" value={applicantName} onChange={(e) => setApplicantName(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Phone</label>
              <input type="text" value={applicantPhone} onChange={(e) => setApplicantPhone(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Project</label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                <option value="">Select…</option>
                {projects?.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Source</label>
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                <option value="">Select…</option>
                {sources?.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Temperature</label>
              <select value={temperatureId} onChange={(e) => setTemperatureId(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                <option value="">Select…</option>
                {temperatures?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>

          {applicantDefs.length > 0 && (
            <div data-testid="applicant-custom-fields">
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-400">Applicant</p>
              <CustomFieldInputs
                definitions={applicantDefs}
                values={applicantCf}
                onChange={(k, v) => setApplicantCf((p) => ({ ...p, [k]: v }))}
              />
            </div>
          )}
          {inquiryDefs.length > 0 && (
            <div data-testid="inquiry-custom-fields">
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-400">Inquiry</p>
              <CustomFieldInputs
                definitions={inquiryDefs}
                values={inquiryCf}
                onChange={(k, v) => setInquiryCf((p) => ({ ...p, [k]: v }))}
              />
            </div>
          )}

          <div className="mt-3 flex gap-3">
            <button onClick={handleCreate} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Create</button>
            <button onClick={() => setShowForm(false)} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>
      )}

      <div className="mt-4">
        <DataTable columns={columns} data={data?.data ?? []} isLoading={isLoading} />
        {data?.meta && <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onPageChange={setPage} />}
      </div>
    </div>
  );
}
