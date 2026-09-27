import { BrainIcon, FolderGit2Icon, HomeIcon, ListChecksIcon, type LucideIcon, NotebookPenIcon, PlugIcon, ScrollTextIcon, SettingsIcon, ShieldCheckIcon } from 'lucide-react';
import type { ViewId } from './context';

export type NavItem = { id: ViewId; title: string; icon: LucideIcon; module: string; group: 'principal' | 'avanzado' };

/** Every screen, in menu order. The menu only shows those whose API module the server has. */
export const NAV: NavItem[] = [
  { id: 'inicio', title: 'Inicio', icon: HomeIcon, module: 'trabajos', group: 'principal' },
  { id: 'proyectos', title: 'Proyectos', icon: FolderGit2Icon, module: 'proyectos', group: 'principal' },
  { id: 'configuracion', title: 'Configuración', icon: SettingsIcon, module: 'sistema', group: 'principal' },
  { id: 'resumen', title: 'Tareas', icon: ListChecksIcon, module: 'runs', group: 'avanzado' },
  { id: 'planeacion', title: 'Planeación', icon: NotebookPenIcon, module: 'planeacion', group: 'avanzado' },
  { id: 'acciones', title: 'Acciones', icon: ShieldCheckIcon, module: 'conexiones', group: 'avanzado' },
  { id: 'conexiones', title: 'Conexiones', icon: PlugIcon, module: 'conexiones', group: 'avanzado' },
  { id: 'auditoria', title: 'Auditoría', icon: ScrollTextIcon, module: 'conexiones', group: 'avanzado' },
  { id: 'memoria', title: 'Memoria', icon: BrainIcon, module: 'memoria', group: 'avanzado' },
];
