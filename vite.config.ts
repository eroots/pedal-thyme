/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/**
 * pdf.js decodes some image formats in scanned PDFs (CCITT fax and JBIG2: black-and-white scans; JPEG 2000)
 * with WebAssembly, or without it (as here) with a JavaScript decoder it imports from a URL at run time,
 * which a single file can't serve. This points that import at the decoders bundled into the app, so those
 * pages render offline. Without it pdf.js silently leaves the pictures out.
 */
const PDF_DECODERS = /import\(\s*\/\*webpackIgnore: true\*\/\s*\/\*@vite-ignore\*\/\s*`\$\{WasmImage\.#\w+\}\$\{this\._noWasmFilename\}`\)/;
const pdfDecoders = (): Plugin => ({
  name: 'pdf-decoders',
  transform(code, id) {
    if (!/pdfjs-dist[\\/]build[\\/]pdf\.worker(\.min)?\.mjs$/.test(id.split('?')[0])) return null;
    if (!PDF_DECODERS.test(code)) throw new Error('pdf-decoders: pdf.js changed; its image decoder import was not found');
    return code.replace(PDF_DECODERS, () => '({ "jbig2_nowasm_fallback.js": () => import("pdfjs-dist/wasm/jbig2_nowasm_fallback.js"),' +
      ' "openjpeg_nowasm_fallback.js": () => import("pdfjs-dist/wasm/openjpeg_nowasm_fallback.js") })[this._noWasmFilename]()');
  },
});

/**
 * Third-party code bundled into the single file keeps its licence with it: the texts fill the footer's
 * "Third-party licences" section (PDF.js: Apache-2.0, with its image decoders from PDFium and OpenJPEG:
 * BSD; the NAM player follows NeuralAmpModelerCore: MIT).
 */
const notices = (): Plugin => ({
  name: 'third-party-notices',
  apply: 'build',
  enforce: 'post',
  transformIndexHtml: html => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').trim();
    const text = `PDF.js (pdfjs-dist), Copyright Mozilla Foundation, licensed under the Apache License 2.0:\n\n${read('./node_modules/pdfjs-dist/LICENSE')}\n\n\n` +
      `PDF.js's JBIG2 and CCITT fax image decoder, from PDFium:\n\n${read('./node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2')}\n\n${read('./node_modules/pdfjs-dist/wasm/LICENSE_JBIG2')}\n\n\n` +
      `PDF.js's JPEG 2000 image decoder, from OpenJPEG:\n\n${read('./node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG')}\n\n${read('./node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG')}\n\n\n` +
      `The NAM capture player (src/audio/nam.ts) follows NeuralAmpModelerCore (https://github.com/sdatkinson/NeuralAmpModelerCore):\n\n${read('./third-party/NeuralAmpModelerCore-LICENSE.txt')}`;
    const marker = '<pre id="licences">The licence texts are added to the built file.</pre>';
    if (!html.includes(marker)) throw new Error('third-party-notices: the licences placeholder is missing from index.html');
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return html.replace(marker, () => `<pre id="licences">${escaped}</pre>`);
  },
});

/**
 * The built app is one file named after the app (the source entry stays index.html), with its SHA-256
 * checksum beside it (`sha256sum` format) so people can check a download is the released file.
 */
const fileName = (): Plugin => ({
  name: 'file-name',
  apply: 'build',
  enforce: 'post',
  closeBundle() {
    const from = new URL('./dist/index.html', import.meta.url), to = new URL('./dist/pedal-thyme.html', import.meta.url);
    if (existsSync(from)) renameSync(from, to);
    const hash = createHash('sha256').update(readFileSync(to)).digest('hex');
    writeFileSync(new URL('./dist/pedal-thyme.html.sha256', import.meta.url), `${hash}  pedal-thyme.html\n`);
  },
});

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The production build inlines everything into dist/pedal-thyme.html, so it opens by double-click (file://).
export default defineConfig({
  plugins: [csp(), pdfDecoders(), viteSingleFile(), notices(), fileName()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5173, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
});
