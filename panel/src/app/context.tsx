import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Modulos, Proyectos, Textos } from '@/lib/types';

export type ViewId = 'inicio' | 'proyectos' | 'configuracion' | 'resumen' | 'planeacion' | 'acciones' | 'conexiones' | 'auditoria' | 'memoria';

export type AppState = {
  view: ViewId;
  go: (view: ViewId) => void;
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
  if (!hasProject) return modules.includes('proyectos') ? 'proyectos' : 'resumen';
  return modules.includes('trabajos') ? 'inicio' : 'resumen';
}

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const client = useQueryClient();
  const [state, setState] = useState<Omit<AppState, 'go' | 'projectChanged' | 'has'> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [textos, mods] = await Promise.all([api.get<{ textos: Textos }>('/v1/textos'), loadModules()]);
      setState({ textos: textos.textos, ...mods, view: await firstView(mods.modules, mods.project !== null) });
    })().catch((e: Error) => setError(e.message));
  }, []);

  const go = useCallback((view: ViewId) => setState((s) => (s ? { ...s, view } : s)), []);
  const projectChanged = useCallback(
    async (next: ViewId = 'inicio') => {
      api.clear();
      const mods = await loadModules();
      client.removeQueries();
      setState((s) => (s ? { ...s, ...mods, view: mods.project ? next : 'proyectos' } : s));
    },
    [client],
  );

  const value = useMemo<AppState | null>(() => (state ? { ...state, go, projectChanged, has: (m) => state.modules.includes(m) } : null), [state, go, projectChanged]);
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
