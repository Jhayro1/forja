import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// Los comandos de la app de escritorio (desktop/src-tauri/src/lib.rs).

export type Status = {
  windows: boolean;
  wsl: boolean;
  distro: string | null;
  version_forja: string | null;
  version_app: string;
  ubuntu_sin_forja: boolean;
};

export type Progress = { paso: 'descargar' | 'verificar' | 'importar' | 'comprobar'; detalle: string; porcentaje: number | null };

export interface Desktop {
  status(): Promise<Status>;
  enableWsl(): Promise<void>;
  install(onProgress: (p: Progress) => void): Promise<void>;
  panelLink(): Promise<string>;
  update(): Promise<string>;
  diagnosis(): Promise<string>;
  onError(fn: (message: string) => void): Promise<UnlistenFn>;
}

const tauri: Desktop = {
  status: () => invoke<Status>('estado'),
  enableWsl: () => invoke('activar_wsl'),
  async install(onProgress) {
    const off = await listen<Progress>('instalacion', (e) => onProgress(e.payload));
    try {
      await invoke('instalar');
    } finally {
      off();
    }
  },
  panelLink: () => invoke<string>('abrir_panel'),
  update: () => invoke<string>('actualizar'),
  diagnosis: () => invoke<string>('diagnostico'),
  onError: (fn) => listen<string>('error', (e) => fn(e.payload)),
};

/**
 * Fuera de Tauri (`npm run dev:escritorio` en un navegador) se simula la app, para ver y
 * probar el asistente: `?simular=sin-wsl|sin-forja|listo`.
 */
function simulated(): Desktop {
  const mode = new URLSearchParams(location.search).get('simular') ?? 'sin-forja';
  const state: Status = {
    windows: true,
    wsl: mode !== 'sin-wsl',
    distro: mode === 'listo' ? 'Forja' : null,
    version_forja: mode === 'listo' ? '0.1.0' : null,
    version_app: '0.1.0',
    ubuntu_sin_forja: false,
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    status: async () => ({ ...state }),
    enableWsl: async () => {
      await wait(600);
      state.wsl = true;
    },
    async install(onProgress) {
      for (let p = 0; p <= 100; p += 20) {
        onProgress({ paso: 'descargar', detalle: `${Math.round(3.5 * p)} MB`, porcentaje: p });
        await wait(250);
      }
      for (const paso of ['verificar', 'importar', 'comprobar'] as const) {
        onProgress({ paso, detalle: '…', porcentaje: null });
        await wait(400);
      }
      Object.assign(state, { distro: 'Forja', version_forja: '0.1.0' });
    },
    panelLink: async () => '#simulado',
    update: async () => '0.1.1',
    diagnosis: async () => 'WSL disponible: true\nDistros: Forja',
    onError: async () => () => {},
  };
}

export const desktop: Desktop = '__TAURI_INTERNALS__' in window ? tauri : simulated();
