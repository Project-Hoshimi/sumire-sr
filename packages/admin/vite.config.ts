import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Admin console build. The UI is served by fastify-api under
 * `/sumire/admin/`, so every emitted asset URL is based there.
 *
 * Dev proxy: only `/sumire/admin/<api-prefix>/...` is forwarded to the local
 * HTTPS API listener; the index, Vite internals and build assets stay with the
 * dev server.
 */
const API_PREFIXES = ['login', 'logout', 'session', 'bootstrap', 'users', 'events', 'rosters', 'lookup'];

export default defineConfig({
  base: '/sumire/admin/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  server: {
    proxy: {
      '/sumire/admin/': {
        target: 'https://127.0.0.1:8443',
        secure: false,
        changeOrigin: false,
        bypass(req) {
          const path = (req.url ?? '').split('?')[0] ?? '';
          if (!path.startsWith('/sumire/admin/')) return path;
          const segment = path.slice('/sumire/admin/'.length).split('/')[0] ?? '';
          if (segment === '' || segment === 'index.html' || segment === 'assets') return path;
          if (!API_PREFIXES.includes(segment)) return path;
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The badge test reads the real stylesheet with `?inline`; without this
    // Vite returns an empty string for CSS imports under Vitest.
    css: true,
  },
});
