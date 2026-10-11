import type { Plugin } from 'esbuild';
export function patchMolstarStateAbortSource(source: string, version: string): string;
export function stateAbortLoggingPatch(onPatched?: (input: {
  path: string; source: string; contents: string; version: string;
}) => void): Plugin;
