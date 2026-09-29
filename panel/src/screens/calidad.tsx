import { CheckIcon, ClipboardListIcon, ShieldCheckIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '@/app/context';
import { EmptyState, Field, Mono, PageHeader, StatusBadge } from '@/components/common';
import { JobCard } from '@/components/job-card';
import { RoleBadge } from '@/components/role-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useAction, useApiQuery } from '@/hooks/use-api';
import { fechaHora } from '@/lib/format';
import type { EstadoObs, EstadoV3, Observacion, Observaciones, Trabajos } from '@/lib/types';
import { cn } from '@/lib/utils';

const SEVERITY: Record<Observacion['severity'], string> = {
  critica: 'border-destructive/40 bg-destructive/15 text-destructive',
  alta: 'border-destructive/30 bg-destructive/10 text-destructive',
  media: 'border-warning/40 bg-warning/15 text-foreground',
  baja: 'text-muted-foreground',
};
const KIND: Record<Observacion['kind'], string> = { defecto: 'defecto', sugerencia: 'sugerencia', requisito_nuevo: 'requisito nuevo' };
const SOURCE_ROLE: Record<Observacion['source'], string> = { revisor: 'revisor', auditor: 'auditor', qa: 'qa', verificacion: 'trabajador' };
const STATE_LABEL: Record<EstadoObs, string> = {
  abierta: 'abierta',
  en_plan: 'en plan de acción',
  en_correccion: 'en corrección',
  resuelta: 'resuelta',
  descartada: 'descartada',
  pospuesta: 'pospuesta',
};
const FILTERS: { id: string; label: string; states: EstadoObs[] }[] = [
  { id: 'pendientes', label: 'Por decidir', states: ['abierta', 'pospuesta'] },
  { id: 'curso', label: 'En curso', states: ['en_plan', 'en_correccion'] },
  { id: 'cerradas', label: 'Cerradas', states: ['resuelta', 'descartada'] },
  { id: 'todas', label: 'Todas', states: [] },
];

function ObservationRow({ o, checked, onCheck }: { o: Observacion; checked: boolean; onCheck: (v: boolean) => void }) {
  const { run } = useAction();
  const [discard, setDiscard] = useState(false);
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const selectable = o.state === 'abierta' || o.state === 'pospuesta';
  const move = (estado: EstadoObs, motivo?: string) => void run(`/v1/observaciones/${o.obs_id}/estado`, { estado, ...(motivo ? { motivo } : {}) }, { quiet: true });
  return (
    <li className={cn('flex gap-3 px-4 py-3', checked && 'bg-accent/40')}>
      <Checkbox className="mt-1" checked={checked} disabled={!selectable} onCheckedChange={(v) => onCheck(v === true)} aria-label={`Elegir ${o.text}`} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn('rounded-md border px-1.5 py-0.5 text-[11px] font-medium', SEVERITY[o.severity])}>{o.severity}</span>
          <RoleBadge role={SOURCE_ROLE[o.source]} />
          <span className="rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground">{KIND[o.kind]}</span>
          {o.task_id ? <Mono className="text-muted-foreground">{o.task_id}</Mono> : null}
          {o.location ? <Mono className="max-w-64 truncate text-muted-foreground">{o.location}</Mono> : null}
          <StatusBadge tone={o.state === 'resuelta' ? 'ok' : o.state === 'descartada' ? 'muted' : o.state === 'abierta' ? 'warn' : 'info'}>{STATE_LABEL[o.state]}</StatusBadge>
        </div>
        <p className="text-sm">{o.text}</p>
        {o.reason ? <p className="text-xs text-muted-foreground">Motivo: {o.reason}</p> : null}
        {o.evidence ? (
          <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setOpen(!open)}>
            {open ? 'Ocultar evidencia' : 'Ver evidencia'}
          </button>
        ) : null}
        {open && o.evidence ? <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{o.evidence}</pre> : null}
        {discard ? (
          <div className="flex gap-2 pt-1">
            <Textarea rows={1} placeholder="¿Por qué no se hace? Queda en el historial" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motivo para descartar" />
            <Button size="sm" variant="destructive" onClick={() => (reason.trim() ? move('descartada', reason.trim()) : toast('Escribe el motivo', 'error'))}>
              Descartar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDiscard(false)}>
              Cancelar
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {selectable && !discard ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setDiscard(true)}>
              <XIcon /> Descartar
            </Button>
            {o.state === 'abierta' ? (
              <Button size="sm" variant="ghost" onClick={() => move('pospuesta')}>
                Para después
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => move('abierta')}>
                Reabrir
              </Button>
            )}
          </>
        ) : null}
        {o.state === 'en_correccion' ? (
          <Button size="sm" variant="outline" onClick={() => move('resuelta')}>
            <CheckIcon /> Confirmar resuelta
          </Button>
        ) : null}
        {o.state === 'descartada' || o.state === 'resuelta' ? (
          <Button size="sm" variant="ghost" onClick={() => move('abierta')}>
            Reabrir
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export default function Calidad() {
  const { go } = useApp();
  const { run } = useAction();
  const [filter, setFilter] = useState('pendientes');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [planOpen, setPlanOpen] = useState(false);
  const [note, setNote] = useState('');
  const q = useApiQuery<{ observaciones: Observaciones }>('/v1/observaciones');
  const est = useApiQuery<{ estado: EstadoV3 }>('/v1/estado');
  const jobs = useApiQuery<Trabajos>('/v1/trabajos', { fastPoll: (d) => d?.trabajos[0]?.estado === 'corriendo' });
  const data = q.data?.observaciones;
  const states = FILTERS.find((f) => f.id === filter)!.states;
  const list = useMemo(() => (data?.lista ?? []).filter((o) => !states.length || states.includes(o.state)), [data, states]);
  const job = jobs.data?.trabajos.find((j) => j.tipo === 'validar') ?? null;
  const phase = est.data?.estado.cambio?.fase;
  const selected = (data?.lista ?? []).filter((o) => chosen.has(o.obs_id));
  const v = data?.validacion;

  const createPlan = async () => {
    const r = await run('/v1/observaciones/plan', { ids: [...chosen], nota: note.trim() });
    if (r) {
      setPlanOpen(false);
      setChosen(new Set());
      setNote('');
      go('sprint');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calidad"
        description="Lo que dejan revisión, auditoría y QA. Nada se corrige solo: tú decides qué entra en un plan de acción."
        actions={
          <Button
            disabled={phase !== 'entregado' || job?.estado === 'corriendo'}
            onClick={() =>
              void run(
                '/v1/trabajos',
                { tipo: 'validar' },
                {
                  confirm: {
                    title: '¿Validar el sprint entregado?',
                    description:
                      'QA compila y prueba la entrega completa y revisa cada criterio; el auditor busca secretos, operaciones destructivas y riesgos. Usa los modelos de QA y auditor con tu cuenta.',
                    confirm: 'Validar',
                  },
                },
              )
            }
          >
            <ShieldCheckIcon /> Validar el sprint
          </Button>
        }
      />
      {phase && phase !== 'entregado' ? (
        <Alert>
          <AlertTitle>La validación completa se hace sobre un sprint entregado</AlertTitle>
          <AlertDescription>Mientras tanto, aquí aparecen las observaciones que dejó el revisor en cada tarea y las tareas que no pasaron la verificación.</AlertDescription>
        </Alert>
      ) : null}
      {job ? <JobCard job={job} base="/v1/trabajos" /> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(['abierta', 'pospuesta', 'en_correccion', 'resuelta'] as EstadoObs[]).map((s) => (
          <Card key={s} className="gap-1 p-4">
            <p className="text-xs text-muted-foreground">{STATE_LABEL[s][0]!.toUpperCase() + STATE_LABEL[s].slice(1)}</p>
            <p className="text-3xl font-semibold tabular-nums">{data?.conteo[s] ?? '—'}</p>
          </Card>
        ))}
      </div>

      {v ? (
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="text-base">Última validación</CardTitle>
            <CardDescription>
              {fechaHora(v.fecha)} sobre <Mono>{v.commit.slice(0, 10)}</Mono> · {v.observaciones} observación(es)
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {v.comprobaciones.map((c) => (
              <StatusBadge key={c.paso} tone={c.ok === null ? 'muted' : c.ok ? 'ok' : 'error'}>
                {c.ok === null ? '·' : c.ok ? '✔' : '✘'} {c.paso.replace('_', ' ')}
                {c.ok === null ? ' (no comprobado)' : ''}
              </StatusBadge>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-base">Observaciones</CardTitle>
          <CardAction className="flex flex-wrap items-center gap-2">
            <ToggleGroup type="single" variant="outline" size="sm" value={filter} onValueChange={(x) => x && setFilter(x)} aria-label="Filtrar observaciones">
              {FILTERS.map((f) => (
                <ToggleGroupItem key={f.id} value={f.id}>
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </CardAction>
        </CardHeader>
        <CardContent className="p-0">
          {list.length ? (
            <ul className="divide-y">
              {list.map((o) => (
                <ObservationRow
                  key={o.obs_id}
                  o={o}
                  checked={chosen.has(o.obs_id)}
                  onCheck={(c) =>
                    setChosen((s) => {
                      const n = new Set(s);
                      if (c) n.add(o.obs_id);
                      else n.delete(o.obs_id);
                      return n;
                    })
                  }
                />
              ))}
            </ul>
          ) : (
            <div className="p-6">
              <EmptyState icon={<ClipboardListIcon />} title="Nada aquí">
                {filter === 'pendientes' ? 'No hay observaciones por decidir.' : 'No hay observaciones con ese filtro.'}
              </EmptyState>
            </div>
          )}
        </CardContent>
        {chosen.size ? (
          <CardFooter className="sticky bottom-0 flex-wrap gap-2 border-t bg-card/95 py-3 backdrop-blur">
            <span className="text-sm">
              {chosen.size} elegida{chosen.size === 1 ? '' : 's'}
            </span>
            <Button className="ml-auto" onClick={() => setPlanOpen(true)}>
              <SparklesIcon /> Crear plan de acción
            </Button>
          </CardFooter>
        ) : null}
      </Card>

      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Plan de acción</DialogTitle>
            <DialogDescription>
              Se crea un sprint nuevo de correcciones con estas {selected.length} observación(es). El orquestador propone las tareas; tú las revisas, cambias y apruebas antes de que se ejecute nada.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border p-3 text-sm">
            {selected.map((o) => (
              <li key={o.obs_id} className="flex gap-2">
                <span className={cn('h-fit rounded-md border px-1.5 text-[11px]', SEVERITY[o.severity])}>{o.severity}</span>
                <span className="min-w-0">{o.text}</span>
              </li>
            ))}
          </ul>
          <Field label="Indicaciones para el plan (opcional)" htmlFor="plan-nota" help="Por ejemplo: «prioriza lo de seguridad» o «no toques la base de datos».">
            <Textarea id="plan-nota" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlanOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void createPlan()}>Crear el sprint de correcciones</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
