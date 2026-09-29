import { ArrowUpIcon, DownloadCloudIcon, FolderGit2Icon, FolderIcon, FolderOpenIcon, FolderPlusIcon, GitBranchIcon } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '@/app/context';
import { EmptyState, Field, PageHeader, Section, StatusBadge } from '@/components/common';
import { useConfirm } from '@/components/confirm';
import { JobCard } from '@/components/job-card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { useAction, useApiQuery } from '@/hooks/use-api';
import type { Carpetas, Importado, Proyecto, Proyectos as ProyectosData, Trabajo } from '@/lib/types';

function useImport() {
  const { run } = useAction();
  const confirm = useConfirm();
  const { projectChanged } = useApp();
  return async (ruta: string): Promise<boolean> => {
    if (!ruta.trim()) {
      toast('Pega la ruta de la carpeta de tu proyecto', 'error');
      return false;
    }
    let r = await run<Importado>('/v1/proyectos/importar', { ruta });
    if (!r) return false;
    if (r.requiere_confianza) {
      const ok = await confirm({
        title: '¿Confías en esta carpeta?',
        description: `Git no confía en ella porque sus archivos tienen otro dueño (es normal con carpetas de Windows abiertas desde WSL):\n\n${r.ruta_windows || r.ruta}\n\nSi es tu proyecto, Forja la marca como confiable para git (safe.directory) y sigue.`,
        confirm: 'Sí, es mi proyecto',
      });
      if (!ok) return false;
      r = await run<Importado>('/v1/proyectos/importar', { ruta, confiar: true });
      if (!r || r.requiere_confianza) return false;
    }
    if (r.bloqueos?.length) toast(`Importado, pero: ${r.bloqueos.join(' · ')}`, 'error', 10000);
    await projectChanged('inicio');
    return true;
  };
}

function ProjectCard({ p }: { p: Proyecto }) {
  const { go, projectChanged } = useApp();
  const { run } = useAction();
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FolderGit2Icon className="size-4 text-muted-foreground" />
          <span className="truncate">{p.nombre}</span>
        </CardTitle>
        <CardDescription className="truncate font-mono text-xs">{p.ruta_windows || p.ruta}</CardDescription>
        <CardAction className="flex gap-1">
          {p.actual ? <StatusBadge tone="ok">actual</StatusBadge> : null}
          {p.existe ? null : <StatusBadge tone="error">no existe</StatusBadge>}
        </CardAction>
      </CardHeader>
      <CardFooter className="gap-2">
        {p.actual ? (
          <Button size="sm" onClick={() => go('inicio')}>
            Ir al inicio →
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={async () => {
              if (await run(`/v1/proyectos/${p.id}/seleccionar`)) await projectChanged('inicio');
            }}
          >
            Trabajar aquí
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const r = await run(
              `/v1/proyectos/${p.id}/archivar`,
              {},
              { confirm: { title: `¿Archivar «${p.nombre}»?`, description: 'No se borra nada: sólo deja de aparecer aquí.', confirm: 'Archivar' } },
            );
            if (r) await projectChanged('proyectos');
          }}
        >
          Archivar
        </Button>
      </CardFooter>
    </Card>
  );
}

