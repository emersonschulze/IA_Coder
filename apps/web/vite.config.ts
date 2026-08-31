import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // Áudio vai por HTTP normal (binário), não pelo WebSocket.
      '/voice': { target: process.env.VITE_HTTP_URL ?? 'http://localhost:8787', changeOrigin: true },
    },
  },
});
