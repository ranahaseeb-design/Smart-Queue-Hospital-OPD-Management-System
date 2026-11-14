import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Admin Dashboard runs on port 5174 (see docs/API_CONTRACT.md, "Ports and conventions").
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
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
