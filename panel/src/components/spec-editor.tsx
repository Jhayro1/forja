import { useQueryClient } from '@tanstack/react-query';
import { PencilIcon, PlusIcon, SparklesIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Mono, StatusBadge } from '@/components/common';
import { useConfirm } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { useAction } from '@/hooks/use-api';
import { api } from '@/lib/api';
import type { CasoDetalle, CriterioCaso, Planeacion } from '@/lib/types';

type StartJob = (tipo: string, pregunta?: string) => Promise<unknown>;

/**
 * Asking for a change in your own words (flujo/PLAN.md §5): it is recorded and the
 * spec is rewritten redoing only the use cases it touches.
 */
export function SpecChangeBox({ text, setText, startJob }: { text: string; setText: (t: string) => void; startJob: StartJob }) {
  const { run } = useAction();
  const send = async () => {
    const texto = text.trim();
    if (!texto) return toast('Escribe qué quieres cambiar', 'error');
    const r = await run('/v1/planeacion/especificacion/cambios', { texto });
    if (!r) return;
    setText('');
    await startJob('especificar', 'Se reescribe la especificación con tu cambio. Sólo se rehacen los casos de uso que toca. ¿Seguir?');
  };
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Label htmlFor="cambio-spec" className="text-sm font-medium">
        Pedir un cambio
      </Label>
      <Textarea
        id="cambio-spec"
        rows={3}
        placeholder="Ej.: UC-003: el vendedor también puede anular la cotización. O: agrega un caso para exportar a Excel."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void send()}>
          <SparklesIcon /> Aplicar el cambio
        </Button>
        <Button size="sm" variant="outline" onClick={() => setText(`${text ? `${text}\n` : ''}Agrega un caso de uso: `)}>
          <PlusIcon /> Agregar un caso
        </Button>
      </div>
    </div>
  );
}

/** Answers already given and change requests: an answer can be changed later. */
export function GivenAnswers({ pl }: { pl: Planeacion }) {
  const answers = pl.respuestas ?? [];
  const changes = pl.cambios_pedidos ?? [];
  if (!answers.length && !changes.length) return null;
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer font-medium">Respuestas y cambios ya dados ({answers.length + changes.length})</summary>
      <div className="mt-3 space-y-3">
        {answers.map((a) => (
          <AnswerRow key={a.id} id={a.id} question={a.pregunta} answer={a.respuesta} pending={a.pendiente} />
        ))}
        {changes.map((c) => (
          <p key={c.id} className="text-muted-foreground">
            <Mono>{c.id}</Mono> {c.texto} {c.pendiente ? <StatusBadge tone="warn">por aplicar</StatusBadge> : null}
          </p>
        ))}
      </div>
    </details>
  );
}

