import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    proxy: {
      '/socket.io': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
