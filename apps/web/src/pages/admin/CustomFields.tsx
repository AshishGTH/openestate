import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_ENTITIES,
} from '@openestate/shared';
import { api } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';

interface CustomField {
  id: string;
  entityType: string;
  fieldName: string;
  fieldType: string;
  label: string;
  isRequired: boolean;
  options: string[] | null;
  sortOrder: number;
}

export default function CustomFieldsPage() {
  const [selectedEntity, setSelectedEntity] = useState<(typeof CUSTOM_FIELD_ENTITIES)[number]>(CUSTOM_FIELD_ENTITIES[0]);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    fieldName: '',
    fieldType: CUSTOM_FIELD_TYPES[0] as (typeof CUSTOM_FIELD_TYPES)[number],
    label: '',
    isRequired: false,
    options: '',
  });
  const [formError, setFormError] = useState('');
  const qc = useQueryClient();

  const { data: fields, isLoading } = useQuery<CustomField[]>({
    queryKey: ['custom-fields', selectedEntity],
    queryFn: () => api(`/custom-fields?entityType=${selectedEntity}`),
  });

  const handleCreate = async () => {
    setFormError('');
    try {
      const body: Record<string, unknown> = {
        entityType: selectedEntity,
        fieldName: formData.fieldName,
        fieldType: formData.fieldType,
        label: formData.label,
        isRequired: formData.isRequired,
      };
      if (['SELECT', 'MULTI_SELECT'].includes(formData.fieldType) && formData.options) {
        body.options = formData.options.split(',').map((o) => o.trim());
      }
      await api('/custom-fields', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      qc.invalidateQueries({ queryKey: ['custom-fields', selectedEntity] });
      setShowForm(false);
      setFormData({ fieldName: '', fieldType: CUSTOM_FIELD_TYPES[0], label: '', isRequired: false, options: '' });
    } catch (err) {
      setFormError((err as Error).message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this custom field?')) return;
    await api(`/custom-fields/${id}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['custom-fields', selectedEntity] });
  };

  const columns: Column<CustomField>[] = [
    { key: 'label', header: 'Label', render: (f) => f.label },
    { key: 'fieldName', header: 'Field Name', render: (f) => f.fieldName },
    {
      key: 'type',
      header: 'Type',
      render: (f) => (
        <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          {f.fieldType}
        </span>
      ),
    },
    {
      key: 'required',
      header: 'Required',
      render: (f) => (f.isRequired ? 'Yes' : 'No'),
    },
    {
      key: 'options',
      header: 'Options',
      render: (f) => (f.options ? f.options.join(', ') : '—'),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (f) => (
        <button
          onClick={() => handleDelete(f.id)}
          className="text-red-600 hover:text-red-800 text-xs"
        >
          Delete
        </button>
      ),
    },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Custom Fields</h1>

      <div className="mt-4 flex flex-wrap gap-2">
        {CUSTOM_FIELD_ENTITIES.map((entity) => (
          <button
            key={entity}
            onClick={() => {
              setSelectedEntity(entity);
              setShowForm(false);
            }}
            className={`rounded-md px-3 py-1.5 text-sm ${
              selectedEntity === entity
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            {entity}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <h2 className="text-lg font-medium text-slate-800">{selectedEntity} Fields</h2>
        <button
          onClick={() => setShowForm(true)}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          Add Field
        </button>
      </div>

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Label</label>
              <input
                type="text"
                value={formData.label}
                onChange={(e) => setFormData((p) => ({ ...p, label: e.target.value }))}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Field Name</label>
              <input
                type="text"
                value={formData.fieldName}
                onChange={(e) => setFormData((p) => ({ ...p, fieldName: e.target.value }))}
                placeholder="snake_case"
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Type</label>
              <select
                value={formData.fieldType}
                onChange={(e) => setFormData((p) => ({ ...p, fieldType: e.target.value as (typeof CUSTOM_FIELD_TYPES)[number] }))}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              >
                {CUSTOM_FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.isRequired}
                  onChange={(e) => setFormData((p) => ({ ...p, isRequired: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span className="text-sm text-slate-700">Required</span>
              </label>
            </div>
          </div>

          {['SELECT', 'MULTI_SELECT'].includes(formData.fieldType) && (
            <div>
              <label className="block text-sm font-medium text-slate-700">
                Options (comma-separated)
              </label>
              <input
                type="text"
                value={formData.options}
                onChange={(e) => setFormData((p) => ({ ...p, options: e.target.value }))}
                placeholder="Option 1, Option 2, Option 3"
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              Create Field
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
          {formError && <p className="text-sm text-red-600">{formError}</p>}
        </div>
      )}

      <div className="mt-4">
        <DataTable columns={columns} data={fields ?? []} isLoading={isLoading} />
      </div>
    </div>
  );
}
