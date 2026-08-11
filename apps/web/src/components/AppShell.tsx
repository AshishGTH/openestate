import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { PERMISSIONS } from '@openestate/shared';

const NAV_ITEMS = [
  { label: 'Dashboard', to: '/', icon: 'H' },
  { label: 'Settings', to: '/settings', icon: 'S' },
  { label: 'Support', to: '/support/tickets', icon: 'T', perm: PERMISSIONS.ADMIN_TICKET_RESPOND },
  {
    label: 'Pre-sales',
    icon: 'I',
    children: [
      { label: 'Inquiries', to: '/presales/inquiries', perm: PERMISSIONS.PRESALES_INQUIRY_READ },
    ],
  },
  {
    label: 'Inventory',
    icon: 'V',
    children: [
      { label: 'Projects', to: '/inventory/projects', perm: PERMISSIONS.INVENTORY_PROJECT_READ },
    ],
  },
  {
    label: 'Post-sales',
    icon: 'P',
    children: [
      { label: 'New Booking', to: '/postsales/bookings/new', perm: PERMISSIONS.POSTSALES_BOOKING_CREATE },
      { label: 'Receipt Entry', to: '/postsales/receipts/new', perm: PERMISSIONS.POSTSALES_RECEIPT_CREATE },
      { label: 'Cheque Queue', to: '/postsales/cheques', perm: PERMISSIONS.POSTSALES_CHEQUE_VERIFY },
      { label: 'Dues Dashboard', to: '/postsales/dues', perm: PERMISSIONS.REPORTS_OUTSTANDING_VIEW },
      { label: 'Reports', to: '/postsales/reports', perm: PERMISSIONS.REPORTS_COLLECTION_VIEW },
      { label: 'Brokers', to: '/postsales/brokers', perm: PERMISSIONS.ADMIN_BROKER_READ },
    ],
  },
  {
    label: 'Admin',
    icon: 'A',
    children: [
      { label: 'Users', to: '/admin/users', perm: PERMISSIONS.ADMIN_USER_READ },
      { label: 'Roles', to: '/admin/roles', perm: PERMISSIONS.ADMIN_ROLE_READ },
      { label: 'Masters', to: '/admin/masters', perm: PERMISSIONS.ADMIN_MASTER_READ },
      { label: 'Custom Fields', to: '/admin/custom-fields', perm: PERMISSIONS.ADMIN_CUSTOM_FIELD_READ },
      { label: 'Letter Templates', to: '/admin/letter-templates', perm: PERMISSIONS.ADMIN_MASTER_READ },
      { label: 'Company Config', to: '/admin/config', perm: PERMISSIONS.ADMIN_CONFIG_READ },
      { label: 'Audit Log', to: '/admin/audit', perm: PERMISSIONS.ADMIN_AUDIT_READ },
      { label: 'Plugins', to: '/admin/plugins', perm: PERMISSIONS.ADMIN_PLUGIN_READ },
      { label: 'Webhooks', to: '/admin/webhooks', perm: PERMISSIONS.ADMIN_WEBHOOK_READ },
      { label: 'Lead API Keys', to: '/admin/lead-api-keys', perm: PERMISSIONS.ADMIN_LEAD_API_KEY_READ },
    ],
  },
];

const linkClasses = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm ${
    isActive
      ? 'bg-blue-50 text-blue-700 font-medium'
      : 'text-slate-700 hover:bg-slate-100'
  }`;

interface CompanyConfigGstFields {
  companyGstin: string | null;
  gstStateCode: string | null;
}

/**
 * isIntraStateSupply() (packages/shared) now throws instead of silently
 * defaulting to intra-state GST when either the company's or a booking's
 * place-of-supply state code is missing — a company with incomplete GST
 * config can no longer create bookings or extra charges at all, with no
 * on-screen indication of why until someone hits the error. Shown to
 * anyone who can read Company Config (same permission that gates the nav
 * link), on every page, not just Company Config itself, since the error
 * surfaces on Booking/Receipt screens, not there.
 */
function GstConfigBanner() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission(PERMISSIONS.ADMIN_CONFIG_READ);
  const { data } = useQuery<CompanyConfigGstFields>({
    queryKey: ['company-config'],
    queryFn: () => api('/company/config'),
    enabled: canRead,
  });
  if (!canRead || !data || (data.companyGstin && data.gstStateCode)) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 lg:px-6">
      GST configuration is incomplete — bookings and extra charges will be
      rejected until it's set.{' '}
      <Link to="/admin/config" className="font-medium underline hover:text-amber-900">
        Complete Company Config
      </Link>
    </div>
  );
}

/**
 * Bookings created before the base-line GST rate picker existed can have
 * a BASE cost line with no gstRateId — snapshotted at 0% GST, silently,
 * on every generated document. `BookingCostLine` is immutable, so these
 * can't be fixed retroactively; this only tells an admin they exist and
 * exactly where to find them, mirroring GstConfigBanner's shape.
 */
function ZeroGstBookingsBanner() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission(PERMISSIONS.REPORTS_SALES_VIEW);
  const { data } = useQuery<{ count: number }>({
    queryKey: ['zero-gst-bookings-count'],
    queryFn: () => api('/reports/postsales/zero-gst-bookings-count'),
    enabled: canRead,
  });
  if (!canRead || !data || data.count === 0) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 lg:px-6">
      {data.count} booking{data.count === 1 ? '' : 's'} {data.count === 1 ? 'has' : 'have'} no GST rate
      on its base cost line — printed documents for {data.count === 1 ? 'it' : 'them'} may show ₹0 GST.{' '}
      <Link to="/postsales/reports" className="font-medium underline hover:text-amber-900">
        Post-sales → Reports → "Zero-GST bookings"
      </Link>{' '}
      lists the affected booking numbers.
    </div>
  );
}

export default function AppShell() {
  const { user, logout, hasPermission } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen flex bg-slate-50">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-30 w-64 transform bg-white border-r border-slate-200 transition-transform lg:translate-x-0 lg:static lg:z-auto ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 items-center border-b border-slate-200 px-4">
          <Link to="/" className="text-lg font-semibold text-slate-900">
            OpenEstate
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            if ('children' in item && item.children) {
              const visibleChildren = item.children.filter(
                (c) => !c.perm || hasPermission(c.perm),
              );
              if (visibleChildren.length === 0) return null;

              return (
                <div key={item.label}>
                  <div className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {item.label}
                  </div>
                  {visibleChildren.map((child) => (
                    <NavLink
                      key={child.to}
                      to={child.to}
                      className={linkClasses}
                      onClick={() => setSidebarOpen(false)}
                    >
                      {child.label}
                    </NavLink>
                  ))}
                </div>
              );
            }

            if ('perm' in item && item.perm && !hasPermission(item.perm)) return null;

            return (
              <NavLink
                key={item.to}
                to={item.to}
                end
                className={linkClasses}
                onClick={() => setSidebarOpen(false)}
              >
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-3">
          <div className="text-sm text-slate-700 truncate px-3">{user?.email}</div>
          <button
            onClick={logout}
            className="mt-2 w-full rounded-md px-3 py-2 text-sm text-red-600 hover:bg-red-50 text-left"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-slate-200 bg-white px-4 lg:px-6">
          <button
            className="lg:hidden rounded-md p-2 text-slate-500 hover:bg-slate-100"
            onClick={() => setSidebarOpen(true)}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex-1" />
          <span className="text-sm text-slate-500 hidden sm:inline">{user?.email}</span>
        </header>

        <GstConfigBanner />
        <ZeroGstBookingsBanner />

        <main className="flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
