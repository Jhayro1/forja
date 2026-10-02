import {
  CalendarDaysIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleIcon,
  DownloadIcon,
  ListChecksIcon,
  LoaderIcon,
  PlusIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useApp } from '@/app/context';
import { EmptyState, Field, Mono, PageHeader } from '@/components/common';
import { ExcelExportButton } from '@/components/excel-export';
import { RoleBadge } from '@/components/role-badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { useAction, useApiQuery } from '@/hooks/use-api';
import { api } from '@/lib/api';
import { fecha, hora } from '@/lib/format';
import type { Epica, EventoCalendario, HistEpica, Historial as HistorialT, HistSprint, Marca } from '@/lib/types';
import { cn } from '@/lib/utils';

const MARK: Record<Marca, { icon: ReactNode; label: string }> = {
  unida: { icon: <CheckIcon className="size-3.5 text-success" />, label: 'unida' },
  en_curso: { icon: <LoaderIcon className="size-3.5 animate-spin text-brand" />, label: 'en curso' },
  pendiente: { icon: <CircleIcon className="size-3.5 text-muted-foreground" />, label: 'pendiente' },
  bloqueada: { icon: <TriangleAlertIcon className="size-3.5 text-warning" />, label: 'detenida' },
  cancelada: { icon: <XIcon className="size-3.5 text-muted-foreground" />, label: 'cancelada' },
};

const EVENT: Record<EventoCalendario['tipo'], { label: string; dot: string }> = {
  sprint_creado: { label: 'Sprint creado', dot: 'bg-violet-500' },
  sprint_entregado: { label: 'Sprint entregado', dot: 'bg-success' },
  tarea_iniciada: { label: 'Tarea iniciada', dot: 'bg-sky-500' },
  tarea_unida: { label: 'Tarea unida', dot: 'bg-emerald-500' },
  tarea_bloqueada: { label: 'Tarea detenida', dot: 'bg-warning' },
};

const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

