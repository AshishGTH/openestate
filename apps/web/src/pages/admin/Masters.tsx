import { useState } from 'react';
import { usePaginatedQuery, useApiMutation } from '../../lib/hooks';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';

const MASTER_TABLES = [
  { key: 'inquiry-sources', label: 'Inquiry Sources' },
  { key: 'inquiry-types', label: 'Inquiry Types' },
  { key: 'follow-up-types', label: 'Follow-Up Types' },
  { key: 'communication-types', label: 'Communication Types' },
  { key: 'project-types', label: 'Project Types' },
  { key: 'receipt-types', label: 'Receipt Types' },
  { key: 'registration-types', label: 'Registration Types' },
  { key: 'area-locations', label: 'Area/Locations' },
  { key: 'document-types', label: 'Document Types' },
  { key: 'charge-types', label: 'Charge Types' },
  { key: 'banks', label: 'Banks' },
  { key: 'interest-rules', label: 'Interest Rules' },
  { key: 'transfer-fee-rules', label: 'Transfer Fee Rules' },
  { key: 'payment-plan-templates', label: 'Payment Plan Templates' },
  { key: 'gst-rates', label: 'GST Rates' },
  { key: 'tds-rules', label: 'TDS Rules' },
  { key: 'letter-templates', label: 'Letter Templates' },
];

interface MasterItem {
  id: string;
  name?: string;
  description?: string;
  rate?: number;
  section?: string;
  sortOrder: number;
  isActive?: boolean;
}

export default function MastersPage() {
  const [selectedTable, setSelectedTable] = useState(MASTER_TABLES[0].key);
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<MasterItem | null>(null);
  const [formName, setFormName] = useState('');
  const [formError, setFormError] = useState('');

  const { data, isLoading } = usePaginatedQuery<MasterItem>(
    ['masters', selectedTable],
    `/masters/${selectedTable}`,
    { page, limit: 50, sortBy: 'sortOrder', sortOrder: 'asc' },
  );

  const createMutation = useApiMutation<unknown, { name: string }>(
    'POST',
    `/masters/${selectedTable}`,
    [['masters', selectedTable]],
  );

  const updateMutation = useApiMutation<unknown, { id: string; name: string }>(
    'PATCH',
    (body) => `/masters/${selectedTable}/${body.id}`,
    [['masters', selectedTable]],
  );

  const deleteMutation = useApiMutation<unknown, { id: string }>(
    'DELETE',
    (body) => `/masters/${selectedTable}/${body.id}`,
    [['masters', selectedTable]],
  );

  const handleSave = async () => {
    setFormError('');
    try {
      if (editItem) {
        await updateMutation.mutateAsync({ id: editItem.id, name: formName });
      } else {
        await createMutation.mutateAsync({ name: formName });
      }
      setShowForm(false);
      setEditItem(null);
      setFormName('');
    } catch (err) {
      setFormError((err as Error).message);
    }
  };

  const isSpecialized = ['gst-rates', 'tds-rules', 'letter-templates'].includes(selectedTable);

  const columns: Column<MasterItem>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (item) => item.name ?? item.description ?? item.section ?? '—',
    },
    {
      key: 'sortOrder',
      header: 'Sort Order',
      render: (item) => String(item.sortOrder),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (item) => (
        <div className="flex justify-end gap-2">
          {!isSpecialized && (
            <button
              onClick={() => {
                setEditItem(item);
                setFormName(item.name ?? '');
                setShowForm(true);
              }}
              className="text-blue-600 hover:text-blue-800 text-xs"
            >
              Edit
            </button>
          )}
          <button
            onClick={() => {
              if (confirm('Delete this item?')) {
                deleteMutation.mutate({ id: item.id });
              }
            }}
            className="text-red-600 hover:text-red-800 text-xs"
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Masters</h1>

      <div className="mt-4 flex flex-wrap gap-2">
        {MASTER_TABLES.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setSelectedTable(t.key);
              setPage(1);
              setShowForm(false);
            }}
            className={`rounded-md px-3 py-1.5 text-sm ${
              selectedTable === t.key
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <h2 className="text-lg font-medium text-slate-800">
          {MASTER_TABLES.find((t) => t.key === selectedTable)?.label}
        </h2>
        {!isSpecialized && (
          <button
            onClick={() => {
              setEditItem(null);
              setFormName('');
              setShowForm(true);
            }}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
          >
            Add Item
          </button>
        )}
      </div>

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-slate-700">Name</label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={handleSave}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              {editItem ? 'Update' : 'Create'}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setEditItem(null);
              }}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
          {formError && (
            <p className="mt-2 text-sm text-red-600">{formError}</p>
          )}
        </div>
      )}

      <div className="mt-4">
        <DataTable columns={columns} data={data?.data ?? []} isLoading={isLoading} />
        {data?.meta && (
          <Pagination
            page={data.meta.page}
            totalPages={data.meta.totalPages}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  );
}
