// The few Node APIs vite.config.ts uses (reading package.json and a bundled package's licence, naming the
// built file), declared here so the build doesn't need all of @types/node.
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function existsSync(path: string | URL): boolean;
  export function renameSync(from: string | URL, to: string | URL): void;
}
