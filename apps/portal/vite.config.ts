import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Served behind the reverse proxy at /portal/ in production; dev server stays at root.
  base: command === 'build' ? '/portal/' : '/',
  server: {
    port: 5174,
  },
}));
