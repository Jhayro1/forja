import { BellIcon, CheckIcon, ChevronsUpDownIcon, FolderPlusIcon, LogOutIcon, MonitorIcon, MoonIcon, SearchIcon, SunIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CommandPalette } from '@/components/command-palette';
import { ScreenBoundary } from '@/components/error-boundary';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { useAction, useApiQuery } from '@/hooks/use-api';
import type { LiveStatus } from '@/hooks/use-live-events';
import { type Theme, useTheme } from '@/hooks/use-theme';
import { api } from '@/lib/api';
import { hora } from '@/lib/format';
import type { EstadoV3, Proyectos } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useApp } from './context';
import { GROUP_LABEL, NAV, type NavGroup } from './navigation';

function Brand() {
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      <img src="./forja.svg" alt="" className="size-7 shrink-0" />
      <span className="truncate text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">Forja</span>
    </div>
  );
}

function ProjectSwitcher() {
  const { project, has, go, projectChanged } = useApp();
  const list = useApiQuery<Proyectos>(has('proyectos') ? '/v1/proyectos' : null);
  const { run } = useAction();
  const { isMobile } = useSidebar();
  if (!has('proyectos')) return null;
  const choose = async (id: string) => {
    if (await run(`/v1/proyectos/${id}/seleccionar`)) await projectChanged('inicio');
  };
  const initial = (project?.nombre ?? '?').slice(0, 1).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent" tooltip={project?.nombre ?? 'Elige un proyecto'}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">{initial}</span>
          <span className="grid min-w-0 flex-1 text-left leading-tight">
            <span className="text-xs text-muted-foreground">Proyecto</span>
            <span className="truncate font-medium">{project ? project.nombre : 'Elige un proyecto'}</span>
          </span>
          <ChevronsUpDownIcon className="ml-auto text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="start" side={isMobile ? 'bottom' : 'right'}>
        <DropdownMenuLabel>Tus proyectos</DropdownMenuLabel>
        {(list.data?.proyectos ?? []).map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => !p.actual && void choose(p.id)}>
            <span className="truncate">{p.nombre}</span>
            {p.actual ? <CheckIcon className="ml-auto" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => go('proyectos')}>
          <FolderPlusIcon /> Agregar o administrar…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Nav({ attention }: { attention: number }) {
  const { view, go, has, project } = useApp();
  const { setOpenMobile } = useSidebar();
  const visible = NAV.filter((n) => has(n.module) && (n.group === 'global' || project));
  const groups: NavGroup[] = ['proyecto', 'calidad', 'mas', 'global'];
  return (
    <>
      {groups.map((g) => {
        const items = visible.filter((n) => n.group === g);
        if (!items.length) return null;
        return (
          <SidebarGroup key={g}>
            <SidebarGroupLabel>{GROUP_LABEL[g]}</SidebarGroupLabel>
            <SidebarMenu>
              {items.map((n) => (
                <SidebarMenuItem key={n.id}>
                  <SidebarMenuButton
                    isActive={view === n.id}
                    tooltip={n.title}
                    onClick={() => {
                      go(n.id);
                      setOpenMobile(false);
                    }}
                  >
                    <n.icon />
                    <span>{n.title}</span>
                  </SidebarMenuButton>
                  {n.id === 'tablero' && attention > 0 ? <SidebarMenuBadge className="bg-warning/20 text-foreground">{attention}</SidebarMenuBadge> : null}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        );
      })}
    </>
  );
}

const THEME_ICON: Record<Theme, typeof SunIcon> = { claro: SunIcon, oscuro: MoonIcon, sistema: MonitorIcon };

function ThemeMenu() {
  const [theme, setTheme] = useTheme();
  const Icon = THEME_ICON[theme];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Tema">
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuRadioItem value="claro">Claro</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="oscuro">Oscuro</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="sistema">Como el sistema</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const LIVE: Record<LiveStatus, [string, string]> = {
  'sin-proyecto': ['', ''],
  conectando: ['conectando…', 'bg-muted-foreground'],
  'en-vivo': ['en vivo', 'bg-success'],
  reconectando: ['reconectando…', 'bg-warning'],
};

function LiveDot({ status }: { status: LiveStatus }) {
  const [text, color] = LIVE[status];
  if (!text) return null;
  return (
    <span role="status" aria-live="polite" className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
      <span className={cn('size-2 rounded-full', color, status === 'en-vivo' && 'animate-pulse')} />
      {text}
    </span>
  );
}

/** What waits for the user, one click away from any screen (v3 §6.5). */
function Alerts({ estado }: { estado: EstadoV3 | undefined }) {
  const { go, openTask, textos } = useApp();
  const pending = estado?.pendientes ?? [];
  const paused = estado?.proveedores_en_pausa ?? [];
  const total = pending.length + paused.length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Avisos (${total})`} className="relative">
          <BellIcon />
          {total ? <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-white">{total}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">Avisos</p>
          <p className="text-xs text-muted-foreground">{total ? 'Esto espera algo de ti.' : 'Nada espera por ti ahora.'}</p>
        </div>
        <ul className="max-h-80 divide-y overflow-y-auto">
          {pending.map((p) => (
            <li key={`${p.kind}:${p.id}`}>
              <button type="button" className="w-full px-4 py-3 text-left text-sm hover:bg-accent" onClick={() => (p.id.startsWith('T-') ? openTask(p.id) : go('sprint'))}>
                <span className="font-medium">
                  {p.id} · {textos.pendiente[p.kind] ?? p.kind}
                </span>
                <span className="line-clamp-2 block text-xs text-muted-foreground">{p.text}</span>
              </button>
            </li>
          ))}
          {paused.map((p) => (
            <li key={p.proveedor} className="px-4 py-3 text-sm">
              <span className="font-medium">⏸ {p.proveedor} en pausa</span>
              <span className="block text-xs text-muted-foreground">
                hasta {hora(p.hasta)} · {p.motivo}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function Shell({ live, children }: { live: LiveStatus; children: ReactNode }) {
  const { view, project, has, server, ligera, openTask } = useApp();
  const [palette, setPalette] = useState(false);
  const est = useApiQuery<{ estado: EstadoV3 }>(project && has('runs') ? '/v1/estado' : null);
  const estado = est.data?.estado;
  const current = NAV.find((n) => n.id === view);
  const attention = estado?.pendientes?.length ?? 0;
  let open = true;
  try {
    open = localStorage.getItem('sidebar_state') !== 'false';
  } catch {
    // Without storage the sidebar starts open.
  }
  return (
    <SidebarProvider defaultOpen={open}>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <Brand />
          <SidebarMenu>
            <SidebarMenuItem>
              <ProjectSwitcher />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <Nav attention={attention} />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            {server ? (
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Cerrar sesión" onClick={() => void api.logout()}>
                  <LogOutIcon />
                  <span>Cerrar sesión</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : (
              <p className="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">Todo corre en tu máquina.</p>
            )}
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur md:rounded-t-xl">
          <SidebarTrigger aria-label="Mostrar u ocultar el menú" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap">
              {project ? (
                <>
                  <BreadcrumbItem className="hidden max-w-40 truncate md:block">{project.nombre}</BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden md:block" />
                </>
              ) : null}
              <BreadcrumbItem>
                <BreadcrumbPage className="truncate">{current?.title ?? ''}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {estado?.modo_demo ? (
            <Badge variant="outline" className="ml-2 border-warning/40 bg-warning/15">
              Modo demo
            </Badge>
          ) : null}
          {ligera ? (
            <Badge
              variant="outline"
              className="ml-2 hidden border-warning/40 bg-warning/15 sm:inline-flex"
              title="Forja Ligera: cada tarea trabaja en su propia rama y carpeta, pero el agente tiene tus mismos permisos en el resto del equipo. Úsalo con proyectos en los que confías."
            >
              Ligera · modo directo
            </Badge>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="sm" className="hidden gap-2 text-muted-foreground sm:flex" onClick={() => setPalette(true)}>
              <SearchIcon /> Buscar…
              <kbd className="pointer-events-none rounded border bg-muted px-1.5 font-mono text-[10px]">Ctrl K</kbd>
            </Button>
            <Button variant="ghost" size="icon" className="sm:hidden" aria-label="Buscar" onClick={() => setPalette(true)}>
              <SearchIcon />
            </Button>
            <LiveDot status={live} />
            {project ? <Alerts estado={estado} /> : null}
            <ThemeMenu />
          </div>
        </header>
        <main id="contenido" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6 lg:p-8">
          <ScreenBoundary resetKey={view}>{children}</ScreenBoundary>
        </main>
      </SidebarInset>
      <CommandPalette open={palette} onOpenChange={setPalette} onOpenTask={(id) => openTask(id)} />
    </SidebarProvider>
  );
}
