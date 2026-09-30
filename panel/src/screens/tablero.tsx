import { BotIcon, KanbanSquareIcon, ListIcon, PlayIcon, SearchIcon, SquareIcon, TriangleAlertIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '@/app/context';
import { BlockRunDialog } from '@/components/block-run';
import { EmptyState, Mono, PageHeader, Section, StatusBadge, taskTone } from '@/components/common';
import { JobCard } from '@/components/job-card';
import { RoleBadge } from '@/components/role-badge';
import { PendingCard, TaskSheet } from '@/components/task-panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useAction, useApiQuery } from '@/hooks/use-api';
import { activityText, hora, tokens } from '@/lib/format';
import type { EstadoV3, TareaV3, Trabajos } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Board columns of v3 §3: the domain keeps its 13 states, the board groups them. */
const COLUMNS: { id: string; title: string; states: string[]; accent: string }[] = [
  { id: 'pendiente', title: 'Pendiente', states: ['pendiente'], accent: 'bg-muted-foreground/40' },
  { id: 'lista', title: 'Lista', states: ['lista'], accent: 'bg-sky-500' },
  { id: 'curso', title: 'En curso', states: ['reservada', 'ejecutando'], accent: 'bg-brand' },
  { id: 'validacion', title: 'En validación', states: ['verificando', 'verificada', 'integrando'], accent: 'bg-amber-500' },
  { id: 'hecha', title: 'Unida', states: ['integrada'], accent: 'bg-success' },
];
const HELD = ['bloqueada', 'esperando_respuesta', 'pausada'];

function TaskCard({ t, onOpen }: { t: TareaV3; onOpen: () => void }) {
  const { textos } = useApp();
  const live = t.estado === 'ejecutando' || t.estado === 'reservada';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group w-full rounded-lg border bg-card p-3 text-left shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        live && 'border-brand/40',
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <Mono className="text-muted-foreground">{t.id}</Mono>
        {t.rol ? <RoleBadge role={t.rol} /> : null}
        {live ? <BotIcon className="ml-auto size-4 animate-pulse text-brand" /> : null}
      </div>
      <p className="line-clamp-2 text-sm leading-snug font-medium">{t.titulo}</p>
      {t.resumen && t.estado === 'integrada' ? <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{t.resumen}</p> : null}
      {live || t.estado === 'lista' ? <p className="mt-1.5 line-clamp-1 text-xs text-muted-foreground">{activityText(t)}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {t.modelo ? <span className="font-mono">{t.modelo.replace(/^(claude|codex):/, '')}</span> : null}
        {t.cuenta && t.cuenta !== 'principal' ? <span>@{t.cuenta}</span> : null}
        {t.intento > 1 ? <span>· intento {t.intento}</span> : null}
        {t.depende_de?.length && (t.estado === 'pendiente' || t.estado === 'lista') ? <span>· espera {t.depende_de.join(', ')}</span> : null}
        {!['pendiente', 'lista', 'integrada'].includes(t.estado) && !live ? <span>· {textos.estadoTarea[t.estado] ?? t.estado}</span> : null}
      </div>
    </button>
  );
}

export default function Tablero() {
  const { textos, task, openTask, go } = useApp();
  const { run } = useAction();
  const [mode, setMode] = useState<'columnas' | 'tabla'>('columnas');
  const [filter, setFilter] = useState('');
  const [role, setRole] = useState<string>('todos');
  const [blockOpen, setBlockOpen] = useState(false);
  const q = useApiQuery<{ estado: EstadoV3 }>('/v1/estado', { fastPoll: (d) => Boolean(d?.estado.run?.activo) });
  const jobs = useApiQuery<Trabajos>('/v1/trabajos', { fastPoll: (j) => j?.trabajos[0]?.estado === 'corriendo' });
  const blockJob = jobs.data?.trabajos.find((j) => j.tipo === 'run-bloque') ?? null;
  const d = q.data?.estado;
  const tasks = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return (d?.tareas ?? []).filter((t) => (!text || `${t.id} ${t.titulo}`.toLowerCase().includes(text)) && (role === 'todos' || t.rol === role || (role === 'trabajador' && t.rol === 'complejo')));
  }, [d, filter, role]);

  if (!d) return <PageHeader title="Tablero" description="Cargando…" />;
  if (!d.cambio)
    return (
      <>
        <PageHeader title="Tablero" />
        <EmptyState icon={<KanbanSquareIcon />} title="Todavía no hay un sprint">
          Empieza en{' '}
          <button type="button" className="underline" onClick={() => go('sprint')}>
            Sprint actual
          </button>{' '}
          contándole a Forja qué quieres construir.
        </EmptyState>
      </>
    );

  const held = tasks.filter((t) => HELD.includes(t.estado));
  const canRunBlock = ['aprobar', 'ejecutar'].includes(d.cambio.fase) && d.tareas.some((t) => !['integrada', 'cancelada', 'invalidada'].includes(t.estado));
  const pct = d.progreso.total ? Math.round((100 * d.progreso.integradas) / d.progreso.total) : 0;
  const roles = [...new Set((d.tareas ?? []).map((t) => t.rol).filter(Boolean))] as string[];

  return (
    <div className="space-y-6">
      <PageHeader
        title={d.cambio.titulo}
        description={
          d.run
            ? `${d.progreso.integradas} de ${d.progreso.total} tareas unidas${d.progreso.minutos_restantes ? ` · ≈${Math.max(1, Math.round(d.progreso.minutos_restantes))} min restantes (estimado)` : ''}`
            : 'El plan todavía no se ejecuta.'
        }
        actions={
          d.run?.activo ? (
            <Button
              variant="outline"
              onClick={() =>
                void run('/v1/run/detener', {}, { confirm: { title: '¿Detener el run?', description: 'Los agentes en curso terminan su tarea en orden.', destructive: true, confirm: 'Detener' } })
              }
            >
              <SquareIcon /> Detener
            </Button>
          ) : canRunBlock ? (
            <Button onClick={() => setBlockOpen(true)}>
              <PlayIcon /> Ejecutar con un agente
            </Button>
          ) : null
        }
      />
      {blockJob && (blockJob.estado === 'corriendo' || d.run?.activo) ? <JobCard job={blockJob} base="/v1/trabajos" /> : null}
      <BlockRunDialog open={blockOpen} onOpenChange={setBlockOpen} tasks={d.tareas} />
      {d.run ? <Progress value={pct} aria-label="Avance del sprint" /> : null}

      {d.proveedores_en_pausa?.length ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Cuentas en pausa</AlertTitle>
          <AlertDescription className="space-y-2">
            {d.proveedores_en_pausa.map((p) => (
              <div key={p.proveedor} className="flex flex-wrap items-center gap-2">
                <Mono>{p.proveedor}</Mono> hasta {hora(p.hasta)} · {p.motivo}
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
        <Section title={`Te necesita (${d.pendientes.length})`}>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {d.pendientes.map((p) => (
              <PendingCard key={`${p.kind}:${p.id}`} p={p} />
            ))}
          </div>
        </Section>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <SearchIcon className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Buscar tarea…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Buscar tarea" />
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" value={role} onValueChange={(v) => setRole(v || 'todos')} aria-label="Filtrar por rol">
          <ToggleGroupItem value="todos">Todos</ToggleGroupItem>
          {roles.map((r) => (
            <ToggleGroupItem key={r} value={r}>
              <RoleBadge role={r} className="border-0 bg-transparent p-0" />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(v) => v && setMode(v as 'columnas' | 'tabla')} className="ml-auto" aria-label="Vista">
          <ToggleGroupItem value="columnas" aria-label="Columnas">
            <KanbanSquareIcon />
          </ToggleGroupItem>
          <ToggleGroupItem value="tabla" aria-label="Tabla">
            <ListIcon />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {held.length ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">
            <TriangleAlertIcon className="size-4" /> Detenidas ({held.length})
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {held.map((t) => (
              <TaskCard key={t.id} t={t} onOpen={() => openTask(t.id)} />
            ))}
          </div>
        </div>
      ) : null}

      {mode === 'columnas' ? (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
          <div className="grid min-w-[900px] grid-cols-5 gap-3">
            {COLUMNS.map((c) => {
              const list = tasks.filter((t) => c.states.includes(t.estado));
              return (
                <section key={c.id} aria-label={c.title} className="flex min-h-40 flex-col rounded-xl bg-muted/50 p-2">
                  <header className="mb-2 flex items-center gap-2 px-1 py-1">
                    <span className={cn('size-2 rounded-full', c.accent)} />
                    <h2 className="text-sm font-medium">{c.title}</h2>
                    <span className="ml-auto rounded-full bg-background px-2 text-xs text-muted-foreground">{list.length}</span>
                  </header>
                  <div className="flex flex-1 flex-col gap-2">
                    {list.map((t) => (
                      <TaskCard key={t.id} t={t} onOpen={() => openTask(t.id)} />
                    ))}
                    {!list.length ? <p className="px-1 py-6 text-center text-xs text-muted-foreground">—</p> : null}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tarea</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="hidden md:table-cell">Rol</TableHead>
                <TableHead className="hidden md:table-cell">Modelo · cuenta</TableHead>
                <TableHead className="hidden lg:table-cell">Intento</TableHead>
                <TableHead>Actividad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow key={t.id} tabIndex={0} className="cursor-pointer" onClick={() => openTask(t.id)} onKeyDown={(e) => e.key === 'Enter' && openTask(t.id)}>
                  <TableCell className="max-w-72 truncate">
                    <Mono className="text-muted-foreground">{t.id}</Mono> {t.titulo}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={taskTone(t.estado)}>{textos.estadoTarea[t.estado] ?? t.estado}</StatusBadge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{t.rol ? <RoleBadge role={t.rol} /> : '—'}</TableCell>
                  <TableCell className="hidden font-mono text-xs md:table-cell">
                    {t.modelo ?? '—'}
                    {t.cuenta && t.cuenta !== 'principal' ? ` @${t.cuenta}` : ''}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{t.intento}</TableCell>
                  <TableCell className="max-w-80 truncate text-xs text-muted-foreground">{t.resumen && t.estado === 'integrada' ? t.resumen : activityText(t)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {d.consumo.length ? (
        <Section title="Consumo del run">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {d.consumo.map((u) => (
              <Card key={u.role} className="gap-1 p-4">
                <RoleBadge role={u.role} className="w-fit" />
                <p className="text-2xl font-semibold tabular-nums">{u.tokens === null ? '—' : tokens(u.tokens)}</p>
                <p className="text-xs text-muted-foreground">
                  tokens · {u.calls} llamada{u.calls === 1 ? '' : 's'}
                  {u.costMicro !== null ? ` · ${u.costKind === 'medido' ? '' : '≈'}US$ ${(u.costMicro / 1e6).toFixed(2)}` : ''}
                </p>
              </Card>
            ))}
          </div>
        </Section>
      ) : null}

      <TaskSheet id={task} row={d.tareas.find((t) => t.id === task)} onClose={() => openTask(null)} />
    </div>
  );
}
