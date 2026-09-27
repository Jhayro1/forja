import './index.css';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setNonce } from 'get-nonce';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, Loading } from '@/app/app';
import { AppProvider } from '@/app/context';
import { ConfirmProvider } from '@/components/confirm';
import { Toaster, toast } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError, startSession, takeLinkCode } from '@/lib/api';
import { Login } from '@/screens/login';

// Radix inserts a <style> to lock scrolling behind dialogs; the CSP only accepts it with
// the per-load nonce that `forja ui` writes in this meta tag.
const nonce = document.querySelector<HTMLMetaElement>('meta[name="forja-nonce"]')?.content;
if (nonce && nonce !== '__FORJA_NONCE__') setNonce(nonce);

function Root({ initialError }: { initialError: string | null }) {
  const [expired, setExpired] = useState<string | null>(initialError);
  const [client] = useState(() => {
    const onError = (e: Error) => {
      if (e instanceof ApiError && e.status === 401) setExpired('La sesión venció.');
    };
    return new QueryClient({
      queryCache: new QueryCache({ onError }),
      mutationCache: new MutationCache({ onError }),
      defaultOptions: { queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: true, staleTime: 1000 } },
    });
  });
  if (expired !== null) return <Login message={expired || undefined} />;
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ConfirmProvider>
          <AppProvider
            fallback={
              <div className="p-8">
                <Loading />
              </div>
            }
          >
            <App />
          </AppProvider>
        </ConfirmProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

async function main() {
  let error: string | null = null;
  const code = takeLinkCode();
  try {
    await startSession(code);
  } catch (e) {
    // Without a code, a 401 only means "no session yet": the login screen, without an error.
    error = !code && e instanceof ApiError && e.status === 401 ? '' : (e as Error).message;
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root initialError={error} />
    </StrictMode>,
  );
}

main().catch((e) => toast(String(e), 'error'));
