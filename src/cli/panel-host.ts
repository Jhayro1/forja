import type { ApiModule, ProjectHost, ProjectScope } from '../api/server.js';
import { EngineEventFeed } from './engine-backend.js';
import { type EngineContext, openEngine } from './engine-context.js';

export type ScopeFactory = (ctx: EngineContext) => ApiModule[];
export type EngineOpener = (checkoutId: string | null) => EngineContext;

const defaultOpener: EngineOpener = (checkoutId) => openEngine(checkoutId ? { proyecto: checkoutId } : {});

/**
 * The project the panel is working on. Unlike the CLI (one project per process),
 * the panel stays up while you switch: the next project's engine opens before the
 * previous one closes, and listeners hear about the switch first so nothing keeps
 * reading a closed store.
 */
export class PanelProjects implements ProjectHost {
  private ctx: EngineContext | null = null;
  private scope: ProjectScope | null = null;
  private readonly listeners: ((s: ProjectScope) => void)[] = [];
  /** Why the project can't change right now (an in-process planner turn is using its store). */
  busy: string | null = null;

  constructor(
    private readonly modules: ScopeFactory,
    private readonly open: EngineOpener = defaultOpener,
  ) {}

  current(): ProjectScope | null {
    return this.scope;
  }

  onLeave(listener: (s: ProjectScope) => void): void {
    this.listeners.push(listener);
  }

  /** The checkout currently open, if any. */
  context(): EngineContext | null {
    return this.ctx;
  }

  /** Opens what the CLI would pick from here (cwd or the active project); stays empty if there is none. */
  openDefault(): void {
    try {
      this.swap(this.open(null));
    } catch {
      this.swap(null);
    }
  }

  /** Switches to a registered checkout and makes it the active project for the CLI too. */
  select(checkoutId: string): EngineContext {
    if (this.busy) throw new Error(`espera un momento: ${this.busy}`);
    const next = this.open(checkoutId);
    next.registry.setActive(checkoutId);
    this.swap(next);
    return next;
  }

  close(): void {
    this.swap(null);
  }

  private swap(next: EngineContext | null): void {
    const prev = this.ctx;
    const prevScope = this.scope;
    this.ctx = next;
    this.scope = next ? { modules: this.modules(next), feed: new EngineEventFeed(next) } : null;
    if (prevScope) for (const l of this.listeners) l(prevScope);
    prev?.close();
  }
}
