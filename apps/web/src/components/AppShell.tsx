import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { PERMISSIONS } from '@openestate/shared';

const NAV_ITEMS = [
  { label: 'Dashboard', to: '/', icon: 'H' },
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
      { label: 'Company Config', to: '/admin/config', perm: PERMISSIONS.ADMIN_CONFIG_READ },
      { label: 'Audit Log', to: '/admin/audit', perm: PERMISSIONS.ADMIN_AUDIT_READ },
    ],
  },
];

const linkClasses = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm ${
    isActive
      ? 'bg-blue-50 text-blue-700 font-medium'
      : 'text-slate-700 hover:bg-slate-100'
  }`;

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

        <main className="flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
