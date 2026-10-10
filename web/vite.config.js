import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the built assets work when served from the monitor backend root.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' }, // dev: hit a locally-tunnelled or local backend
  },
});