function SprintBlock({ s }: { s: HistSprint }) {
  const { openTask } = useApp();
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{s.titulo}</p>
          <p className="text-xs text-muted-foreground">
            {s.fase} · creado {fecha(s.creado)}
            {s.entregado ? ` · entregado ${fecha(s.entregado)}` : ''}
            {s.fecha_objetivo ? ` · objetivo ${s.fecha_objetivo}` : ''}
          </p>
        </div>
        {s.retrasado ? (
          <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
            retrasado
          </Badge>
        ) : null}
        <span className="text-sm tabular-nums">
          {s.hechas}/{s.total}
        </span>
        <Progress value={pct(s.hechas, s.total)} className="h-1.5 w-24" aria-label={`Avance de ${s.titulo}`} />
      </div>
      {s.historias.length ? (
        <div className="divide-y">
          {s.historias.map((h) => (
            <div key={h.id} className="px-4 py-3">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                <ListChecksIcon className="size-4 text-muted-foreground" /> {h.titulo}
                <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
                  {h.hechas}/{h.total}
                </span>
              </p>
              <ul className="space-y-1">
                {h.tareas.map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => openTask(t.id)} className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent/50">
                      <span className="mt-0.5" title={MARK[t.marca].label}>
                        {MARK[t.marca].icon}
                      </span>
                      <Mono className="mt-0.5 text-muted-foreground">{t.id}</Mono>
                      <span className="min-w-0 flex-1">
                        <span className={cn(t.marca === 'unida' && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{t.titulo}</span>
                        {t.resumen ? <span className="block text-xs text-muted-foreground">{t.resumen}</span> : null}
                      </span>
                      {t.rol ? <RoleBadge role={t.rol} className="hidden sm:inline-flex" /> : null}
                      {t.fin ? <span className="hidden text-xs text-muted-foreground md:block">{fecha(t.fin)}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">Sin plan todavía.</p>
      )}
    </div>
  );
}

function Checklist({ h }: { h: HistorialT }) {
  if (!h.epicas.length)
    return (
      <EmptyState icon={<ListChecksIcon />} title="Nada que listar todavía">
        Cuando haya sprints, aquí verás cada tarea con su estado.
      </EmptyState>
    );
  return (
    <Accordion type="multiple" defaultValue={h.epicas.map((e) => e.id ?? 'sin')} className="space-y-3">
      {h.epicas.map((e: HistEpica) => (
        <AccordionItem key={e.id ?? 'sin'} value={e.id ?? 'sin'} className="rounded-xl border bg-muted/30 px-4">
          <AccordionTrigger className="hover:no-underline">
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <span className="truncate text-base font-semibold">{e.titulo}</span>
              {e.estado === 'cerrada' ? <Badge variant="secondary">cerrada</Badge> : null}
              <span className="ml-auto flex items-center gap-2 pr-2 text-sm font-normal text-muted-foreground tabular-nums">
                {e.hechas}/{e.total}
                <Progress value={pct(e.hechas, e.total)} className="hidden h-1.5 w-28 sm:block" aria-label={`Avance de ${e.titulo}`} />
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            {e.objetivo ? <p className="text-sm text-muted-foreground">{e.objetivo}</p> : null}
            {e.sprints.length ? e.sprints.map((s) => <SprintBlock key={s.id} s={s} />) : <p className="text-sm text-muted-foreground">Ningún sprint en esta épica todavía.</p>}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

function Calendar({ events }: { events: EventoCalendario[] }) {
  const { openTask } = useApp();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string>(day(new Date().toISOString()));
  const byDay = useMemo(() => {
    const m = new Map<string, EventoCalendario[]>();
    for (const e of events) m.set(day(e.fecha), [...(m.get(day(e.fecha)) ?? []), e]);
    return m;
  }, [events]);
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
  const today = day(now.toISOString());
  const list = byDay.get(selected) ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="gap-3 py-4">
        <CardHeader className="flex flex-row items-center justify-between px-4">
          <CardTitle className="text-base capitalize">{fecha(first, { month: 'long', year: 'numeric' })}</CardTitle>
          <div className="flex gap-1">
            <Button variant="outline" size="icon" aria-label="Mes anterior" onClick={() => setOffset((o) => o - 1)}>
              <ChevronLeftIcon />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setOffset(0)}>
              Hoy
            </Button>
            <Button variant="outline" size="icon" aria-label="Mes siguiente" onClick={() => setOffset((o) => o + 1)}>
              <ChevronRightIcon />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-4">
          <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
            {['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'].map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d) => {
              const k = day(d.toISOString());
              const evs = byDay.get(k) ?? [];
              const kinds = [...new Set(evs.map((e) => e.tipo))];
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSelected(k)}
                  aria-label={`${fecha(d)}: ${evs.length} eventos`}
                  aria-pressed={selected === k}
                  className={cn(
                    'flex aspect-square min-h-12 flex-col items-start rounded-lg border border-transparent p-1.5 text-left text-xs transition-colors hover:bg-accent sm:aspect-auto sm:h-20',
                    d.getMonth() !== first.getMonth() && 'text-muted-foreground/50',
                    k === today && 'border-brand/40',
                    selected === k && 'bg-accent ring-1 ring-ring',
                  )}
                >
                  <span className={cn('font-medium', k === today && 'text-brand')}>{d.getDate()}</span>
                  {evs.length ? (
                    <span className="mt-auto flex flex-wrap items-center gap-0.5">
                      {kinds.map((t) => (
                        <span key={t} className={cn('size-1.5 rounded-full', EVENT[t].dot)} />
                      ))}
                      <span className="ml-0.5 hidden text-[10px] text-muted-foreground sm:inline">{evs.length}</span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
            {Object.entries(EVENT).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span className={cn('size-2 rounded-full', v.dot)} /> {v.label}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-base">{fecha(`${selected}T12:00:00`, { weekday: 'long', day: 'numeric', month: 'long' })}</CardTitle>
          <CardDescription>{list.length ? `${list.length} evento${list.length === 1 ? '' : 's'}` : 'Sin actividad este día.'}</CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          <ul className="space-y-2">
            {list.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: events of a day are a static list.
              <li key={i} className="flex gap-2 text-sm">
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', EVENT[e.tipo].dot)} />
                <span className="min-w-0">
                  <span className="block text-xs text-muted-foreground">
                    {hora(e.fecha)} · {EVENT[e.tipo].label}
                  </span>
                  {e.tarea ? (
                    <button type="button" className="text-left hover:underline" onClick={() => openTask(e.tarea!)}>
                      <Mono className="text-muted-foreground">{e.tarea}</Mono> {e.titulo}
                    </button>
                  ) : (
                    <span className="font-medium">{e.titulo}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function EpicDialog({ open, onOpenChange, epic }: { open: boolean; onOpenChange: (o: boolean) => void; epic: Epica | null }) {
  const { run } = useAction();
  const [title, setTitle] = useState(epic?.title ?? '');
  const [goal, setGoal] = useState(epic?.goal ?? '');
  const [date, setDate] = useState(epic?.target_date ?? '');
  const save = async () => {
    if (!title.trim()) return toast('Ponle un nombre a la épica', 'error');
    const body = { titulo: title.trim(), objetivo: goal.trim(), fecha_objetivo: date || null };
    if (await run(epic ? `/v1/epicas/${epic.epic_id}` : '/v1/epicas', body)) onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{epic ? 'Editar épica' : 'Nueva épica'}</DialogTitle>
          <DialogDescription>Una épica es un objetivo grande que agrupa varios sprints.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Nombre" htmlFor="epica-nombre">
            <Input id="epica-nombre" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej.: Facturación" />
          </Field>
          <Field label="Objetivo y criterio de cierre" htmlFor="epica-objetivo">
            <Textarea id="epica-objetivo" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Qué tiene que ser verdad para darla por terminada" />
          </Field>
          <Field label="Fecha objetivo (opcional)" htmlFor="epica-fecha" help="Es un objetivo, no una promesa: si se pasa, se marca retrasada y la fecha no se mueve sola.">
            <Input id="epica-fecha" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Epics({ h }: { h: HistorialT }) {
  const { run } = useAction();
  const q = useApiQuery<{ epicas: Epica[]; sprints: { change_id: string; epic_id: string | null; priority: number; target_date: string | null }[] }>('/v1/epicas');
  const [dialog, setDialog] = useState<{ open: boolean; epic: Epica | null }>({ open: false, epic: null });
  const epics = q.data?.epicas ?? [];
  const links = new Map((q.data?.sprints ?? []).map((l) => [l.change_id, l]));
  const sprints = h.epicas.flatMap((e) => e.sprints);
  const assign = (id: string, patch: { epica?: string | null; prioridad?: number; fecha_objetivo?: string | null }) => {
    const cur = links.get(id);
    void run(`/v1/sprints/${id}/epica`, { epica: cur?.epic_id ?? null, prioridad: cur?.priority ?? 0, fecha_objetivo: cur?.target_date ?? null, ...patch }, { quiet: true });
  };
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Organiza los sprints en épicas, con prioridad y fecha objetivo.</p>
        <Button onClick={() => setDialog({ open: true, epic: null })}>
          <PlusIcon /> Nueva épica
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {epics.map((e) => (
          <Card key={e.epic_id} className="gap-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                {e.title} {e.state === 'cerrada' ? <Badge variant="secondary">cerrada</Badge> : null}
              </CardTitle>
              <CardDescription className="line-clamp-3">{e.goal || 'Sin objetivo escrito.'}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setDialog({ open: true, epic: e })}>
                Editar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void run(`/v1/epicas/${e.epic_id}`, { estado: e.state === 'cerrada' ? 'abierta' : 'cerrada' })}>
                {e.state === 'cerrada' ? 'Reabrir' : 'Cerrar'}
              </Button>
            </CardContent>
          </Card>
        ))}
        {!epics.length ? <EmptyState title="Sin épicas">Crea una para agrupar sprints relacionados.</EmptyState> : null}
      </div>
      {sprints.length ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sprint</TableHead>
                <TableHead>Épica</TableHead>
                <TableHead className="w-28">Prioridad</TableHead>
                <TableHead className="w-44">Fecha objetivo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sprints.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="max-w-64 truncate">
                    {s.titulo} <span className="text-xs text-muted-foreground">· {s.fase}</span>
                  </TableCell>
                  <TableCell>
                    <Select value={links.get(s.id)?.epic_id ?? 'ninguna'} onValueChange={(v) => assign(s.id, { epica: v === 'ninguna' ? null : v })}>
                      <SelectTrigger className="h-8 w-48" aria-label={`Épica de ${s.titulo}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ninguna">Sin épica</SelectItem>
                        {epics.map((e) => (
                          <SelectItem key={e.epic_id} value={e.epic_id}>
                            {e.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      key={`p-${s.id}-${links.get(s.id)?.priority ?? 0}`}
                      className="h-8"
                      type="number"
                      min={0}
                      max={1000}
                      defaultValue={links.get(s.id)?.priority ?? 0}
                      aria-label={`Prioridad de ${s.titulo}`}
                      onBlur={(e) => assign(s.id, { prioridad: Number(e.target.value) || 0 })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      key={`f-${s.id}-${links.get(s.id)?.target_date ?? ''}`}
                      className="h-8"
                      type="date"
                      defaultValue={links.get(s.id)?.target_date ?? ''}
                      aria-label={`Fecha objetivo de ${s.titulo}`}
                      onBlur={(e) => assign(s.id, { fecha_objetivo: e.target.value || null })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}
      {dialog.open ? <EpicDialog open onOpenChange={(o) => setDialog({ open: o, epic: dialog.epic })} epic={dialog.epic} /> : null}
    </div>
  );
}

export default function Historial() {
  const q = useApiQuery<{ historial: HistorialT }>('/v1/historial');
  const h = q.data?.historial;
  const download = async () => {
    try {
      const r = await api.get<{ markdown: string }>('/v1/historial/markdown');
      const url = URL.createObjectURL(new Blob([r.markdown], { type: 'text/markdown' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'historial.md';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(`✘ ${(e as Error).message}`, 'error');
    }
  };
  const totals = h ? h.epicas.reduce((acc, e) => ({ hechas: acc.hechas + e.hechas, total: acc.total + e.total }), { hechas: 0, total: 0 }) : null;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Historial"
        description={totals ? `Épica → sprint → historia → tarea. ${totals.hechas} de ${totals.total} tareas unidas en todo el proyecto.` : 'Cargando…'}
        actions={
          <div className="flex flex-wrap gap-2">
            <ExcelExportButton />
            <Button variant="outline" onClick={() => void download()}>
              <DownloadIcon /> Exportar Markdown
            </Button>
          </div>
        }
      />
      {h ? (
        <Tabs defaultValue="lista">
          <TabsList>
            <TabsTrigger value="lista">
              <ListChecksIcon /> Lista de control
            </TabsTrigger>
            <TabsTrigger value="calendario">
              <CalendarDaysIcon /> Calendario
            </TabsTrigger>
            <TabsTrigger value="epicas">
              <CircleDashedIcon /> Épicas
            </TabsTrigger>
          </TabsList>
          <TabsContent value="lista" className="mt-4">
            <Checklist h={h} />
          </TabsContent>
          <TabsContent value="calendario" className="mt-4">
            <Calendar events={h.calendario} />
          </TabsContent>
          <TabsContent value="epicas" className="mt-4">
            <Epics h={h} />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}
