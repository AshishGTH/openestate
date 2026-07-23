import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';

export interface Branding {
  logoUrl: string | null;
  primaryColorHex: string | null;
}

const DEFAULT_ACCENT = '#2563eb'; // Tailwind blue-600, matches the pre-branding hardcoded shell color.

/** Fetched once per session (auth.tsx already caches the access token for
 * the whole app lifetime) — company branding doesn't change mid-session. */
export function useBranding() {
  const { user } = useAuth();
  const { data } = useQuery<Branding>({
    queryKey: ['portal-branding'],
    queryFn: () => api('/portal/branding'),
    enabled: !!user,
    staleTime: Infinity,
  });

  return {
    logoUrl: data?.logoUrl ?? null,
    accentColor: data?.primaryColorHex ?? DEFAULT_ACCENT,
  };
}
