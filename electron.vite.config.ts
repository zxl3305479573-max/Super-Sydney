import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: { build: { rollupOptions: { input: { main: resolve('desktop/main.ts') } } }, plugins: [externalizeDepsPlugin()] },
  preload: { build: { rollupOptions: { input: { preload: resolve('desktop/preload.ts') } } }, plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: resolve('desktop/renderer'),
    build: { rollupOptions: { input: resolve('desktop/renderer/index.html') } },
    resolve: { alias: { '@renderer': resolve('desktop/renderer') } },
    plugins: [react()]
  }
});
