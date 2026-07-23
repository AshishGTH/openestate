import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

interface ConstructionMedia {
  id: string;
  originalName: string;
}

interface ConstructionUpdate {
  id: string;
  title: string;
  description: string | null;
  publishedAt: string;
  media: ConstructionMedia[];
}

interface PropertyEntry {
  bookingId: string;
  bookingNumber: string;
  status: string;
  allotmentDate: string | null;
  registrationDate: string | null;
  unit: { number: string; typeName: string | null; carpetAreaSqft: string | null };
  tower: { name: string };
  floor: { name: string };
  project: { id: string; name: string; address: string | null; expectedEndDate: string | null };
  constructionUpdates: ConstructionUpdate[];
}

export default function Property() {
  const { data, isLoading } = useQuery<PropertyEntry[]>({
    queryKey: ['portal', 'property'],
    queryFn: () => api('/portal/property'),
  });

  if (isLoading) return <div className="text-slate-500 text-sm">Loading…</div>;
  if (!data || data.length === 0) {
    return <div className="text-slate-500 text-sm">No property found on your account yet.</div>;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">My Property</h1>

      {data.map((p) => (
        <div key={p.bookingId} className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-900">{p.project.name}</span>
            <span className="text-xs rounded-full bg-slate-100 text-slate-600 px-2 py-0.5">{p.status}</span>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            {p.tower.name} · {p.floor.name} · Unit {p.unit.number}
            {p.unit.typeName ? ` (${p.unit.typeName})` : ''}
          </p>
          {p.unit.carpetAreaSqft && (
            <p className="text-xs text-slate-500 mt-0.5">{p.unit.carpetAreaSqft} sqft carpet area</p>
          )}
          {p.project.address && <p className="text-xs text-slate-500 mt-0.5">{p.project.address}</p>}
          {p.project.expectedEndDate && (
            <p className="text-xs text-slate-500 mt-0.5">
              Tentative possession: {new Date(p.project.expectedEndDate).toLocaleDateString('en-IN')}
            </p>
          )}

          {p.constructionUpdates.length > 0 && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <h3 className="text-sm font-medium text-slate-700">Construction progress</h3>
              <div className="mt-2 space-y-3">
                {p.constructionUpdates.map((u) => (
                  <div key={u.id}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm text-slate-800">{u.title}</span>
                      <span className="text-xs text-slate-400">
                        {new Date(u.publishedAt).toLocaleDateString('en-IN')}
                      </span>
                    </div>
                    {u.description && <p className="text-xs text-slate-500">{u.description}</p>}
                    {u.media.length > 0 && (
                      <p className="text-xs text-slate-400 mt-0.5">{u.media.length} photo(s)</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
