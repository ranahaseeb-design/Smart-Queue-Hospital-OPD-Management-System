import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
const staffSrc = path.resolve(here, '../staff-dashboard/src');

// Smart OPD Dashboard — ONE web app for every role on port 5174 (docs/API_CONTRACT.md, "Ports").
// The four-card login is shared; administrators get the admin screens (this folder), doctors and
// staff get the Staff Dashboard screens, imported as a module from ../staff-dashboard/src via the
// `@staff` alias. `dedupe` makes that code use this app's single copy of React, the router and
// socket.io-client (two Reacts would break hooks).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@staff': staffSrc },
    dedupe: ['react', 'react-dom', 'react-router-dom', 'socket.io-client'],
  },
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: [here, staffSrc] },
  },
  preview: { port: 5174, strictPort: true },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
  // Utility tests run in node; component tests opt into jsdom with a `@vitest-environment jsdom` docblock.
  test: { environment: 'node', include: ['src/**/*.test.{js,jsx}'] },
});
