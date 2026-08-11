import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { usePaginatedQuery, useApiMutation } from '../../lib/hooks';
import { api } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';
import CustomFieldInputs, { buildCustomFieldPayload, useCustomFieldDefinitions } from '../../components/CustomFieldInputs';

interface Project {
  id: string;
  name: string;
  code: string;
  reraNumber: string | null;
  isActive: boolean;
}

interface MasterOption {
  id: string;
  name: string;
}

export default function ProjectsPage() {
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [reraNumber, setReraNumber] = useState('');
  const [projectTypeId, setProjectTypeId] = useState('');
  const [areaLocationId, setAreaLocationId] = useState('');
  const [address, setAddress] = useState('');
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, unknown>>({});

  const { definitions: projectDefs } = useCustomFieldDefinitions('PROJECT');

  const { data, isLoading } = usePaginatedQuery<Project>(['projects'], '/projects', { page, limit: 20 });

  const { data: projectTypes } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'project-types', 'all'],
    queryFn: () => api('/masters/project-types?limit=100'),
  });
  const { data: areaLocations } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'area-locations', 'all'],
    queryFn: () => api('/masters/area-locations?limit=100'),
  });

  const createMutation = useApiMutation<Project, Record<string, unknown>>('POST', '/projects', [['projects']]);

  const handleCreate = async () => {
    setError('');
    try {
      await createMutation.mutateAsync({
        name,
        code,
        reraNumber: reraNumber.trim() === '' ? undefined : reraNumber.trim(),
        projectTypeId: projectTypeId === '' ? undefined : projectTypeId,
        areaLocationId: areaLocationId === '' ? undefined : areaLocationId,
        address: address.trim() === '' ? undefined : address.trim(),
        customFields: buildCustomFieldPayload(projectDefs, customFieldValues),
      });
      setShowForm(false);
      setName('');
      setCode('');
      setReraNumber('');
      setProjectTypeId('');
      setAreaLocationId('');
      setAddress('');
      setCustomFieldValues({});
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const columns: Column<Project>[] = [
    { key: 'name', header: 'Name', render: (p) => <Link to={`/inventory/projects/${p.id}`} className="text-blue-600 hover:underline">{p.name}</Link> },
    { key: 'code', header: 'Code', render: (p) => p.code },
    { key: 'rera', header: 'RERA Number', render: (p) => p.reraNumber ?? '—' },
    { key: 'active', header: 'Active', render: (p) => (p.isActive ? 'Yes' : 'No') },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Projects</h1>
        <button
          onClick={() => setShowForm(true)}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          Add Project
        </button>
      </div>

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Code</label>
              <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. GRW1" className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">RERA Number</label>
              <input type="text" value={reraNumber} onChange={(e) => setReraNumber(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Project Type</label>
              <select value={projectTypeId} onChange={(e) => setProjectTypeId(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                <option value="">Select…</option>
                {projectTypes?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Area/Location</label>
              <select value={areaLocationId} onChange={(e) => setAreaLocationId(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                <option value="">Select…</option>
                {areaLocations?.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-slate-700">Address</label>
              <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
          </div>
          <CustomFieldInputs
            definitions={projectDefs}
            values={customFieldValues}
            onChange={(key, value) => setCustomFieldValues((prev) => ({ ...prev, [key]: value }))}
          />
          <div className="mt-3 flex gap-3">
            <button onClick={handleCreate} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700">Create</button>
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
