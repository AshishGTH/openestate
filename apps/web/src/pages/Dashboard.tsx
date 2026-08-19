import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PERMISSIONS } from '@openestate/shared';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import DataTable, { type Column } from '../components/DataTable';

interface StatusCount {
  status: string;
  count: number;
}

interface Summary {
  followUpsToday: number;
  followUpsOverdue: number;
  openInquiries: number;
  conversionsThisMonth: number;
  byStatus: StatusCount[];
}

interface ReportRow {
  userId: string;
  name: string;
  roleName: string | null;
  openInquiries: number;
  followUpsToday: number;
  followUpsOverdue: number;
  conversionsThisMonth: number;
  lastActivityAt: string | null;
}

interface DashboardData {
  mine: Summary;
  team: (Summary & { memberCount: number; perReport: ReportRow[] }) | null;
  generatedAt: string;
}

/** DataTable keys rows off `id`; the API calls it `userId` (clearer there). */
type ReportRowWithId = ReportRow & { id: string };

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / 86_400_000);
}

function activityLabel(iso: string | null): string {
  const days = daysSince(iso);
  if (days === null) return 'No activity logged';
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

function Stat({
  label,
  value,
  tone = 'default',
  to,
}: {
  label: string;
  value: number;
  tone?: 'default' | 'warn';
  to?: string;
}) {
  const body = (
    <div
      className={`rounded-lg border p-4 shadow-sm ${
        tone === 'warn' && value > 0
          ? 'border-amber-200 bg-amber-50'
          : 'border-slate-200 bg-white'
      }`}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold ${
          tone === 'warn' && value > 0 ? 'text-amber-800' : 'text-slate-900'
        }`}
      >
        {value}
      </div>
    </div>
  );
  return to ? (
    <Link to={to} className="block hover:opacity-80">
      {body}
    </Link>
  ) : (
    body
  );
}

function SummaryBlock({ summary }: { summary: Summary }) {
  const nonZeroStatuses = summary.byStatus.filter((s) => s.count > 0);
  return (
    <>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Follow-ups due today" value={summary.followUpsToday} to="/presales/inquiries" />
        <Stat label="Overdue follow-ups" value={summary.followUpsOverdue} tone="warn" to="/presales/inquiries" />
        <Stat label="Open inquiries" value={summary.openInquiries} to="/presales/inquiries" />
        <Stat label="Converted this month" value={summary.conversionsThisMonth} />
      </div>
      {nonZeroStatuses.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {nonZeroStatuses.map((s) => (
            <span
              key={s.status}
              className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700"
            >
              {s.status}: {s.count}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

export default function Dashboard() {
  const { user, hasPermission } = useAuth();
  const { data, isLoading, isError } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api('/dashboard'),
    retry: false,
  });

  const perReportRows: ReportRowWithId[] = (data?.team?.perReport ?? []).map((r) => ({
    ...r,
    id: r.userId,
  }));

  const columns: Column<ReportRowWithId>[] = [
    { key: 'name', header: 'Name', render: (r) => r.name },
    { key: 'role', header: 'Role', render: (r) => r.roleName ?? '—' },
    { key: 'open', header: 'Open', render: (r) => r.openInquiries },
    { key: 'today', header: 'Due today', render: (r) => r.followUpsToday },
    {
      key: 'overdue',
      header: 'Overdue',
      render: (r) => (
        <span className={r.followUpsOverdue > 0 ? 'font-medium text-amber-700' : ''}>
          {r.followUpsOverdue}
        </span>
      ),
    },
    { key: 'converted', header: 'Converted this month', render: (r) => r.conversionsThisMonth },
    {
      key: 'activity',
      header: 'Last activity',
      render: (r) => {
        const days = daysSince(r.lastActivityAt);
        const stale = days === null || days >= 7;
        return (
          <span className={stale ? 'font-medium text-amber-700' : 'text-slate-600'}>
            {activityLabel(r.lastActivityAt)}
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
      <p className="mt-1 text-sm text-slate-500">Welcome back, {user?.email}</p>

      {isError && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          Your role doesn't have access to pre-sales data, so there's no work summary to show here.
          Use the sidebar to reach the areas you do have access to.
        </div>
      )}

      {isLoading && <p className="mt-6 text-sm text-slate-500">Loading…</p>}

      {data && (
        <>
          <section className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">My work</h2>
            <SummaryBlock summary={data.mine} />
          </section>

          {data.team && (
            <>
              <section className="mt-8">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
                  My team ({data.team.memberCount}{' '}
                  {data.team.memberCount === 1 ? 'person' : 'people'}, including me)
                </h2>
                <SummaryBlock summary={data.team} />
              </section>

              <section className="mt-8">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
                  Per report
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Everyone in your reporting line except you. "Last activity" is the most recent
                  follow-up they logged.
                </p>
                <div className="mt-3">
                  <DataTable columns={columns} data={perReportRows} isLoading={false} />
                </div>
              </section>
            </>
          )}

          {!data.team && (
            <p className="mt-8 text-sm text-slate-500">
              You have no reports configured, so there's no team view.
              {/* Only offered to someone who can actually open it —
                  sales_executive holds no ADMIN_USER_READ, and a link
                  straight into a 403 is worse than no link. */}
              {hasPermission(PERMISSIONS.ADMIN_USER_READ) && (
                <>
                  {' '}
                  <Link to="/admin/hierarchy" className="font-medium text-blue-600 hover:underline">
                    View the reporting hierarchy
                  </Link>{' '}
                  to see how your organisation is set up.
                </>
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}
