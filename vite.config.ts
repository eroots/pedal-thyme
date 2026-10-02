/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The production build inlines everything into dist/index.html, so it opens by double-click (file://).
export default defineConfig({
  plugins: [viteSingleFile()],
  server: { port: 5173, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
});
