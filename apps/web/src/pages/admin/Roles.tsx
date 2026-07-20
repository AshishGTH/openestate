import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePaginatedQuery, useApiMutation } from '../../lib/hooks';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';

interface Role {
  id: string;
  name: string;
  slug: string;
  isSystem: boolean;
  _count?: { users: number };
  permissions?: Array<{ permission: { key: string } }>;
}

export default function RolesPage() {
  const [page, setPage] = useState(1);

  const { data, isLoading } = usePaginatedQuery<Role>(
    ['roles'],
    '/roles',
    { page, limit: 20 },
  );

  const deleteMutation = useApiMutation<unknown, { id: string }>(
    'DELETE',
    (body) => `/roles/${body.id}`,
    [['roles']],
  );

  const columns: Column<Role>[] = [
    { key: 'name', header: 'Name', render: (r) => r.name },
    { key: 'slug', header: 'Slug', render: (r) => r.slug },
    {
      key: 'system',
      header: 'Type',
      render: (r) => (
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            r.isSystem
              ? 'bg-purple-50 text-purple-700'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          {r.isSystem ? 'System' : 'Custom'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (r) => (
        <div className="flex justify-end gap-2">
          <Link
            to={`/admin/roles/${r.id}`}
            className="text-blue-600 hover:text-blue-800 text-xs"
          >
            Edit
          </Link>
          {!r.isSystem && (
            <button
              onClick={() => {
                if (confirm(`Delete role "${r.name}"?`)) {
                  deleteMutation.mutate({ id: r.id });
                }
              }}
              className="text-red-600 hover:text-red-800 text-xs"
            >
              Delete
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Roles</h1>
        <Link
          to="/admin/roles/new"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          Add Role
        </Link>
      </div>

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
