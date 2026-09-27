import { CheckIcon, ChevronsUpDownIcon, FolderPlusIcon, MenuIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
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
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAction, useApiQuery } from '@/hooks/use-api';
import type { LiveStatus } from '@/hooks/use-live-events';
import { type Theme, useTheme } from '@/hooks/use-theme';
import type { Proyectos } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useApp } from './context';
import { NAV } from './navigation';

function Brand() {
  return (
    <div className="flex items-center gap-2 px-2">
      <img src="./forja.svg" alt="" className="size-7" />
      <span className="text-base font-semibold tracking-tight">Forja</span>
    </div>
  );
}

function ProjectSwitcher() {
  const { project, has, go, projectChanged } = useApp();
  const list = useApiQuery<Proyectos>(has('proyectos') ? '/v1/proyectos' : null);
  const { run } = useAction();
  if (!has('proyectos')) return null;
  const choose = async (id: string) => {
    if (await run(`/v1/proyectos/${id}/seleccionar`)) await projectChanged('inicio');
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-auto w-full justify-between px-3 py-2 text-left">
          <span className="min-w-0">
            <span className="block text-xs text-muted-foreground">Proyecto</span>
            <span className="block truncate font-medium">{project ? project.nombre : 'Elige un proyecto'}</span>
          </span>
          <ChevronsUpDownIcon className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="start">
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

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { view, go, has } = useApp();
  const visible = NAV.filter((n) => has(n.module));
  const group = (g: 'principal' | 'avanzado', label?: string) => {
    const items = visible.filter((n) => n.group === g);
    if (!items.length) return null;
    return (
      <div className="space-y-1">
        {label ? <p className="px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground">{label}</p> : null}
        {items.map((n) => (
          <button
            type="button"
            key={n.id}
            aria-current={view === n.id ? 'page' : undefined}
            onClick={() => {
              go(n.id);
              onNavigate?.();
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              view === n.id ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-sidebar-foreground/80',
            )}
          >
            <n.icon className="size-4" />
            {n.title}
          </button>
        ))}
      </div>
    );
  };
  return (
    <nav aria-label="Secciones" className="flex-1 overflow-y-auto">
      {group('principal')}
      {group('avanzado', 'Avanzado')}
    </nav>
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
    <span role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className={cn('size-2 rounded-full', color, status === 'en-vivo' && 'animate-pulse')} />
      {text}
    </span>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <Brand />
      <ProjectSwitcher />
      <Nav {...(onNavigate ? { onNavigate } : {})} />
      <p className="px-3 text-xs text-muted-foreground">Todo corre en tu PC.</p>
    </div>
  );
}

export function Shell({ live, children }: { live: LiveStatus; children: ReactNode }) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="flex min-h-svh">
      <aside className="sticky top-0 hidden h-svh w-64 shrink-0 border-r bg-sidebar md:block">
        <SidebarBody />
      </aside>
      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0">
          <SheetTitle className="sr-only">Menú</SheetTitle>
          <SidebarBody onNavigate={() => setMenu(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Abrir menú" onClick={() => setMenu(true)}>
            <MenuIcon />
          </Button>
          <div className="md:hidden">
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-3">
            <LiveDot status={live} />
            <ThemeMenu />
          </div>
        </header>
        <main id="contenido" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
