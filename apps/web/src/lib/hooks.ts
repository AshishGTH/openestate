import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { PaginatedResponse } from '@openestate/shared';

export function usePaginatedQuery<T>(
  key: string[],
  path: string,
  params: Record<string, string | number>,
) {
  const qs = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== '' && v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  ).toString();

  return useQuery<PaginatedResponse<T>>({
    queryKey: [...key, params],
    queryFn: () => api(`${path}?${qs}`),
  });
}

export function useApiMutation<TData = unknown, TBody = unknown>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string | ((body: TBody) => string),
  invalidateKeys?: string[][],
) {
  const qc = useQueryClient();
  return useMutation<TData, Error, TBody>({
    mutationFn: (body) => {
      const url = typeof path === 'function' ? path(body) : path;
      return api<TData>(url, {
        method,
        body: method !== 'DELETE' ? JSON.stringify(body) : undefined,
      });
    },
    onSuccess: () => {
      invalidateKeys?.forEach((key) => qc.invalidateQueries({ queryKey: key }));
    },
  });
}
