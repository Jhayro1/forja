import { LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { LogBlock, StatusBadge } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAction, useApiQuery } from '@/hooks/use-api';
import type { Trabajo, TrabajoDetalle } from '@/lib/types';

const JOB_STATE: Record<string, [string, 'ok' | 'warn' | 'error' | 'info' | 'muted']> = {
  corriendo: ['en curso…', 'info'],
  ok: ['terminó bien', 'ok'],
  error: ['falló', 'error'],
  cancelado: ['cancelado', 'muted'],
  interrumpido: ['se interrumpió', 'warn'],
};

/** The latest background job (especificar, dividir, run, instalar…) with its output. */
export function JobCard({ job, base }: { job: Trabajo | null | undefined; base: '/v1/trabajos' | '/v1/sistema/trabajos' }) {
  const [shown, setShown] = useState<string | null>(null);
  const [cancelAsked, setCancelAsked] = useState<string | null>(null);
  const { run } = useAction();
  const running = job?.estado === 'corriendo';
  const open = Boolean(job && (running || job.estado === 'error' || shown === job.id));
  const detail = useApiQuery<TrabajoDetalle>(job && open ? `${base}/${job.id}` : null, { fastPoll: running });
  if (!job) return null;
  const [label, tone] = JOB_STATE[job.estado] ?? [job.estado, 'muted'];
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {running ? <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" /> : null}
          {job.titulo}
        </CardTitle>
        <CardAction>
          <StatusBadge tone={tone}>{label}</StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {open ? (
          <LogBlock lines={detail.data?.salida.slice(-60) ?? []} empty="Esperando la primera línea…" />
        ) : job.ultima_linea ? (
          <p className="truncate font-mono text-xs text-muted-foreground">{job.ultima_linea}</p>
        ) : null}
        <div className="flex gap-2">
          {!running ? (
            <Button variant="outline" size="sm" onClick={() => setShown(open ? null : job.id)}>
              {open ? 'Ocultar salida' : 'Ver salida'}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const force = cancelAsked === job.id;
                setCancelAsked(job.id);
                void run(`${base}/${job.id}/cancelar`, { forzar: force });
              }}
            >
              {cancelAsked === job.id ? 'Forzar la cancelación' : 'Cancelar'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
