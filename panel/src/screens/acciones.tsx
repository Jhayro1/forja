import { useApp } from '@/app/context';
import { EmptyState, Mono, PageHeader, Section, StatusBadge } from '@/components/common';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useAction, useApiQuery } from '@/hooks/use-api';
import type { Accion } from '@/lib/types';
import { cn } from '@/lib/utils';

const TONE: Record<string, 'ok' | 'warn' | 'error' | 'muted'> = { confirmada: 'ok', propuesta: 'warn', aprobada: 'warn', desconocido: 'error' };

function ActionCard({ a, vault }: { a: Accion; vault: string | undefined }) {
  const { textos } = useApp();
  const { run } = useAction();
  const pending = a.view_state === 'propuesta';
  const peticion = typeof a.preview.peticion === 'string' ? a.preview.peticion : '';
  return (
    <Card className={cn('gap-4', pending && 'border-warning/40', a.view_state === 'desconocido' && 'border-destructive/40')}>
      <CardHeader>
        <CardTitle className="text-sm">
          <Mono>{a.action_id}</Mono> · {a.type} en «{a.connection}»
        </CardTitle>
        <div>
          <StatusBadge tone={TONE[a.view_state] ?? 'muted'}>{textos.estadoAccion[a.view_state] ?? a.view_state}</StatusBadge>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {Object.entries(a.preview).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-mono text-xs break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
          <dt className="text-muted-foreground">origen</dt>
          <dd>{a.origin}</dd>
          <dt className="text-muted-foreground">hash</dt>
          <dd className="font-mono text-xs break-all">{a.hash}</dd>
        </dl>
        {a.result?.detail ? <p className="mt-3 text-sm">{a.result.detail}</p> : null}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        {pending ? (
          <>
            <Button
              onClick={() =>
                void run(
                  `/v1/acciones/${a.action_id}/aprobar`,
                  { hash: a.hash },
                  { confirm: { title: '¿Aprobar EXACTAMENTE esta acción?', description: `${peticion}\n\nSe ejecuta después (necesita la bóveda).` } },
                )
              }
            >
              Aprobar
            </Button>
            <Button variant="outline" onClick={() => void run(`/v1/acciones/${a.action_id}/descartar`, { motivo: 'descartada desde el panel' })}>
              Descartar
            </Button>
          </>
        ) : null}
        {a.view_state === 'aprobada' && vault === 'abierta' ? (
          <Button onClick={() => void run(`/v1/acciones/${a.action_id}/ejecutar`, { hash: a.hash }, { confirm: { title: '¿Ejecutar AHORA esta acción aprobada?', description: peticion } })}>
            Ejecutar
          </Button>
        ) : null}
        {a.view_state === 'aprobada' ? <Mono className="text-xs text-muted-foreground">forja accion ejecutar {a.action_id}</Mono> : null}
        {a.view_state === 'desconocido' ? (
          <Mono className="text-xs text-muted-foreground">
            forja accion ejecutar {a.action_id} (si el servicio es idempotente) · forja accion conciliar {a.action_id} --efecto si|no --nota "…"
          </Mono>
        ) : null}
      </CardFooter>
    </Card>
  );
}

export default function Acciones() {
  const q = useApiQuery<{ acciones: Accion[] }>('/v1/acciones');
  const b = useApiQuery<{ boveda: string }>('/v1/boveda');
  const list = q.data?.acciones ?? [];
  const vault = b.data?.boveda;
  const waiting = list.filter((a) => a.view_state === 'propuesta');
  return (
    <div className="space-y-10">
      <PageHeader title="Acciones externas" description="Los agentes sólo proponen. Cada acción se aprueba sobre su vista previa exacta (hash) y vence si no se ejecuta." />
      <Alert>
        <AlertDescription>
          {vault === 'abierta'
            ? 'Bóveda abierta: puedes ejecutar aquí las acciones aprobadas.'
            : vault === 'cerrada'
              ? 'La bóveda se cerró por inactividad: vuelve a abrir forja ui --boveda para ejecutar desde aquí.'
              : 'Para ejecutar desde el panel ábrelo con forja ui --boveda; si no, ejecuta en la terminal.'}
        </AlertDescription>
      </Alert>
      {waiting.length ? (
        <Section title={`Esperan tu aprobación (${waiting.length})`}>
          <div className="grid gap-4 md:grid-cols-2">
            {waiting.map((a) => (
              <ActionCard key={a.action_id} a={a} vault={vault} />
            ))}
          </div>
        </Section>
      ) : null}
      <Section title="Todas">
        {list.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {list
              .filter((a) => a.view_state !== 'propuesta')
              .map((a) => (
                <ActionCard key={a.action_id} a={a} vault={vault} />
              ))}
          </div>
        ) : (
          <EmptyState title="No hay acciones" />
        )}
      </Section>
    </div>
  );
}
