import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// El panel se sirve desde `forja ui` (mismo origen que la API): rutas relativas, sin
// scripts inline (la CSP sólo permite 'self') y todo en un par de archivos con hash.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    // forja servidor reads the manifest to serve, without a session, only the login's files.
    manifest: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        login: fileURLToPath(new URL('./login.html', import.meta.url)),
      },
    },
  },
  server: {
    // `npm run dev -w panel` con `forja ui --sin-navegador --puerto 4580` corriendo al lado.
    proxy: { '/v1': { target: 'http://127.0.0.1:4580', changeOrigin: false } },
  },
});
