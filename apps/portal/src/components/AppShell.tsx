import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const CUSTOMER_TABS = [
  { to: '/profile', label: 'Profile', icon: '👤' },
  { to: '/property', label: 'Property', icon: '🏢' },
  { to: '/account', label: 'Account', icon: '💳' },
  { to: '/tickets', label: 'Support', icon: '💬' },
];

/**
 * Mobile-first: a fixed bottom tab bar (thumb-reachable, standard mobile
 * pattern) rather than a desktop sidebar. Content scrolls above it in a
 * width-capped column so the same layout reads fine on a wider viewport
 * too. Broker tabs land in commit 3 — this shell is written to be reused
 * as-is, branching on user.brokerId, rather than rebuilt.
 */
export default function AppShell() {
  const { logout } = useAuth();
  const tabs = CUSTOMER_TABS;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
        <span className="font-semibold text-slate-900">OpenEstate</span>
        <button
          onClick={() => void logout()}
          className="text-sm text-slate-500 hover:text-slate-700"
        >
          Sign out
        </button>
      </header>

      <main className="flex-1 w-full max-w-lg mx-auto px-4 py-4 pb-20">
        <Outlet />
      </main>

      <nav className="fixed bottom-0 inset-x-0 z-10 bg-white border-t border-slate-200">
        <div className="max-w-lg mx-auto grid grid-cols-4">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `flex flex-col items-center gap-0.5 py-2.5 text-xs ${
                  isActive ? 'text-blue-600 font-medium' : 'text-slate-500'
                }`
              }
            >
              <span className="text-lg leading-none">{tab.icon}</span>
              {tab.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
