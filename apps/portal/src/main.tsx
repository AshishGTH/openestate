import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';
import { AuthProvider } from './lib/auth';
import { toast, ToastContainer } from './lib/toast';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  // MutationCache's onError fires for every mutation app-wide, in addition
  // to any per-mutation onError/try-catch a component already has (unlike
  // defaultOptions.mutations.onError, which a mutation-level handler would
  // override) — this is what guarantees a failed create always surfaces a
  // reason, without editing every call site.
  mutationCache: new MutationCache({
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Something went wrong.');
    },
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
      <ToastContainer />
    </QueryClientProvider>
  </React.StrictMode>,
);
