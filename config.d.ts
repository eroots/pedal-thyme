// The few Node APIs vite.config.ts uses (reading package.json and a bundled package's licence, naming the
// built file and writing its checksum), declared here so the build doesn't need all of @types/node.
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function readFileSync(path: string | URL): Uint8Array;
  export function writeFileSync(path: string | URL, data: string): void;
  export function existsSync(path: string | URL): boolean;
  export function renameSync(from: string | URL, to: string | URL): void;
}
declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): { update(data: Uint8Array): { digest(encoding: 'hex'): string } };
}
