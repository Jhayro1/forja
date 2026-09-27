import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// La página propia de la app de escritorio (asistente de instalación). Mismos
// componentes y tema que el panel; se compila aparte a dist-escritorio para Tauri.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5174, strictPort: true },
  build: {
    outDir: 'dist-escritorio',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: { input: fileURLToPath(new URL('./escritorio.html', import.meta.url)) },
  },
});
