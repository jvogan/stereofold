import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OAUTH_AUTH_HELPER_CONFIG_KEY } from '../src/local-helper-config.js';

const script = fileURLToPath(new URL('../assets/oauth-transcribe.py', import.meta.url));
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'stereofold-auth-test-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function lookup(env: NodeJS.ProcessEnv = {}, secret = false) {
  const result = spawnSync('python3', ['-B', '-c', `
import json, os, runpy, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
os.environ.clear()
os.environ.update(json.loads(sys.argv[2]))
Path.home = classmethod(lambda cls: Path(sys.argv[3]))
try:
    value = module['oauth_secret' if sys.argv[4] == 'secret' else 'auth_helper_path']()
    print(json.dumps({'value': str(value)}))
except Exception as error:
    print(json.dumps({'error': str(error)}))
`, script, JSON.stringify(env), directory, secret ? 'secret' : 'path'], { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { value?: string; error?: string };
}

function helper(name: string) {
  const path = join(directory, name);
  writeFileSync(path, 'def create_realtime_oauth_client_secret():\n    return "fake-oauth-result"\n');
  return path;
}

function config(value: unknown) {
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('the OAuth auth module lookup', () => {
  it('uses environment, config, then a readable module on absolute PATH entries', () => {
    const envHelper = helper('env.py'), configured = helper('configured.py');
    const pathHelper = helper('stereofold-oauth-auth.py');
    const env = { PATH: directory, STEREOFOLD_CONFIG: config({ [OAUTH_AUTH_HELPER_CONFIG_KEY]: configured }) };
    expect(lookup({ ...env, STEREOFOLD_OAUTH_AUTH_HELPER: envHelper }).value).toBe(envHelper);
    expect(lookup(env).value).toBe(configured);
    expect(lookup({ PATH: directory }).value).toBe(pathHelper);
    expect(lookup({ STEREOFOLD_OAUTH_AUTH_HELPER: envHelper }, true).value).toBe('fake-oauth-result');
  });

  it('fails closed on relative or unavailable explicit helpers, despite a PATH candidate', () => {
    helper('stereofold-oauth-auth.py');
    for (const named of ['relative.py', join(directory, 'missing.py')]) {
      for (const env of [
        { STEREOFOLD_OAUTH_AUTH_HELPER: named },
        { STEREOFOLD_CONFIG: config({ oauthAuthHelper: named }) },
      ]) {
        const result = lookup({ PATH: directory, ...env });
        expect(result.value).toBeUndefined();
        expect(result.error).toContain('Set STEREOFOLD_OAUTH_AUTH_HELPER to its absolute path');
        expect(result.error).toContain('"oauthAuthHelper"');
      }
    }
  });

  it('reports setup advice for missing helpers, malformed config and relative PATH entries', () => {
    const malformed = join(directory, 'malformed.json');
    writeFileSync(malformed, '{bad json');
    for (const env of [{}, { STEREOFOLD_CONFIG: malformed }, { PATH: 'relative:.' }]) {
      const result = lookup(env);
      expect(result.error).toContain('Voice recognition is off');
      expect(result.error).toContain('put stereofold-oauth-auth.py on PATH');
      expect(result.error).toContain('"oauthAuthHelper"');
    }
    expect(lookup({ STEREOFOLD_CONFIG: 'relative.json' }).error).toContain('STEREOFOLD_CONFIG must be an absolute path');
  });
});
