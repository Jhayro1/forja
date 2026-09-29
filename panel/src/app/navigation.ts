import {
  BookOpenIcon,
  BotIcon,
  CalendarCheck2Icon,
  FolderGit2Icon,
  GaugeIcon,
  KanbanSquareIcon,
  type LucideIcon,
  MessagesSquareIcon,
  NotebookPenIcon,
  PlugIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import type { ViewId } from './context';

export type NavGroup = 'proyecto' | 'calidad' | 'mas' | 'global';
export type NavItem = { id: ViewId; title: string; icon: LucideIcon; module: string; group: NavGroup; hint: string };

/** Every screen, in menu order. The menu only shows those whose API module the server has. */
export const NAV: NavItem[] = [
  { id: 'inicio', title: 'Resumen', icon: GaugeIcon, module: 'runs', group: 'proyecto', hint: 'Qué pasa ahora y qué te toca hacer' },
  { id: 'sprint', title: 'Sprint actual', icon: MessagesSquareIcon, module: 'trabajos', group: 'proyecto', hint: 'Conversar, especificar, planear y ejecutar' },
  { id: 'tablero', title: 'Tablero', icon: KanbanSquareIcon, module: 'runs', group: 'proyecto', hint: 'Tareas por columna, en vivo' },
  { id: 'agentes', title: 'Agentes', icon: BotIcon, module: 'trabajo', group: 'proyecto', hint: 'Los seis roles y tus cuentas' },
  { id: 'historial', title: 'Historial', icon: CalendarCheck2Icon, module: 'trabajo', group: 'proyecto', hint: 'Épicas, sprints, lista de control y calendario' },
  { id: 'calidad', title: 'Calidad', icon: ShieldAlertIcon, module: 'trabajo', group: 'calidad', hint: 'Validación, observaciones y planes de acción' },
  { id: 'planeacion', title: 'Requisitos y plan', icon: NotebookPenIcon, module: 'planeacion', group: 'calidad', hint: 'Especificación, decisiones y plan por olas' },
  { id: 'conexiones', title: 'Integraciones', icon: PlugIcon, module: 'conexiones', group: 'mas', hint: 'Conexiones y servidores MCP' },
  { id: 'acciones', title: 'Acciones', icon: ShieldCheckIcon, module: 'conexiones', group: 'mas', hint: 'Acciones externas por aprobar' },
  { id: 'memoria', title: 'Documentos y memoria', icon: BookOpenIcon, module: 'memoria', group: 'mas', hint: 'Grafo del proyecto y lecciones' },
  { id: 'auditoria', title: 'Actividad', icon: ScrollTextIcon, module: 'conexiones', group: 'mas', hint: 'Registro de lo que pasó' },
  { id: 'proyectos', title: 'Proyectos', icon: FolderGit2Icon, module: 'proyectos', group: 'global', hint: 'Tus proyectos' },
  { id: 'configuracion', title: 'Ajustes', icon: SettingsIcon, module: 'sistema', group: 'global', hint: 'Cuentas, modelos, correo y tu máquina' },
];

export const GROUP_LABEL: Record<NavGroup, string> = { proyecto: 'Proyecto', calidad: 'Calidad', mas: 'Más', global: 'General' };
