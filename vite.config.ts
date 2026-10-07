/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Content Security Policy for the built app: it runs entirely from its own file, so it may load nothing
 * from anywhere else and connect nowhere. Scripts and styles are inline (single-file build); workers
 * come from blob: URLs; pictures and sounds are data:/blob: URLs made from files the user picks.
 * Build only: the dev server needs its own connections (hot reload).
 */
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "worker-src blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data: blob:',
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const csp = (): Plugin => ({
  name: 'csp',
  apply: 'build',
  transformIndexHtml: html => html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${CSP}">`),
});

/** Third-party code bundled into the single file keeps its licence with it (PDF.js: Apache-2.0). */
const notices = (): Plugin => ({
  name: 'third-party-notices',
  apply: 'build',
  enforce: 'post',
  transformIndexHtml: html => {
    const license = readFileSync(new URL('./node_modules/pdfjs-dist/LICENSE', import.meta.url), 'utf8').replace(/-->/g, '--&gt;');
    return html.replace('</html>', `<!--\nThird-party software included in this file:\n\nPDF.js (pdfjs-dist), Copyright Mozilla Foundation, licensed under the Apache License 2.0:\n\n${license}\n-->\n</html>`);
  },
});

// The production build inlines everything into dist/index.html, so it opens by double-click (file://).
export default defineConfig({
  plugins: [csp(), viteSingleFile(), notices()],
  server: { port: 5173, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
});
