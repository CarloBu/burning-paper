import { defineConfig } from 'astro/config';

export default defineConfig({
  server: { host: '127.0.0.1' },
  vite: {
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false, ws: true },
      },
    },
  },
});
