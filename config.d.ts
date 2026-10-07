// The one Node API vite.config.ts uses (reading a bundled package's licence at build time), declared here
// so the build doesn't need all of @types/node.
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
}
