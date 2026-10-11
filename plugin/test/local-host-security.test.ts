import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasLocalControlToken, writeLocalControlState } from '../scripts/local-host-security.js';

describe('standalone control capability', () => {
  it('rejects malformed and multibyte credentials without throwing', () => {
    const token = 'a'.repeat(64);
    for (const header of [undefined, token, `Bearer ${'é'.repeat(64)}`, `Bearer ${'b'.repeat(64)}`, `Bearer ${token}\n`])
      expect(hasLocalControlToken(header, token)).toBe(false);
    expect(hasLocalControlToken(`Bearer ${token}`, token)).toBe(true);
  });
  it('replaces loose file permissions and refuses symlink targets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-control-'));
    try {
      const path = join(directory, 'state.json');
      await writeFile(path, 'old', { mode: 0o644 });
      await writeLocalControlState(path, { token: 'test-only' });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ token: 'test-only' });
      const link = join(directory, 'link.json'); await symlink(path, link);
      await expect(writeLocalControlState(link, {})).rejects.toThrow('symbolic link');
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ token: 'test-only' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