function FolderBrowser({ onPick }: { onPick: (ruta: string) => void }) {
  const [path, setPath] = useState('');
  const q = useApiQuery<Carpetas>(`/v1/carpetas${path ? `?ruta=${encodeURIComponent(path)}` : ''}`);
  if (q.error)
    return (
      <Alert variant="destructive">
        <AlertDescription>{(q.error as Error).message}</AlertDescription>
      </Alert>
    );
  const c = q.data;
  if (!c) return <p className="text-sm text-muted-foreground">Cargando carpetas…</p>;
  return (
    <Card className="gap-4">
      <CardHeader>
        <div className="flex flex-wrap gap-2">
          {c.raices.map((r) => (
            <Button key={r.ruta} size="sm" variant={c.ruta.startsWith(r.ruta) ? 'secondary' : 'outline'} onClick={() => setPath(r.ruta)}>
              {r.nombre}
            </Button>
          ))}
        </div>
        <CardDescription className="pt-2 font-mono text-xs break-all">{c.ruta_windows || c.ruta}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {c.padre ? (
            <Button size="sm" variant="outline" onClick={() => setPath(c.padre!)}>
              <ArrowUpIcon /> Subir
            </Button>
          ) : null}
          <Button size="sm" disabled={!c.repo} onClick={() => onPick(c.ruta)}>
            <FolderOpenIcon /> {c.repo ? 'Usar esta carpeta' : 'Usar esta carpeta (no es un repo git)'}
          </Button>
        </div>
        {c.carpetas.length ? (
          <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
            {c.carpetas.map((f) => (
              <li key={f.ruta}>
                <button type="button" onClick={() => setPath(f.ruta)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent">
                  <FolderIcon className="size-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{f.nombre}</span>
                  {f.repo ? (
                    <StatusBadge tone="ok">
                      <GitBranchIcon /> git
                    </StatusBadge>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No hay subcarpetas.</p>
        )}
      </CardContent>
    </Card>
  );
}

/** «Clonar desde GitHub»: brings a repository to this machine (or server) and registers it. */
function CloneSection() {
  const { run } = useAction();
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [folder, setFolder] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useApiQuery<{ trabajo: Trabajo }>(jobId ? `/v1/sistema/trabajos/${jobId}` : null, { fastPoll: (d) => d?.trabajo.estado === 'corriendo' });
  const start = async () => {
    if (!repo.trim()) return toast('Pega la dirección del repositorio', 'error');
    const r = await run<{ ok?: boolean; mensaje?: string; trabajo?: Trabajo }>('/v1/proyectos/clonar', { repositorio: repo.trim(), carpeta: folder.trim() || null, token: token.trim() || null });
    if (r?.trabajo) {
      setJobId(r.trabajo.id);
      setToken('');
    }
  };
  const t = job.data?.trabajo;
  return (
    <Section title="Clonar desde GitHub" description="Trae un repositorio a esta máquina y lo agrega a tus proyectos, sin usar la terminal.">
      <Card>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Field label="Repositorio" htmlFor="clonar-repo" help="La dirección https de GitHub o sólo usuario/repo, por ejemplo Jhayro1/mi-bodega.">
              <Input id="clonar-repo" placeholder="https://github.com/usuario/repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
            </Field>
          </div>
          <Field label="Token de GitHub (sólo si es privado)" htmlFor="clonar-token" help="Un token de sólo lectura del repositorio. Se usa una vez para clonar y no se guarda en ningún lado.">
            <Input id="clonar-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
          <Field label="Carpeta (opcional)" htmlFor="clonar-carpeta" help="Si lo dejas vacío, va a proyectos/<repo> dentro de tu carpeta personal.">
            <Input id="clonar-carpeta" placeholder="proyectos/mi-repo" value={folder} onChange={(e) => setFolder(e.target.value)} />
          </Field>
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button onClick={() => void start()} disabled={t?.estado === 'corriendo'}>
            <DownloadCloudIcon /> Clonar
          </Button>
          {t?.estado === 'ok' ? <span className="text-sm text-success">✔ Listo: ya aparece en «Tus proyectos».</span> : null}
        </CardFooter>
      </Card>
      {t ? <JobCard job={t} base="/v1/sistema/trabajos" /> : null}
    </Section>
  );
}

export default function Proyectos() {
  const q = useApiQuery<ProyectosData>('/v1/proyectos');
  const { projectChanged, server } = useApp();
  const { run } = useAction();
  const importFolder = useImport();
  const [ruta, setRuta] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [nombre, setNombre] = useState('');
  const [carpeta, setCarpeta] = useState('');
  const data = q.data;
  const list = data?.proyectos ?? [];
  const wsl = data?.wsl ?? false;

  return (
    <div className="space-y-10">
      <PageHeader title="Proyectos" description={`Elige en qué repositorio trabaja Forja. Todo se queda en ${server ? 'este servidor' : 'tu PC'}.`} />
      <Section title="Tus proyectos">
        {list.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {list.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<FolderGit2Icon />} title="Todavía no hay proyectos">
            Agrega la carpeta de tu proyecto para empezar. Tiene que ser un repositorio git.
          </EmptyState>
        )}
      </Section>

      <CloneSection />

      <Section title="Agregar un proyecto existente">
        <Card>
          <CardContent className="space-y-4">
            <Field label="Carpeta del proyecto" htmlFor="ruta" help={wsl ? 'Puedes pegar la ruta de Windows tal cual (clic derecho en la carpeta → «Copiar como ruta de acceso»).' : undefined}>
              <Input
                id="ruta"
                placeholder={wsl ? 'C:\\Users\\tú\\Desktop\\mi-proyecto' : '/home/tú/mi-proyecto'}
                value={ruta}
                onChange={(e) => setRuta(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void importFolder(ruta).then((ok) => ok && setRuta(''))}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void importFolder(ruta).then((ok) => ok && setRuta(''))}>Importar</Button>
              <Button variant="outline" onClick={() => setBrowsing((b) => !b)}>
                <FolderOpenIcon /> {browsing ? 'Ocultar carpetas' : 'Buscar la carpeta…'}
              </Button>
            </div>
          </CardContent>
        </Card>
        {browsing ? <FolderBrowser onPick={(r) => void importFolder(r).then((ok) => ok && setBrowsing(false))} /> : null}
      </Section>

      <Section title="Crear un proyecto nuevo">
        <Card>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Nombre" htmlFor="nombre">
              <Input id="nombre" placeholder="mi-proyecto" value={nombre} onChange={(e) => setNombre(e.target.value)} />
            </Field>
            <Field label="Dónde" htmlFor="donde" help="Si lo dejas vacío, se crea en tu carpeta personal de Linux.">
              <Input id="donde" placeholder={wsl ? 'C:\\Users\\tú\\Desktop (opcional)' : 'carpeta (opcional)'} value={carpeta} onChange={(e) => setCarpeta(e.target.value)} />
            </Field>
          </CardContent>
          <CardFooter>
            <Button
              onClick={async () => {
                if (!nombre.trim()) return toast('Escribe un nombre', 'error');
                if (await run('/v1/proyectos/nuevo', { nombre: nombre.trim(), carpeta: carpeta.trim() || null })) await projectChanged('inicio');
              }}
            >
              <FolderPlusIcon /> Crear
            </Button>
          </CardFooter>
        </Card>
      </Section>
    </div>
  );
}
