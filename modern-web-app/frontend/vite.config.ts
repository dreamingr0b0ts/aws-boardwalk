import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// For local dev against the deployed backend:
//   VITE_API_PROXY=https://<cloudfront-domain> npm run dev
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: process.env.VITE_API_PROXY
      ? {
          '/api': { target: process.env.VITE_API_PROXY, changeOrigin: true },
          '/config.json': { target: process.env.VITE_API_PROXY, changeOrigin: true },
        }
      : undefined,
  },
});
