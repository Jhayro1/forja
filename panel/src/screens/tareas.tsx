import { BotIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '@/app/context';
import { EmptyState, LogBlock, Mono, PageHeader, Section, StatusBadge, taskTone } from '@/components/common';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { useAction, useApiQuery } from '@/hooks/use-api';
import { activityText, tokens } from '@/lib/format';
import type { Estado, Pendiente, Tarea, TareaDetalle } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAUSABLE = ['pendiente', 'lista', 'reservada', 'ejecutando', 'verificando', 'verificada', 'integrando'];
type Tab = 'detalle' | 'registro' | 'diff' | 'instrucciones';

function DiffView({ lines }: { lines: string[] }) {
  return (
    <pre className="max-h-[70vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff is static text.
          key={i}
          className={cn(l.startsWith('+') && !l.startsWith('+++') && 'bg-success/15', l.startsWith('-') && !l.startsWith('---') && 'bg-destructive/15', l.startsWith('@@') && 'text-brand')}
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

function TaskSheet({ id, row, onClose }: { id: string | null; row: Tarea | undefined; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('detalle');
  const { run } = useAction();
  const detail = useApiQuery<{ tarea: TareaDetalle }>(id && tab !== 'diff' ? `/v1/tareas/${id}` : null, { fastPoll: tab === 'registro' });
  const diff = useApiQuery<{ diff: string[] }>(id && tab === 'diff' ? `/v1/tareas/${id}/diff` : null);
  const error = (tab === 'diff' ? diff.error : detail.error) as Error | null;
  return (
    <Sheet open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {id} {row ? <StatusBadge tone={taskTone(row.estado)}>{row.estado}</StatusBadge> : null}
          </SheetTitle>
          <SheetDescription>{row?.titulo}</SheetDescription>
          {row ? (
            <div className="flex gap-2 pt-2">
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
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList>
              <TabsTrigger value="detalle">Detalle</TabsTrigger>
              <TabsTrigger value="registro">Registro</TabsTrigger>
              <TabsTrigger value="diff">Diferencias</TabsTrigger>
              <TabsTrigger value="instrucciones">Instrucciones</TabsTrigger>
            </TabsList>
          </Tabs>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : tab === 'diff' ? (
            <DiffView lines={diff.data?.diff ?? []} />
          ) : (
            <LogBlock className="max-h-[70vh]" lines={detail.data?.tarea[tab] ?? []} empty="—" />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PendingCard({ p }: { p: Pendiente }) {
  const { textos } = useApp();
  const { run } = useAction();
  const [text, setText] = useState('');
  const bad = p.kind === 'tarea_bloqueada';
  let action: React.ReactNode = <p className="font-mono text-xs text-muted-foreground">{p.action}</p>;
  if (p.kind === 'pregunta_tarea')
    action = (
      <div className="space-y-2">
        <Textarea rows={2} aria-label={`Respuesta para ${p.id}`} value={text} onChange={(e) => setText(e.target.value)} />
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
  else if (p.kind === 'aprobacion')
    action = (
      <Button size="sm" onClick={() => void run('/v1/plan/aprobar', {}, { confirm: '¿Aprobar exactamente este plan, esta especificación y esta política?' })}>
        Aprobar plan
      </Button>
    );
  return (
    <Card className={cn('gap-3', bad ? 'border-destructive/40' : 'border-warning/40')}>
      <CardHeader>
        <CardTitle className="text-sm">
          <Mono>{p.id}</Mono> · {textos.pendiente[p.kind] ?? p.kind}
        </CardTitle>
        <CardDescription>{p.text}</CardDescription>
      </CardHeader>
      <CardContent>{action}</CardContent>
    </Card>
  );
}

export default function Tareas() {
  const { textos } = useApp();
  const { run } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const q = useApiQuery<{ estado: Estado }>('/v1/estado', { fastPoll: (d) => Boolean(d?.estado.run?.activo) });
  const d = q.data?.estado;
  if (!d) return <PageHeader title="Tareas" description="Cargando…" />;
  if (!d.cambio)
    return (
      <>
        <PageHeader title="Tareas" />
        <EmptyState title="Sin cambios todavía">Empieza desde Inicio contándole a Forja qué quieres construir.</EmptyState>
      </>
    );
  const phaseIdx = textos.fases.findIndex(([p]) => p === d.cambio!.fase);
  const pct = d.progreso.total ? Math.round((100 * d.progreso.integradas) / d.progreso.total) : 0;
  const agents = d.tareas.filter((t) => t.estado === 'ejecutando' || t.estado === 'reservada');
  const restante =
    d.progreso.minutos_restantes == null
      ? ''
      : ` · ≈${Math.max(1, Math.round(d.progreso.minutos_restantes))} min restantes (${d.progreso.factor_medido == null ? 'estimación del plan' : `estimación ×${d.progreso.factor_medido} según lo medido`})`;

  return (
    <div className="space-y-10">
      <PageHeader
        title={d.cambio.titulo}
        description={`Fase: ${textos.fases[phaseIdx]?.[1] ?? d.cambio.fase}`}
        actions={
          <>
            {d.modo_demo ? <StatusBadge tone="warn">Modo demo</StatusBadge> : null}
            {d.run?.activo ? (
              <Button
                variant="outline"
                onClick={() =>
                  void run('/v1/run/detener', {}, { confirm: { title: '¿Detener el run?', description: 'Los agentes en curso terminan su tarea.', destructive: true, confirm: 'Detener' } })
                }
              >
                Detener run
              </Button>
            ) : null}
          </>
        }
      />
      {d.modo_demo ? (
        <Alert>
          <AlertTitle>Modo demo</AlertTitle>
          <AlertDescription>{textos.modoDemo}</AlertDescription>
        </Alert>
      ) : null}
      {d.run ? (
        <Card>
          <CardContent className="space-y-2">
            <Progress value={pct} aria-label="Progreso" />
            <p className="text-sm">
              {d.progreso.integradas}/{d.progreso.total} integradas · run {d.run.estado}
              {d.run.activo ? ' (en ejecución)' : ''}
              {restante}
            </p>
            {d.run.detalle ? <p className="text-sm text-muted-foreground">{d.run.detalle}</p> : null}
            <p className="text-sm text-muted-foreground">
              Siguiente paso: <Mono>{d.siguiente}</Mono>
            </p>
            {d.entrega ? (
              <p className="text-sm">
                Entregado en <Mono>{d.entrega}</Mono>
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {d.proveedores_en_pausa?.length ? (
        <Alert>
          <AlertTitle>Proveedores en pausa</AlertTitle>
          <AlertDescription className="space-y-2">
            {d.proveedores_en_pausa.map((p) => (
              <div key={p.proveedor} className="flex flex-wrap items-center gap-2">
                {p.proveedor}: hasta {new Date(p.hasta).toLocaleTimeString()} · {p.motivo}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void run(`/v1/proveedores/${encodeURIComponent(p.proveedor)}/reanudar`, {}, { confirm: `¿Ya renovaste la sesión o la cuota de ${p.proveedor}?` })}
                >
                  Reanudar
                </Button>
              </div>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      {d.pendientes.length ? (
        <Section title={`Pendiente de ti (${d.pendientes.length})`}>
          <div className="grid gap-4 md:grid-cols-2">
            {d.pendientes.map((p) => (
              <PendingCard key={`${p.kind}:${p.id}`} p={p} />
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={`Agentes (${agents.length})`}>
        {agents.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {agents.map((t) => (
              <Card key={t.id} className="cursor-pointer gap-2 transition-colors hover:bg-accent/50" onClick={() => setOpen(t.id)}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <BotIcon className="size-4 text-brand" /> {t.id} · <span className="truncate">{t.titulo}</span>
                  </CardTitle>
                  <CardDescription className="font-mono text-xs">{t.modelo}</CardDescription>
                </CardHeader>
                <CardFooter className="text-xs text-muted-foreground">{activityText(t)}</CardFooter>
              </Card>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{d.run?.activo ? 'Ningún agente trabajando en este momento.' : 'Nadie ejecutando: lanza o retoma la ejecución desde Inicio.'}</p>
        )}
      </Section>

      {d.tareas.length ? (
        <Section title={`Tareas (${d.tareas.length})`}>
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tarea</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="hidden md:table-cell">Modelo</TableHead>
                  <TableHead className="hidden md:table-cell">Intento</TableHead>
                  <TableHead>Actividad</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.tareas.map((t) => (
                  <TableRow key={t.id} tabIndex={0} className="cursor-pointer" onClick={() => setOpen(t.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(t.id)}>
                    <TableCell className="max-w-72 truncate">
                      <span className="font-medium">{t.id}</span> {t.titulo}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={taskTone(t.estado)}>{textos.estadoTarea[t.estado] ?? t.estado}</StatusBadge>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">{t.modelo ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">{t.intento}</TableCell>
                    <TableCell className="max-w-80 truncate text-xs text-muted-foreground">{activityText(t)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </Section>
      ) : null}

      {d.registro?.length ? (
        <Section title="Registro">
          <LogBlock lines={d.registro.slice(-30)} />
        </Section>
      ) : null}

      <Section title="Consumo">
        {d.consumo.length ? (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rol</TableHead>
                  <TableHead>Llamadas</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Costo equivalente</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.consumo.map((u) => (
                  <TableRow key={u.role}>
                    <TableCell>{u.role}</TableCell>
                    <TableCell>{u.calls}</TableCell>
                    <TableCell>{u.tokens === null ? 'desconocido' : tokens(u.tokens)}</TableCell>
                    <TableCell>{u.costMicro === null ? 'desconocido' : `${u.costKind === 'medido' ? '' : '≈'}US$ ${(u.costMicro / 1e6).toFixed(2)} (${u.costKind})`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">Sin consumo registrado en este run.</p>
        )}
      </Section>

      <TaskSheet id={open} row={d.tareas.find((t) => t.id === open)} onClose={() => setOpen(null)} />
    </div>
  );
}
