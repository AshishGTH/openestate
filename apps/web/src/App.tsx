import { useQuery } from '@tanstack/react-query';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

async function fetchHealth() {
  const res = await fetch(`${API_URL}/api/v1/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

export default function App() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['health'], queryFn: fetchHealth });

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">OpenEstate — Admin</h1>
        <p className="mt-2 text-sm text-slate-500">
          Staff admin shell. Modules (masters, users, RBAC, inventory, pre-sales, post-sales) land
          starting Phase 1.
        </p>
        <div className="mt-4 rounded-md bg-slate-100 p-3 text-sm">
          <span className="font-medium">API health:</span>{' '}
          {isLoading && 'checking…'}
          {isError && <span className="text-red-600">unreachable</span>}
          {data && <span className="text-emerald-600">{JSON.stringify(data)}</span>}
        </div>
      </div>
    </div>
  );
}
