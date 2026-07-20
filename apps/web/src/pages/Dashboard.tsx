import { useAuth } from '../lib/auth';

export default function Dashboard() {
  const { user } = useAuth();

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
      <p className="mt-1 text-sm text-slate-500">
        Welcome back, {user?.email}
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Role', value: user?.roleSlug ?? '—' },
          { label: 'Company', value: user?.companyId?.slice(0, 8) + '…' },
          { label: 'Permissions', value: String(user?.permissions.length ?? 0) },
          { label: 'Status', value: 'Active' },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              {card.label}
            </div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{card.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
