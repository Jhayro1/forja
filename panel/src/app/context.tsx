import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Modulos, Proyectos, Textos } from '@/lib/types';

export type ViewId = 'inicio' | 'sprint' | 'tablero' | 'agentes' | 'historial' | 'calidad' | 'planeacion' | 'proyectos' | 'configuracion' | 'acciones' | 'conexiones' | 'auditoria' | 'memoria';

const VIEWS: ReadonlySet<string> = new Set<ViewId>([
  'inicio',
  'sprint',
  'tablero',
  'agentes',
  'historial',
  'calidad',
  'planeacion',
  'proyectos',
  'configuracion',
  'acciones',
  'conexiones',
  'auditoria',
  'memoria',
]);
/** Old names kept so bookmarks keep working. */
const ALIASES: Record<string, ViewId> = { resumen: 'tablero', tareas: 'tablero' };

/** The screen lives in the URL (#/tablero): back/forward and reload keep it. */
function viewFromHash(): ViewId | null {
  const name = location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] ?? '';
  if (VIEWS.has(name)) return name as ViewId;
  return ALIASES[name] ?? null;
}

function taskFromHash(): string | null {
  const m = /^#\/tablero\/(T-\d{1,5})/.exec(location.hash);
  return m?.[1] ?? null;
}

export type AppState = {
  view: ViewId;
  go: (view: ViewId) => void;
  /** Task open in the board's side panel (#/tablero/T-003), kept in the URL. */
  task: string | null;
  openTask: (id: string | null) => void;
  /** Server mode (forja servidor): shows «cerrar sesión» and the account settings. */
  server: boolean;
  modules: string[];
  project: { id: string; nombre: string } | null;
  textos: Textos;
  /** After choosing, importing or creating a project: screens and events change with it. */
  projectChanged: (next?: ViewId) => Promise<void>;
  has: (module: string) => boolean;
};

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp fuera de AppProvider');
  return ctx;
}

async function loadModules(): Promise<Pick<AppState, 'modules' | 'project'>> {
  const r = await api.get<Modulos>('/v1/modulos');
  if (!r.proyecto) return { modules: r.modulos, project: null };
  if (!r.modulos.includes('proyectos')) return { modules: r.modulos, project: { id: r.proyecto, nombre: 'proyecto' } };
  const p = await api.get<Proyectos>('/v1/proyectos');
  const cur = p.proyectos.find((x) => x.actual);
  return { modules: r.modulos, project: cur ? { id: cur.id, nombre: cur.nombre } : { id: r.proyecto, nombre: 'proyecto' } };
}

/** First screen: set up the machine if nothing works yet, then pick a project, then the flow. */
async function firstView(modules: string[], hasProject: boolean): Promise<ViewId> {
  if (modules.includes('sistema')) {
    try {
      const s = await api.get<{ sistema: { estado: string } }>('/v1/sistema');
      if (s.sistema.estado === 'error') return 'configuracion';
    } catch {
      // The flow still works without the diagnosis.
    }
  }
  if (!hasProject) return modules.includes('proyectos') ? 'proyectos' : 'tablero';
  return modules.includes('trabajos') ? 'inicio' : 'tablero';
}

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const client = useQueryClient();
  const [state, setState] = useState<Omit<AppState, 'go' | 'projectChanged' | 'has' | 'openTask' | 'server'> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [textos, mods] = await Promise.all([api.get<{ textos: Textos }>('/v1/textos'), loadModules()]);
      const view = viewFromHash() ?? (await firstView(mods.modules, mods.project !== null));
      if (!location.hash.startsWith(`#/${view}`)) history.replaceState(null, '', `#/${view}`);
      setState({ textos: textos.textos, ...mods, view, task: view === 'tablero' ? taskFromHash() : null });
    })().catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    const onHash = () => {
      const view = viewFromHash();
      const task = view === 'tablero' ? taskFromHash() : null;
      if (view) setState((s) => (s && (s.view !== view || s.task !== task) ? { ...s, view, task } : s));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((view: ViewId) => {
    if (viewFromHash() !== view || taskFromHash()) location.hash = `#/${view}`;
    setState((s) => (s ? { ...s, view, task: null } : s));
  }, []);
  const openTask = useCallback((id: string | null) => {
    location.hash = id ? `#/tablero/${id}` : '#/tablero';
    setState((s) => (s ? { ...s, view: 'tablero', task: id } : s));
  }, []);
  const projectChanged = useCallback(
    async (next: ViewId = 'inicio') => {
      api.clear();
      const mods = await loadModules();
      client.removeQueries();
      const view = mods.project ? next : 'proyectos';
      history.replaceState(null, '', `#/${view}`);
      setState((s) => (s ? { ...s, ...mods, view, task: null } : s));
    },
    [client],
  );

  const value = useMemo<AppState | null>(
    () => (state ? { ...state, go, openTask, projectChanged, server: api.server, has: (m) => state.modules.includes(m) } : null),
    [state, go, openTask, projectChanged],
  );
  if (error)
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-medium">No se pudo cargar el panel</p>
        <p className="text-sm text-muted-foreground">{error}</p>
        <button type="button" className="text-sm underline" onClick={() => location.reload()}>
          Reintentar
        </button>
      </div>
    );
  if (!value) return <>{fallback}</>;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
