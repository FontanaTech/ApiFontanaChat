import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: '/admin/',
  plugins: [react()],
  build: { outDir: path.resolve(here, 'dist'), emptyOutDir: true },
  server: {
    // Puertos fijos: API 10000 · panel 5174 · sitio de AAgora 5173. strictPort evita que Vite salte a otro puerto.
    port: 5174,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:10000', '/health': 'http://127.0.0.1:10000' },
  },
});
