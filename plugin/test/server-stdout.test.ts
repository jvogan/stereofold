/**
 * stdout is the stdio MCP transport. A console line written there (a timing
 * note, or a bundled library's diagnostic) made the client drop the server
 * with "Unexpected token ... is not valid JSON". The shipped server routes
 * console output to stderr before it connects.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepStdoutForTransport } from '../src/server.js';

const SERVER = fileURLToPath(new URL('../dist/server.mjs', import.meta.url));

describe('stdout stays reserved for the MCP transport', () => {
  it('routes log, info and debug to stderr', () => {
    const errors: unknown[][] = [];
    const target = { log: () => undefined, info: () => undefined, debug: () => undefined,
      error: (...args: unknown[]) => { errors.push(args); } } as unknown as Console;
    keepStdoutForTransport(target);
    target.log('a'); target.info('b'); target.debug('[stereofold:timing] c');
    expect(errors).toEqual([['a'], ['b'], ['[stereofold:timing] c']]);
  });

  it('keeps the shipped server stdout to JSON-RPC while console output goes to stderr', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stereofold-stdout-'));
    const preload = join(dir, 'noise.mjs');
    await writeFile(preload, "setTimeout(() => { console.log('[stereofold:test] log'); "
      + "console.info('[stereofold:test] info'); console.debug('[stereofold:test] debug'); }, 300);\n");
    const child = spawn(process.execPath, ['--import', preload, SERVER], {
      env: { ...process.env, STEREOFOLD_DEMO_CACHE: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdout-test', version: '1' } } })}\n`);
    try {
      const deadline = Date.now() + 15_000;
      while ((!stdout.includes('"id":1') || !stderr.includes('[stereofold:test] debug')) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 50));
      const lines = stdout.split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(JSON.parse(line).jsonrpc).toBe('2.0');
      expect(stderr).toContain('[stereofold:test] log');
      expect(stderr).toContain('[stereofold:test] info');
      expect(stderr).toContain('[stereofold:test] debug');
    } finally {
      child.kill('SIGTERM');
    }
  }, 30_000);
});