function AnswerRow({ id, question, answer, pending }: { id: string; question: string; answer: string; pending: boolean }) {
  const { run } = useAction();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(answer);
  if (!editing)
    return (
      <div className="flex flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1">
          <Mono>{id}</Mono> {question} → <span className="font-medium">{answer}</span> {pending ? <StatusBadge tone="warn">por aplicar</StatusBadge> : null}
        </p>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Cambiar respuesta
        </Button>
      </div>
    );
  return (
    <div className="space-y-2">
      <p>
        <Mono>{id}</Mono> {question}
      </p>
      <div className="flex gap-2">
        <Input aria-label={question} value={value} onChange={(e) => setValue(e.target.value)} />
        <Button
          size="sm"
          onClick={async () => {
            if (!value.trim()) return toast('Escribe la respuesta', 'error');
            if (await run(`/v1/planeacion/preguntas/${id}/respuesta`, { respuesta: value.trim() })) setEditing(false);
          }}
        >
          Guardar
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/** «Cambiar» (in words, with the model), «Editar» (by hand, no tokens) and «Quitar» for one use case. */
export function UseCaseActions({ id, name, onAsk }: { id: string; name: string; onAsk: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const confirm = useConfirm();
  const client = useQueryClient();
  const remove = async () => {
    if (
      !(await confirm({
        title: `¿Quitar ${id}?`,
        description: `Se quita «${name}» y sus criterios en una revisión nueva de la especificación (la anterior queda guardada).`,
        confirm: 'Quitar',
        destructive: true,
      }))
    )
      return;
    try {
      const r = await api.delete<{ mensaje?: string }>(`/v1/planeacion/especificacion/casos/${id}`);
      toast(r.mensaje ?? 'Listo');
      await client.invalidateQueries();
    } catch (e) {
      toast(`✘ ${(e as Error).message}`, 'error');
    }
  };
  return (
    <span className="flex shrink-0 gap-0.5">
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onAsk(`${id} (${name}): `)}>
        Cambiar
      </Button>
      <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={`Editar ${id} a mano`} title="Editar a mano (sin modelo)" onClick={() => setEditing(true)}>
        <PencilIcon />
      </Button>
      <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={`Quitar ${id}`} title="Quitar" onClick={() => void remove()}>
        <Trash2Icon />
      </Button>
      {editing ? <UseCaseEditor id={id} onClose={() => setEditing(false)} /> : null}
    </span>
  );
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const list = (text: string) =>
  text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Editing one use case by hand: name, goal, actor, steps and criteria. Everything else
 * (alternate flows, exceptions, rules…) is kept as it is. Forja validates before saving.
 */
function UseCaseEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const { run } = useAction();
  const [data, setData] = useState<CasoDetalle | null>(null);
  const [steps, setSteps] = useState('');
  const [criteria, setCriteria] = useState<CriterioCaso[]>([]);
  // Loaded once per case: a parent re-render (polling) must not wipe what is being typed.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    api
      .get<CasoDetalle>(`/v1/planeacion/especificacion/casos/${id}`)
      .then((d) => {
        setData(d);
        setSteps(d.caso.pasos.map((p) => p.texto).join('\n'));
        setCriteria(d.criterios);
      })
      .catch((e: Error) => {
        toast(`✘ ${e.message}`, 'error');
        close.current();
      });
  }, [id]);
  if (!data) return null;
  const caso = data.caso;
  const set = (patch: Partial<typeof caso>) => setData({ ...data, caso: { ...caso, ...patch } });
  const setCriterion = (i: number, patch: Partial<CriterioCaso>) => setCriteria(criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const save = async () => {
    // Steps keep P1, P2…: flows and exceptions point to them by id.
    const pasos = lines(steps).map((texto, i) => ({ id: `P${i + 1}`, texto }));
    const r = await run(`/v1/planeacion/especificacion/casos/${id}`, { caso: { ...caso, pasos }, criterios: criteria });
    if (r) onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Editar {id} a mano</DialogTitle>
          <DialogDescription>Sin modelo ni tokens. Los flujos alternos, excepciones y reglas se conservan; Forja valida antes de guardar.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="space-y-1">
            <Label htmlFor="uc-nombre">Nombre</Label>
            <Input id="uc-nombre" value={caso.nombre} onChange={(e) => set({ nombre: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="uc-objetivo">Objetivo</Label>
            <Input id="uc-objetivo" value={caso.objetivo} onChange={(e) => set({ objetivo: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="uc-actor">Actor</Label>
            <select id="uc-actor" className="h-9 w-full rounded-md border bg-background px-2" value={caso.actor_id} onChange={(e) => set({ actor_id: e.target.value })}>
              {data.actores.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} · {a.nombre}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="uc-pasos">Pasos (uno por línea: P1, P2…)</Label>
            <Textarea id="uc-pasos" rows={Math.max(4, lines(steps).length + 1)} value={steps} onChange={(e) => setSteps(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="uc-req">Requisitos que cubre (separados por coma)</Label>
            <Input id="uc-req" value={caso.requisitos.join(', ')} onChange={(e) => set({ requisitos: list(e.target.value) })} />
          </div>
          <div className="space-y-2">
            <p className="font-medium">Criterios de aceptación</p>
            {criteria.map((c, i) => (
              <div key={c.id} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <Mono>{c.id}</Mono>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setCriteria(criteria.filter((_, j) => j !== i))}>
                    Quitar
                  </Button>
                </div>
                {(
                  [
                    ['dado', 'Dado'],
                    ['cuando', 'Cuando'],
                    ['entonces', 'Entonces'],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
                    <Label htmlFor={`${c.id}-${key}`} className="text-xs text-muted-foreground">
                      {label}
                    </Label>
                    <Input id={`${c.id}-${key}`} value={c[key]} onChange={(e) => setCriterion(i, { [key]: e.target.value })} />
                  </div>
                ))}
                <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
                  <Label htmlFor={`${c.id}-req`} className="text-xs text-muted-foreground">
                    Requisitos
                  </Label>
                  <Input id={`${c.id}-req`} placeholder="REQ-001, …" value={c.requisitos.join(', ')} onChange={(e) => setCriterion(i, { requisitos: list(e.target.value) })} />
                </div>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const used = new Set(criteria.map((c) => c.id));
                let n = criteria.length + 1;
                while (used.has(`CA-${id}-${String(n).padStart(2, '0')}`)) n++;
                setCriteria([
                  ...criteria,
                  { id: `CA-${id}-${String(n).padStart(2, '0')}`, caso_uso_id: id, requisitos: caso.requisitos.slice(0, 1), dado: '', cuando: '', entonces: '', tipo_evidencia: 'automatica' },
                ]);
              }}
            >
              <PlusIcon /> Agregar criterio
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
