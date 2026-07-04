import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  test: {
    dir: fileURLToPath(new URL('./tests', import.meta.url)),
    environment: 'node',
  },
  server: {
    proxy: {
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
