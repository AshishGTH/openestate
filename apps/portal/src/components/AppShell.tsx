import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useBranding } from '../lib/branding';

const CUSTOMER_TABS = [
  { to: '/profile', label: 'Profile', icon: '👤' },
  { to: '/property', label: 'Property', icon: '🏢' },
  { to: '/account', label: 'Account', icon: '💳' },
  { to: '/tickets', label: 'Support', icon: '💬' },
  { to: '/security', label: 'Security', icon: '🔒' },
];

const BROKER_TABS = [
  { to: '/broker/dashboard', label: 'Dashboard', icon: '📊' },
  { to: '/broker/nocs', label: 'NOCs', icon: '✅' },
  { to: '/broker/statement', label: 'Statement', icon: '📄' },
  { to: '/security', label: 'Security', icon: '🔒' },
];

/**
 * Mobile-first: a fixed bottom tab bar (thumb-reachable, standard mobile
 * pattern) rather than a desktop sidebar. Content scrolls above it in a
 * width-capped column so the same layout reads fine on a wider viewport
 * too. Branches on user.brokerId (Phase 6 commit 3) — a broker portal
 * session never carries applicantId, and vice versa (PortalAuthService
 * invariant, Phase 6 commit 1), so the two tab sets are mutually exclusive
 * by construction, not by a heuristic guess.
 *
 * Company branding (Phase 6 commit 4, CompanyConfig.logoUrl/primaryColorHex,
 * GET /portal/branding): the accent color can't be baked into Tailwind's
 * compiled utility classes at runtime, so it's set once as a CSS custom
 * property on this shell's root and referenced via inline `style` on the
 * two spots that carry it — the active nav tab and its icon — rather than
 * re-theming every button on every page, which is out of scope for "applied
 * to the portal shell." Falls back to the pre-branding blue-600 hex when a
 * company hasn't configured one, so an unbranded install looks unchanged.
 */
export default function AppShell() {
  const { logout, user } = useAuth();
  const { logoUrl, accentColor } = useBranding();
  const tabs = user?.brokerId ? BROKER_TABS : CUSTOMER_TABS;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col" style={{ '--portal-accent': accentColor } as React.CSSProperties}>
      <header className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {logoUrl ? (
            <img src={logoUrl} alt="Company logo" className="h-7 w-auto max-w-[140px] object-contain shrink-0" />
          ) : (
            <span className="font-semibold text-slate-900 truncate">OpenEstate</span>
          )}
        </div>
        <button
          onClick={() => void logout()}
          className="shrink-0 text-sm text-slate-500 hover:text-slate-700"
        >
          Sign out
        </button>
      </header>

      <main className="flex-1 w-full max-w-lg mx-auto px-4 py-4 pb-20">
        <Outlet />
      </main>

      <nav className="fixed bottom-0 inset-x-0 z-10 bg-white border-t border-slate-200">
        <div className="max-w-lg mx-auto grid grid-cols-5">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `flex flex-col items-center gap-0.5 py-2.5 text-xs ${isActive ? 'font-medium' : 'text-slate-500'}`
              }
              style={({ isActive }) => (isActive ? { color: 'var(--portal-accent)' } : undefined)}
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
