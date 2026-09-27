import { CheckIcon, ClipboardCopyIcon, DownloadIcon, LoaderCircleIcon, PlayIcon, RefreshCwIcon, ShieldCheckIcon } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { StatusBadge } from '@/components/common';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress as Bar } from '@/components/ui/progress';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';
import { desktop, type Progress, type Status } from './bridge';

type Phase = 'revisando' | 'wsl' | 'reiniciar' | 'instalar' | 'instalando' | 'abriendo' | 'listo';

const STEPS: [string, Phase[]][] = [
  ['Subsistema de Linux (WSL)', ['wsl', 'reiniciar']],
  ['Instalar Forja', ['instalar', 'instalando']],
  ['Listo', ['abriendo', 'listo']],
];

const PASO: Record<Progress['paso'], string> = {
  descargar: 'Descargando Forja',
  verificar: 'Verificando la descarga',
  importar: 'Creando la distro de Linux',
  comprobar: 'Arrancando Forja',
};

function Steps({ phase }: { phase: Phase }) {
  const now = STEPS.findIndex(([, phases]) => phases.includes(phase));
  return (
    <ol className="flex flex-wrap items-center gap-3" aria-label="Pasos">
      {STEPS.map(([label], i) => (
        <li key={label} className="flex items-center gap-2" aria-current={i === now ? 'step' : undefined}>
          <span
            className={cn(
              'flex size-6 items-center justify-center rounded-full border text-xs font-medium',
              i < now && 'border-primary bg-primary text-primary-foreground',
              i === now && 'border-brand bg-brand/10 ring-2 ring-brand/30',
              i > now && 'text-muted-foreground',
            )}
          >
            {i < now ? <CheckIcon className="size-3.5" /> : i + 1}
          </span>
          <span className={cn('text-sm', i === now ? 'font-medium' : 'text-muted-foreground')}>{label}</span>
          {i < STEPS.length - 1 ? <span className="hidden h-px w-8 bg-border sm:block" /> : null}
        </li>
      ))}
    </ol>
  );
}

function Frame({ phase, children }: { phase: Phase; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-8 p-6">
      <div className="flex items-center gap-3">
        <img src="./forja.svg" alt="" className="size-10" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Forja</h1>
          <p className="text-sm text-muted-foreground">Agentes de código en tu PC</p>
        </div>
      </div>
      {phase !== 'revisando' ? <Steps phase={phase} /> : null}
      <div className="w-full max-w-xl">{children}</div>
    </div>
  );
}

async function copyDiagnosis() {
  try {
    await navigator.clipboard.writeText(await desktop.diagnosis());
    toast('Diagnóstico copiado: pégalo donde pidas ayuda.');
  } catch (e) {
    toast(`✘ ${(e as Error).message ?? e}`, 'error');
  }
}

