import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Staff Dashboard runs on port 5173 (docs/API_CONTRACT.md "Ports and conventions").
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  test: { environment: 'node', include: ['src/**/*.test.{js,jsx}'] },
});
