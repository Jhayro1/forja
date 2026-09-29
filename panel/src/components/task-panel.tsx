import { PauseIcon, PlayIcon, RotateCcwIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useApp } from '@/app/context';
import { LogBlock, Mono, StatusBadge, taskTone } from '@/components/common';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { useAction, useApiQuery } from '@/hooks/use-api';
import { activityText } from '@/lib/format';
import type { Pendiente, TareaDetalle, TareaV3 } from '@/lib/types';
import { cn } from '@/lib/utils';
import { RoleBadge } from './role-badge';

const PAUSABLE = ['pendiente', 'lista', 'reservada', 'ejecutando', 'verificando', 'verificada', 'integrando'];
type Tab = 'resumen' | 'registro' | 'diff' | 'instrucciones';

export function DiffView({ lines }: { lines: string[] }) {
  if (!lines.length) return <p className="text-sm text-muted-foreground">Todavía no hay cambios.</p>;
  return (
    <pre className="max-h-[65vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff is static text.
          key={i}
          className={cn(
            'px-1',
            l.startsWith('+') && !l.startsWith('+++') && 'bg-success/15',
            l.startsWith('-') && !l.startsWith('---') && 'bg-destructive/15',
            l.startsWith('@@') && 'text-brand',
            l.startsWith('diff --git') && 'mt-3 border-t pt-2 font-semibold text-foreground',
          )}
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/** A task's side panel: what it is, who works on it, its log, diff and exact instructions. */
export function TaskSheet({ id, row, onClose }: { id: string | null; row: TareaV3 | undefined; onClose: () => void }) {
  const { textos } = useApp();
  const [tab, setTab] = useState<Tab>('resumen');
  const [note, setNote] = useState('');
  const { run } = useAction();
  const detail = useApiQuery<{ tarea: TareaDetalle }>(id && (tab === 'registro' || tab === 'instrucciones') ? `/v1/tareas/${id}` : null, { fastPoll: tab === 'registro' });
  const diff = useApiQuery<{ diff: string[] }>(id && tab === 'diff' ? `/v1/tareas/${id}/diff` : null);
  const error = (tab === 'diff' ? diff.error : detail.error) as Error | null;
  return (
    <Sheet open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-3xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            <Mono>{id}</Mono> {row ? <StatusBadge tone={taskTone(row.estado)}>{textos.estadoTarea[row.estado] ?? row.estado}</StatusBadge> : null}
            {row?.rol ? <RoleBadge role={row.rol} /> : null}
          </SheetTitle>
          <SheetDescription className="text-base text-foreground">{row?.titulo}</SheetDescription>
          {row ? (
            <div className="flex flex-wrap gap-2 pt-2">
              {row.estado === 'pausada' ? (
                <Button size="sm" onClick={() => void run(`/v1/tareas/${id}/reanudar`)}>
                  <PlayIcon /> Reanudar
                </Button>
              ) : PAUSABLE.includes(row.estado) ? (
                <Button size="sm" variant="outline" onClick={() => void run(`/v1/tareas/${id}/pausar`)}>
                  <PauseIcon /> Pausar
                </Button>
              ) : null}
            </div>
          ) : null}
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList>
              <TabsTrigger value="resumen">Resumen</TabsTrigger>
              <TabsTrigger value="registro">Registro</TabsTrigger>
              <TabsTrigger value="diff">Cambios</TabsTrigger>
              <TabsTrigger value="instrucciones">Instrucciones</TabsTrigger>
            </TabsList>
          </Tabs>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : tab === 'resumen' && row ? (
            <div className="space-y-5">
              {row.resumen ? (
                <Card className="gap-2 border-success/30 bg-success/5 py-4">
                  <CardContent className="text-sm">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Lo que hizo el agente</p>
                    {row.resumen}
                  </CardContent>
                </Card>
              ) : null}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Fact label="Tipo">{row.tipo ?? '—'}</Fact>
                <Fact label="Modelo">
                  <Mono>{row.modelo ?? '—'}</Mono>
                </Fact>
                <Fact label="Cuenta">{row.cuenta ?? (row.modelo ? 'principal' : '—')}</Fact>
                <Fact label="Intento">{row.intento || '—'}</Fact>
              </div>
              {row.depende_de?.length ? (
                <Fact label="Depende de">
                  <div className="flex flex-wrap gap-1">
                    {row.depende_de.map((d) => (
                      <Mono key={d} className="rounded border px-1.5 py-0.5">
                        {d}
                      </Mono>
                    ))}
                  </div>
                </Fact>
              ) : null}
              {activityText(row) ? <Fact label="Ahora">{activityText(row)}</Fact> : null}
              {row.error ? (
                <Alert variant={row.estado === 'bloqueada' ? 'destructive' : 'default'}>
                  <AlertDescription>{row.error}</AlertDescription>
                </Alert>
              ) : null}
              {row.estado === 'bloqueada' ? (
                <div className="space-y-2">
                  <Textarea rows={2} placeholder="Nota para el siguiente intento (opcional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Nota para reintentar" />
                  <Button size="sm" onClick={() => void run(`/v1/tareas/${id}/reintentar`, { nota: note.trim() })}>
                    <RotateCcwIcon /> Reintentar
                  </Button>
                </div>
              ) : null}
            </div>
          ) : tab === 'diff' ? (
            <DiffView lines={diff.data?.diff ?? []} />
          ) : (
            <LogBlock className="max-h-[65vh]" lines={detail.data?.tarea[tab === 'registro' ? 'registro' : 'instrucciones'] ?? []} empty="—" />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Something that waits for the user, with the action right there. */
export function PendingCard({ p }: { p: Pendiente }) {
  const { textos, go } = useApp();
  const { run } = useAction();
  const [text, setText] = useState('');
  const bad = p.kind === 'tarea_bloqueada';
  let action: ReactNode = <p className="font-mono text-xs text-muted-foreground">{p.action}</p>;
  if (p.kind === 'pregunta_tarea')
    action = (
      <div className="space-y-2">
        <Textarea rows={2} aria-label={`Respuesta para ${p.id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Tu respuesta" />
        <Button size="sm" onClick={() => (text.trim() ? void run(`/v1/tareas/${p.id}/respuesta`, { respuesta: text.trim() }) : toast('Escribe una respuesta', 'error'))}>
          Responder
        </Button>
      </div>
    );
  else if (bad)
    action = (
      <div className="flex gap-2">
        <Input placeholder="Nota para el agente (opcional)" aria-label={`Nota para reintentar ${p.id}`} value={text} onChange={(e) => setText(e.target.value)} />
        <Button size="sm" onClick={() => void run(`/v1/tareas/${p.id}/reintentar`, { nota: text.trim() })}>
          Reintentar
        </Button>
      </div>
    );
  else if (p.kind === 'tarea_pausada')
    action = (
      <Button size="sm" onClick={() => void run(`/v1/tareas/${p.id}/reanudar`)}>
        Reanudar
      </Button>
    );
  else if (p.kind === 'aprobacion' || p.kind === 'pregunta_spec')
    action = (
      <Button size="sm" variant="outline" onClick={() => go('sprint')}>
        Ir al sprint
      </Button>
    );
  return (
    <Card className={cn('gap-3', bad ? 'border-destructive/40' : 'border-warning/40')}>
      <CardHeader>
        <CardTitle className="text-sm">
          <Mono>{p.id}</Mono> · {textos.pendiente[p.kind] ?? p.kind}
        </CardTitle>
        <CardDescription className="whitespace-pre-wrap">{p.text}</CardDescription>
      </CardHeader>
      <CardContent>{action}</CardContent>
    </Card>
  );
}
