import { type ComponentType, lazy, Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useLiveEvents } from '@/hooks/use-live-events';
import { useApp, type ViewId } from './context';
import { Shell } from './shell';

// Each screen is its own chunk: the first load only brings what it shows.
const SCREENS: Record<ViewId, ComponentType> = {
  inicio: lazy(() => import('@/screens/inicio')),
  sprint: lazy(() => import('@/screens/sprint')),
  tablero: lazy(() => import('@/screens/tablero')),
  agentes: lazy(() => import('@/screens/agentes')),
  historial: lazy(() => import('@/screens/historial')),
  calidad: lazy(() => import('@/screens/calidad')),
  proyectos: lazy(() => import('@/screens/proyectos')),
  configuracion: lazy(() => import('@/screens/configuracion')),
  planeacion: lazy(() => import('@/screens/planeacion')),
  acciones: lazy(() => import('@/screens/acciones')),
  conexiones: lazy(() => import('@/screens/conexiones')),
  auditoria: lazy(() => import('@/screens/auditoria')),
  memoria: lazy(() => import('@/screens/memoria')),
};

export function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function App() {
  const { view, project } = useApp();
  const live = useLiveEvents(project?.id ?? null);
  const Screen = SCREENS[view];
  return (
    <Shell live={live}>
      <Suspense fallback={<Loading />}>
        <Screen key={`${view}:${project?.id ?? ''}`} />
      </Suspense>
    </Shell>
  );
}
