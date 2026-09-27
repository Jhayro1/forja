import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export type LiveStatus = 'sin-proyecto' | 'conectando' | 'en-vivo' | 'reconectando';

/** Domain events of the current project (SSE): any event refreshes what is on screen. */
export function useLiveEvents(projectId: string | null): LiveStatus {
  const client = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>(projectId ? 'conectando' : 'sin-proyecto');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!projectId) {
      setStatus('sin-proyecto');
      return;
    }
    setStatus('conectando');
    const es = new EventSource('/v1/eventos');
    const refresh = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void client.invalidateQueries(), 300);
    };
    es.addEventListener('open', () => setStatus('en-vivo'));
    es.addEventListener('error', () => setStatus('reconectando'));
    es.addEventListener('snapshot', refresh);
    es.addEventListener('evento', refresh);
    return () => {
      clearTimeout(timer.current);
      es.close();
    };
  }, [projectId, client]);

  return status;
}
