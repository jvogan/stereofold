import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { sceneCallTimeoutMs } from '../../src/scene-service.js';

/** Execute the host's actual MCP boundary without starting a host or listener. */
export function standaloneHostCall(client: Client): (name: string, args: Record<string, unknown>) => Promise<any> {
  const source = readFileSync(new URL('../../scripts/serve-inspection.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const raw=async('), end = source.indexOf('\nconst page=', start);
  if (start < 0 || end < start) throw Error('Standalone host call boundary is missing.');
  const compiled = transpileModule(source.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${compiled}\nraw;`, { client, clientConnected: true,
    sceneCallTimeoutMs, childUnavailable: () => Error('MCP child disconnected') });
}