export function Asistente() {
  // Desde el menú «Estado de la instalación» se muestra el estado sin abrir el panel solo.
  const fromMenu = new URLSearchParams(location.search).has('menu');
  const [status, setStatus] = useState<Status | null>(null);
  const [phase, setPhase] = useState<Phase>('revisando');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openPanel = useCallback(async () => {
    setPhase('abriendo');
    setError(null);
    try {
      const link = await desktop.panelLink();
      location.replace(link);
    } catch (e) {
      setError(String(e));
      setPhase('listo');
    }
  }, []);

  const check = useCallback(
    async (autoOpen: boolean) => {
      setError(null);
      const s = await desktop.status();
      setStatus(s);
      if (!s.wsl) return setPhase('wsl');
      if (!s.distro) return setPhase('instalar');
      if (autoOpen) return openPanel();
      setPhase('listo');
    },
    [openPanel],
  );

  useEffect(() => {
    void check(!fromMenu);
    const off = desktop.onError((m) => toast(`✘ ${m}`, 'error'));
    return () => void off.then((f) => f());
  }, [check, fromMenu]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const errorBox = error ? (
    <Alert variant="destructive">
      <AlertTitle>Algo salió mal</AlertTitle>
      <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
    </Alert>
  ) : null;

  if (phase === 'revisando')
    return (
      <Frame phase={phase}>
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" /> Revisando tu PC…
        </p>
      </Frame>
    );

  if (status && !status.windows)
    return (
      <Frame phase="revisando">
        <Alert>
          <AlertTitle>Esta app es para Windows</AlertTitle>
          <AlertDescription>En Linux instala Forja con scripts/instalar.sh y ábrelo con «forja».</AlertDescription>
        </Alert>
      </Frame>
    );

  if (phase === 'wsl' || phase === 'reiniciar')
    return (
      <Frame phase={phase}>
        <Card>
          <CardHeader>
            <CardTitle>{phase === 'wsl' ? 'Activar el subsistema de Linux' : 'Reinicia Windows'}</CardTitle>
            <CardDescription>
              {phase === 'wsl'
                ? 'Forja aísla a los agentes en Linux (WSL 2), que viene con Windows pero hay que activarlo una vez. Windows te pedirá permiso de administrador y es probable que después pida reiniciar.'
                : 'WSL quedó activado. Reinicia Windows y vuelve a abrir Forja: sigue solo desde aquí.'}
            </CardDescription>
          </CardHeader>
          <CardContent>{errorBox}</CardContent>
          <CardFooter className="gap-2">
            {phase === 'wsl' ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await desktop.enableWsl();
                    const s = await desktop.status();
                    setStatus(s);
                    setPhase(s.wsl ? 'instalar' : 'reiniciar');
                  })
                }
              >
                {busy ? <LoaderCircleIcon className="animate-spin" /> : <ShieldCheckIcon />} Activar WSL
              </Button>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={() => void run(() => check(true))}>
              <RefreshCwIcon /> Revisar de nuevo
            </Button>
          </CardFooter>
        </Card>
      </Frame>
    );

  if (phase === 'instalar' || phase === 'instalando')
    return (
      <Frame phase={phase}>
        <Card>
          <CardHeader>
            <CardTitle>Instalar Forja</CardTitle>
            <CardDescription>
              Se descarga una distro de Linux con todo listo (Forja, Claude Code y Codex, unos 350 MB) y se instala sólo para tu usuario. No crea cuentas ni pide contraseñas; tus proyectos se quedan
              en tu PC.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {phase === 'instalando' && progress ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <LoaderCircleIcon className="size-4 animate-spin" /> {PASO[progress.paso]}
                  </span>
                  <span className="text-muted-foreground">{progress.porcentaje !== null ? `${progress.porcentaje}% · ${progress.detalle}` : progress.detalle}</span>
                </div>
                <Bar value={progress.porcentaje ?? 100} className={progress.porcentaje === null ? 'animate-pulse' : undefined} aria-label="Progreso de la instalación" />
              </div>
            ) : null}
            {errorBox}
          </CardContent>
          <CardFooter className="gap-2">
            <Button
              disabled={phase === 'instalando'}
              onClick={() => {
                setPhase('instalando');
                void run(async () => {
                  try {
                    await desktop.install(setProgress);
                    await check(true);
                  } catch (e) {
                    setPhase('instalar');
                    throw e;
                  }
                });
              }}
            >
              <DownloadIcon /> {error ? 'Reintentar' : 'Instalar'}
            </Button>
            {error ? (
              <Button variant="outline" onClick={() => void copyDiagnosis()}>
                <ClipboardCopyIcon /> Copiar diagnóstico
              </Button>
            ) : null}
          </CardFooter>
        </Card>
      </Frame>
    );

  return (
    <Frame phase={phase}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {phase === 'abriendo' ? <LoaderCircleIcon className="size-5 animate-spin" /> : null}
            {phase === 'abriendo' ? 'Abriendo Forja…' : 'Forja está instalado'}
          </CardTitle>
          <CardDescription>{phase === 'abriendo' ? 'La primera vez del día WSL puede tardar unos segundos en despertar.' : 'Todo corre en tu PC: el panel sólo escucha en 127.0.0.1.'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Forja</dt>
              <dd>
                {status.version_forja} <StatusBadge tone="ok">en «{status.distro}»</StatusBadge>
              </dd>
              <dt className="text-muted-foreground">App</dt>
              <dd>{status.version_app}</dd>
            </dl>
          ) : null}
          {errorBox}
        </CardContent>
        {phase === 'listo' ? (
          <CardFooter className="flex-wrap gap-2">
            <Button onClick={() => void openPanel()}>
              <PlayIcon /> Abrir Forja
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const v = await desktop.update();
                  toast(`Forja actualizado a ${v}`);
                  await check(false);
                })
              }
            >
              {busy ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />} Actualizar Forja
            </Button>
            <Button variant="ghost" onClick={() => void copyDiagnosis()}>
              <ClipboardCopyIcon /> Copiar diagnóstico
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </Frame>
  );
}
