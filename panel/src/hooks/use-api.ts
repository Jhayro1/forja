import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { type ConfirmOptions, useConfirm } from '@/components/confirm';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api';
import type { Mutation } from '@/lib/types';

/**
 * A GET of the local API, kept fresh by the SSE feed (useLiveEvents) and, while
 * something is in progress, by `fastPoll`. `path: null` = not now.
 */
export function useApiQuery<T>(path: string | null, options: { fastPoll?: boolean | ((data: T | undefined) => boolean) } = {}): UseQueryResult<T> {
  const { fastPoll } = options;
  return useQuery({
    queryKey: [path],
    queryFn: () => api.get<T>(path!),
    enabled: path !== null,
    refetchInterval: (q) => ((typeof fastPoll === 'function' ? fastPoll(q.state.data as T | undefined) : fastPoll) ? 1500 : 5000),
  });
}

type ActionOptions = { confirm?: ConfirmOptions | string; ok?: string; quiet?: boolean };

/**
 * POST with the panel's conventions: optional confirmation, a toast with the result,
 * every read refreshed afterwards. Resolves to the answer, or null if it failed/was cancelled.
 */
export function useAction() {
  const client = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T extends Mutation>(path: string, body: object = {}, options: ActionOptions = {}): Promise<T | null> => {
      if (options.confirm && !(await confirm(options.confirm))) return null;
      setBusy(path);
      try {
        const r = await api.post<T>(path, body);
        if (!options.quiet) toast(r.mensaje || options.ok || 'Listo');
        await client.invalidateQueries();
        return r;
      } catch (e) {
        toast(`✘ ${(e as Error).message}`, 'error');
        return null;
      } finally {
        setBusy(null);
      }
    },
    [client, confirm],
  );
  return { run, busy };
}
