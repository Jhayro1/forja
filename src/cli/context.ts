import { join } from 'node:path';
import { ConfigError, readConfig, type ForjaConfig } from '../registry/config.js';
import { checkoutDir, forjaHome } from '../registry/home.js';
import { ProjectError, resolveCheckout } from '../registry/projects.js';
import { Registry, type CheckoutRow } from '../registry/registry.js';
import { EventStore } from '../store/event-store.js';

// Exit codes from v2/10.
export const EXIT = { ok: 0, input: 2, precondition: 3, environment: 4, verification: 5, unknown: 6 } as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.input,
  ) {
    super(message);
  }
}

export type GlobalOptions = { proyecto?: string; json?: boolean };

export type ProjectContext = {
  home: string;
  registry: Registry;
  checkout: CheckoutRow;
  config: ForjaConfig;
  dataDir: string;
  store: EventStore;
  close(): void;
};

export async function withRegistry<T>(fn: (registry: Registry, home: string) => T | Promise<T>): Promise<T> {
  const home = forjaHome();
  const registry = Registry.open(home);
  try {
    return await fn(registry, home);
  } finally {
    registry.close();
  }
}

export function openProject(options: GlobalOptions): ProjectContext {
  const home = forjaHome();
  const registry = Registry.open(home);
  try {
    const checkout = resolveCheckout(registry, options.proyecto ? { project: options.proyecto } : {});
    const config = readConfig(checkout.path);
    const dataDir = checkoutDir(home, checkout.checkout_id);
    const store = EventStore.open(join(dataDir, 'estado.db'), checkout.checkout_id);
    registry.touch(checkout.checkout_id);
    return {
      home,
      registry,
      checkout,
      config,
      dataDir,
      store,
      close() {
        store.close();
        registry.close();
      },
    };
  } catch (error) {
    registry.close();
    if (error instanceof ProjectError || error instanceof ConfigError) throw new CliError(error.message, EXIT.precondition);
    throw error;
  }
}

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify({ version: 1, ...(data as object) }, null, 2)}\n`);
}
