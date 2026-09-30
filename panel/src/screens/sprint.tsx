import { CheckIcon, CircleCheckBigIcon, LoaderCircleIcon, PlayIcon, SendIcon, SparklesIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useApp } from '@/app/context';
import { type Attachment, AttachmentChip, AttachmentDropZone, TextWithDocs } from '@/components/chat-attachments';
import { Mono, PageHeader, StatusBadge } from '@/components/common';
import { DeliveryCard } from '@/components/delivery-card';
import { JobCard } from '@/components/job-card';
import { EffortPicker, ModelPicker } from '@/components/model-picker';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { useAction, useApiQuery } from '@/hooks/use-api';
import { estimateText } from '@/lib/format';
import type { Configuracion, Effort, Estado, Planeacion, Pregunta, Trabajo, Trabajos } from '@/lib/types';
import { cn } from '@/lib/utils';

type StartJob = (tipo: string, pregunta?: string) => Promise<unknown>;

function useStartJob(): StartJob {
  const { run } = useAction();
  return (tipo, pregunta) => run('/v1/trabajos', { tipo }, pregunta ? { confirm: { title: pregunta, confirm: 'Seguir' } } : {});
}

function Stepper({ fase }: { fase: string | null }) {
  const { textos } = useApp();
  const order = textos.fases.map(([id]) => id);
  const now = fase ? order.indexOf(fase) : -1;
  return (
    <ol aria-label="Pasos" className="mb-6 flex flex-wrap items-center gap-2">
      {textos.fases.map(([id, label], i) => {
        const done = fase === 'entregado' || (now >= 0 && i < now);
        const current = i === now && fase !== 'entregado';
        return (
          <li key={id} aria-current={current ? 'step' : undefined} className="flex items-center gap-2">
            <span
              className={cn(
                'flex size-6 items-center justify-center rounded-full border text-xs font-medium',
                done && 'border-primary bg-primary text-primary-foreground',
                current && 'border-brand bg-brand/10 text-foreground ring-2 ring-brand/30',
                !done && !current && 'text-muted-foreground',
              )}
            >
              {done ? <CheckIcon className="size-3.5" /> : i + 1}
            </span>
            <span className={cn('text-sm', current ? 'font-medium' : 'text-muted-foreground')}>{label}</span>
            {i < textos.fases.length - 1 ? <span className="mx-1 hidden h-px w-6 bg-border sm:block" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function Bubble({ who, text, meta, thinking, docs = [] }: { who: 'yo' | 'ia'; text: string; meta?: string | null; thinking?: boolean; docs?: string[] }) {
  const mine = who === 'yo';
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[85%] rounded-2xl px-4 py-2.5 text-sm', mine ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted')}>
        <p className={cn('whitespace-pre-wrap', thinking && 'flex items-center gap-2 text-muted-foreground')}>
          {thinking ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
          <TextWithDocs text={text} docs={docs} inverted={mine} />
        </p>
        {docs.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {docs.map((d) => (
              <AttachmentChip key={d} name={d} inverted={mine} />
            ))}
          </div>
        ) : null}
        {meta ? <p className={cn('mt-1 text-[11px]', who === 'yo' ? 'text-primary-foreground/70' : 'text-muted-foreground')}>{meta}</p> : null}
      </div>
    </div>
  );
}

/** Model and effort picked in the chat, remembered in this browser (the planner role's when empty). */
function useStoredChoice(key: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  const set = (v: string) => {
    setValue(v);
    try {
      if (v) localStorage.setItem(key, v);
      else localStorage.removeItem(key);
    } catch {
      // Storage unavailable: the choice lasts until the page reloads.
    }
  };
  return [value, set];
}

function ChatView({ pl, isNew, onSent }: { pl: Planeacion; isNew: boolean; onSent: () => void }) {
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [model, setModel] = useStoredChoice('forja:chat:modelo');
  const [effort, setEffort] = useStoredChoice('forja:chat:esfuerzo');
  const cfg = useApiQuery<{ configuracion: Configuracion }>('/v1/configuracion');
  const catalog = cfg.data?.configuracion.catalogo;
  const { run } = useAction();
  const end = useRef<HTMLDivElement>(null);
  const chat = pl.chat;
  const turns = isNew ? [] : pl.conversacion;
  const disc = isNew ? null : pl.descubrimiento;
  const thinking = chat?.pensando ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the end whenever a message arrives.
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [turns.length, thinking]);

  const addFiles = (added: Attachment[]) => {
    setFiles((f) => [...f, ...added]);
    // Each document is named in the text, where it shows in blue.
    setDraft((d) => {
      const missing = added.filter((a) => !d.includes(`@${a.nombre}`)).map((a) => `@${a.nombre}`);
      return missing.length ? `${d}${d && !d.endsWith(' ') && !d.endsWith('\n') ? ' ' : ''}${missing.join(' ')} ` : d;
    });
  };
  const send = async () => {
    const texto = draft.trim();
    if (!texto && !files.length) return toast('Escribe un mensaje', 'error');
    const body = {
      texto,
      nuevo: isNew,
      ...(files.length ? { adjuntos: files.map((f) => ({ nombre: f.nombre, contenido: f.contenido })) } : {}),
      ...(model ? { modelo: model } : {}),
      ...(effort ? { esfuerzo: effort } : {}),
    };
    if (await run('/v1/planeacion/mensaje', body, { quiet: true })) {
      setDraft('');
      setFiles([]);
      onSent();
    }
  };
  const blockers = disc?.bloqueos ?? [];

  return (
    <div className={cn('grid gap-6', disc && 'lg:grid-cols-[minmax(0,1fr)_320px]')}>
      <Card className="gap-0 py-0">
        <div className="flex max-h-[60vh] min-h-72 flex-col gap-3 overflow-y-auto p-4">
          {!turns.length && !thinking ? (
            <Bubble
              who="ia"
              text="Cuéntame qué quieres construir o mejorar en este proyecto. Te haré preguntas hasta que todo quede claro; después Forja escribe la especificación, la divide en tareas y la programa en paralelo."
              meta={`planeador: ${chat?.planeador ?? '?'} · usa tu cuenta`}
            />
          ) : null}
          {/* The first idea is stored as the change's title, not as the first turn's text. */}
          {turns.length && !turns[0]?.usuario && pl.cambio ? <Bubble who="yo" text={pl.cambio.titulo} /> : null}
          {turns.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: turns only grow at the end.
            <div key={i} className="contents">
              {t.usuario ? <Bubble who="yo" text={t.usuario} docs={t.adjuntos ?? []} /> : null}
              <Bubble who="ia" text={t.planeador} meta={t.modelo} />
            </div>
          ))}
          {thinking ? (
            <>
              <Bubble who="yo" text={thinking.texto} docs={thinking.adjuntos ?? []} />
              <Bubble who="ia" text="Pensando…" meta={`${thinking.modelo ?? chat?.planeador ?? ''} · puede tardar unos minutos`} thinking />
            </>
          ) : null}
          <div ref={end} />
        </div>
        <div className="space-y-3 border-t p-4">
          {chat?.error ? (
            <Alert variant="destructive">
              <AlertDescription>✘ {chat.error}</AlertDescription>
            </Alert>
          ) : null}
          <AttachmentDropZone files={files} onAdd={addFiles} disabled={Boolean(thinking)}>
            <Textarea
              rows={3}
              className="pr-11"
              aria-label="Mensaje para el planeador"
              placeholder={
                turns.length ? 'Responde o agrega detalles… (arrastra aquí tus documentos .md)' : 'Ej.: Quiero que el ERP permita registrar pagos parciales. Puedes arrastrar aquí tu plan en .md'
              }
              value={draft}
              disabled={Boolean(thinking)}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
              }}
            />
          </AttachmentDropZone>
          {files.length ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Documentos adjuntos">
              {files.map((f) => (
                <li key={f.nombre}>
                  <AttachmentChip name={f.nombre} bytes={f.bytes} onRemove={() => setFiles((all) => all.filter((x) => x.nombre !== f.nombre))} />
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void send()} disabled={Boolean(thinking)}>
              {thinking ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
              {thinking ? 'Esperando respuesta…' : 'Enviar'}
            </Button>
            <span className="hidden text-xs text-muted-foreground sm:inline">Ctrl+Enter para enviar</span>
            {catalog ? (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <ModelPicker
                  id="chat-modelo"
                  label="Modelo para planear"
                  value={model}
                  onChange={setModel}
                  models={catalog.modelos.filter((m) => m.estado !== 'retirandose')}
                  optional
                  noneLabel={`Predeterminado (${chat?.planeador ?? 'rol planeador'})`}
                  className="h-8 w-56 text-xs"
                />
                <EffortPicker
                  id="chat-esfuerzo"
                  label="Esfuerzo de razonamiento"
                  value={(effort || null) as Effort | null}
                  onChange={(e) => setEffort(e ?? '')}
                  efforts={catalog.esfuerzos}
                  model={catalog.modelos.find((m) => m.ref === (model || chat?.planeador))}
                  defaultLabel={`Esfuerzo predeterminado${chat?.esfuerzo ? ` (${chat.esfuerzo})` : ''}`}
                  className="h-8 w-48 text-xs"
                />
              </div>
            ) : null}
          </div>
        </div>
      </Card>
      {disc ? (
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Lo acordado hasta ahora</CardTitle>
            <CardDescription>{disc.resumen || 'Todavía no hay resumen.'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {disc.preguntas_abiertas.length ? (
              <div>
                <p className="mb-1 font-medium">Preguntas abiertas</p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {disc.preguntas_abiertas.map((q) => (
                    <li key={q.id}>
                      {q.texto}
                      {q.recomendacion ? ` (sugiero: ${q.recomendacion})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {disc.decisiones.length ? (
              <div>
                <p className="mb-1 font-medium">Decisiones</p>
                <ul className="space-y-1">
                  {disc.decisiones.map((x) => (
                    <li key={x.id} className="flex gap-2">
                      <span className={x.estado === 'aceptada' ? 'text-success' : 'text-muted-foreground'}>{x.estado === 'aceptada' ? '✔' : '?'}</span>
                      {x.contenido}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {blockers.length ? (
              <div>
                <p className="mb-1 font-medium">Falta para seguir</p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-2">
            <Button onClick={() => void run('/v1/planeacion/descubrimiento/aprobar')} disabled={blockers.length > 0 || Boolean(thinking)}>
              Aprobar y seguir →
            </Button>
            {turns.length ? (
              <Button variant="outline" onClick={() => void run('/v1/planeacion/mensaje', { cerrar: true })} disabled={Boolean(thinking)}>
                Cerrar la conversación
              </Button>
            ) : null}
            {blockers.length ? (
              <p className="text-xs text-muted-foreground">Cuando no quede nada pendiente podrás aprobar. «Cerrar la conversación» le pide al planeador que prepare el resumen final.</p>
            ) : null}
          </CardFooter>
        </Card>
      ) : null}
    </div>
  );
}

function QuestionBox({ q }: { q: Pregunta }) {
  const [value, setValue] = useState('');
  const { run } = useAction();
  if (q.respuesta)
    return (
      <p className="text-sm text-muted-foreground">
        <span className="text-success">✔</span> {q.id}: {q.texto} → {q.respuesta}
      </p>
    );
  return (
    <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
      <p className="text-sm">
        <span className="font-medium">{q.id}:</span> {q.texto}
      </p>
      <div className="flex gap-2">
        <Input aria-label={q.texto} placeholder={q.recomendacion ? `Sugerido: ${q.recomendacion}` : 'Tu respuesta'} value={value} onChange={(e) => setValue(e.target.value)} />
        <Button
          variant="outline"
          onClick={() => {
            const v = value.trim() || q.recomendacion || '';
            if (!v) return toast('Escribe una respuesta', 'error');
            void run(`/v1/planeacion/preguntas/${q.id}/respuesta`, { respuesta: v });
          }}
        >
          Responder
        </Button>
      </div>
    </div>
  );
}

function SpecView({ pl, startJob }: { pl: Planeacion; startJob: StartJob }) {
  const e = pl.especificacion;
  const planner = pl.chat?.planeador ?? 'el planeador';
  if (!e)
    return (
      <Card>
        <CardHeader>
          <CardTitle>La conversación quedó aprobada</CardTitle>
          <CardDescription>Ahora Forja convierte lo acordado en una especificación: casos de uso, criterios de aceptación y documentos en tu repositorio.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button onClick={() => void startJob('especificar', `Esto usa ${planner} con tu cuenta y puede tardar unos minutos. ¿Seguir?`)}>
            <SparklesIcon /> Escribir la especificación
          </Button>
        </CardFooter>
      </Card>
    );
  const pending = e.preguntas.filter((q) => !q.respuesta);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Especificación · revisión {e.revision}</CardTitle>
        <CardDescription>
          {e.casos_uso.length} casos de uso · {e.criterios} criterios de aceptación
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {e.casos_uso.slice(0, 16).map((u) => (
            <li key={u.id} className="truncate">
              <Mono className="text-muted-foreground">{u.id}</Mono> {u.nombre}
            </li>
          ))}
        </ul>
        {e.problemas.length ? (
          <Alert variant="destructive">
            <AlertDescription>Hay {e.problemas.length} problema(s): vuelve a escribir la especificación.</AlertDescription>
          </Alert>
        ) : null}
        {e.preguntas.map((q) => (
          <QuestionBox key={q.id} q={q} />
        ))}
        {pending.length ? <p className="text-xs text-muted-foreground">Responde las preguntas y vuelve a escribir la especificación para incorporarlas.</p> : null}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <Button
          disabled={pending.some((q) => q.bloquea?.length) || e.problemas.length > 0}
          onClick={() => void startJob('dividir', `Esto usa ${planner} para dividir el trabajo en tareas con su estimación. ¿Seguir?`)}
        >
          Dividir en tareas →
        </Button>
        <Button variant="outline" onClick={() => void startJob('especificar', 'Se rehace la especificación con tus respuestas. ¿Seguir?')}>
          Volver a escribir la especificación
        </Button>
      </CardFooter>
    </Card>
  );
}

function PlanView({ pl, startJob }: { pl: Planeacion; startJob: StartJob }) {
  const { run } = useAction();
  const p = pl.plan;
  if (!p) return <SpecView pl={pl} startJob={startJob} />;
  const problems = p.problemas_para_aprobar.map((x) => (typeof x === 'string' ? x : (x.mensaje ?? JSON.stringify(x))));
  const profile = problems.some((x) => /perfil|l[ií]nea base/i.test(x));
  const estimate = estimateText(p.estimacion);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Plan · {p.tareas.length} tareas en {p.olas.length} olas
        </CardTitle>
        {estimate ? <CardDescription>{estimate}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-1 text-sm">
          {p.tareas.slice(0, 40).map((t) => (
            <li key={t.id} className="flex gap-2">
              <Mono className="shrink-0 text-muted-foreground">{t.id}</Mono>
              <span className="min-w-0 flex-1">{t.titulo}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t.tipo} · {t.complejidad}
              </span>
            </li>
          ))}
        </ol>
        {problems.length ? (
          <Alert variant="destructive">
            <AlertTitle>Antes de aprobar</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {problems.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {profile ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void startJob('perfil-aprobar')}>
              Aprobar el perfil detectado
            </Button>
            <Button variant="outline" onClick={() => void startJob('linea-base', 'Corre la instalación, el build y los tests de tu proyecto dentro del sandbox. ¿Seguir?')}>
              Medir la línea base (build y tests)
            </Button>
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        {p.aprobado ? (
          <Button onClick={() => void startJob('run', `Forja va a programar ${p.tareas.length} tareas con agentes en paralelo. ${estimate ?? ''} ¿Empezar?`)}>
            <PlayIcon /> Ejecutar
          </Button>
        ) : (
          <>
            <Button disabled={problems.length > 0} onClick={() => void run('/v1/plan/aprobar')}>
              Aprobar el plan
            </Button>
            <Button variant="outline" onClick={() => void startJob('dividir', 'Se vuelve a dividir en tareas. ¿Seguir?')}>
              Rehacer el plan
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}

function RunView({ est, job, startJob }: { est: Estado; job: Trabajo | null; startJob: StartJob }) {
  const { go } = useApp();
  const { run } = useAction();
  const prog = est.progreso;
  const pct = prog.total ? Math.round((prog.integradas / prog.total) * 100) : 0;
  const busy = job?.estado === 'corriendo';
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Ejecutando · {prog.integradas} de {prog.total} tareas integradas
        </CardTitle>
        {prog.minutos_restantes ? <CardDescription>Quedan ~{Math.max(1, Math.round(prog.minutos_restantes))} min (estimado)</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={pct} aria-label="Progreso" />
        {est.pendientes.length ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Necesita tu atención ({est.pendientes.length})</p>
            {est.pendientes.slice(0, 5).map((p) => (
              <div key={p.id} className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                <p>
                  <Mono>{p.id}</Mono> · {p.text}
                </p>
                <p className="text-xs text-muted-foreground">{p.action}</p>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <Button variant="outline" onClick={() => go('tablero')}>
          Ver las tareas en detalle
        </Button>
        {est.run?.activo ? (
          <Button
            variant="outline"
            onClick={() => void run('/v1/run/detener', {}, { confirm: { title: '¿Detener el run?', description: 'Las tareas en curso terminan en orden.', destructive: true, confirm: 'Detener' } })}
          >
            Detener
          </Button>
        ) : null}
        {!est.run?.activo && !busy ? (
          <Button onClick={() => void startJob('run')}>
            <PlayIcon /> Continuar la ejecución
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}

function DeliveredView({ est, startJob, onNew }: { est: Estado; startJob: StartJob; onNew: () => void }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CircleCheckBigIcon className="size-5 text-success" /> Entregado
          </CardTitle>
          <CardDescription>
            Los cambios están en la rama <Mono className="font-medium text-foreground">{est.entrega ?? 'de entrega'}</Mono>. Tu rama principal no se tocó: revísala y mézclala cuando quieras.
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => void startJob('informe')}>
            Ver el informe
          </Button>
          <Button onClick={onNew}>Empezar un cambio nuevo</Button>
        </CardFooter>
      </Card>
      <DeliveryCard />
    </div>
  );
}

export default function Sprint() {
  const [isNew, setNew] = useState(false);
  const jobs = useApiQuery<Trabajos>('/v1/trabajos', { fastPoll: (d) => d?.trabajos[0]?.estado === 'corriendo' });
  const job = jobs.data?.trabajos[0] ?? null;
  const running = job?.estado === 'corriendo';
  // While the planner thinks, poll it faster (its answer is not a domain event yet).
  const pl = useApiQuery<{ planeacion: Planeacion }>('/v1/planeacion', { fastPoll: (d) => running || Boolean(d?.planeacion.chat?.pensando) });
  const est = useApiQuery<{ estado: Estado }>('/v1/estado', { fastPoll: running });
  const startJob = useStartJob();

  if (!pl.data || !est.data) return <PageHeader title="Sprint actual" description="Cargando…" />;
  const planeacion = pl.data.planeacion;
  const fase = isNew ? null : (planeacion.cambio?.fase ?? null);
  const title = planeacion.cambio && !isNew ? planeacion.cambio.titulo : 'Nuevo cambio';

  let body: ReactNode;
  if (!fase || fase === 'cancelado' || fase === 'descubrir') body = <ChatView pl={planeacion} isNew={!fase || fase === 'cancelado'} onSent={() => setNew(false)} />;
  else if (fase === 'especificar' || fase === 'dividir') body = <SpecView pl={planeacion} startJob={startJob} />;
  else if (fase === 'aprobar') body = <PlanView pl={planeacion} startJob={startJob} />;
  else if (fase === 'ejecutar') body = <RunView est={est.data.estado} job={job} startJob={startJob} />;
  else if (fase === 'entregado') body = <DeliveredView est={est.data.estado} startJob={startJob} onNew={() => setNew(true)} />;

  return (
    <div className="space-y-6">
      <PageHeader title={title} actions={est.data.estado.modo_demo ? <StatusBadge tone="warn">Modo demo</StatusBadge> : null} />
      <Stepper fase={fase} />
      {body}
      <JobCard job={job} base="/v1/trabajos" />
    </div>
  );
}
