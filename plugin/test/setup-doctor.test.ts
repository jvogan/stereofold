import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { describeBuildContent, formatDoctor, inspectBuild, inspectControlFile, inspectPort, isPrivateIpv4, listPrivateLanAddresses, parseDoctorArgs, runDoctor } from '../scripts/setup-doctor.js';
import { BUILD_INPUT_STAMP_FILE, BUILD_INPUT_STAMP_VERSION, hashBuildInputs } from '../src/build-inputs.js';

// Synthetic RFC1918 fixture: private-LAN validation cannot use TEST-NET ranges.
const SYNTHETIC_LAN_IP = '192.168.3.4';

describe('standalone setup doctor', () => {
  it('accepts only assigned RFC1918 IPv4 addresses', () => {
    expect(['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.3.4'].every(isPrivateIpv4)).toBe(true);
    expect(['127.0.0.1', '172.15.0.1', '172.32.0.1', '8.8.8.8', '192.169.0.1', '10.0.0.999'].some(isPrivateIpv4)).toBe(false);
    const interfaces = () => ({ en0: [{ address: SYNTHETIC_LAN_IP, family: 'IPv4', internal: false }], lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], vpn: [{ address: '172.20.0.2', family: 4, internal: false }] });
    expect(listPrivateLanAddresses(interfaces)).toEqual([{ interface: 'en0', address: SYNTHETIC_LAN_IP }, { interface: 'vpn', address: '172.20.0.2' }]);
  });

  it('reports missing and stale packaged runtime files without rebuilding', async () => {
    const actual = await mkdtemp(join(tmpdir(), 'stereofold-doctor-build-'));
    try {
      expect((await inspectBuild(actual)).state).toBe('missing');
      await Promise.all([mkdir(join(actual, 'dist')), mkdir(join(actual, 'src'))]);
      for (const file of ['server.mjs', 'viewer.html', 'inspector.html', 'inspector.css']) await writeFile(join(actual, 'dist', file), 'built');
      expect(await inspectBuild(actual), 'missing inspector host blocks doctor').toMatchObject({
        state: 'missing', files: ['inspector-host.js'],
      });
      await writeFile(join(actual, 'dist/inspector-host.js'), 'built');
      await writeFile(join(actual, 'src', 'entry.ts'), 'source');
      const past = new Date(Date.now() - 10_000); const future = new Date(Date.now() + 10_000);
      for (const file of ['server.mjs', 'viewer.html', 'inspector.html', 'inspector.css', 'inspector-host.js']) await utimes(join(actual, 'dist', file), past, past);
      await utimes(join(actual, 'src', 'entry.ts'), future, future);
      expect((await inspectBuild(actual)).state).toBe('stale');
    } finally { await rm(actual, { recursive: true, force: true }); }
  });

  it('believes the recorded source hash over the modification times a second checkout rewrites', async () => {
    // This is the trap the content check exists for: a worktree writes every
    // source file with today's mtime and none of the dist files, so a runtime
    // that is exactly what those sources build reported itself stale and an
    // operator either rebuilt for nothing or learned to ignore the line.
    const root = await mkdtemp(join(tmpdir(), 'stereofold-doctor-hash-'));
    try {
      await Promise.all([mkdir(join(root, 'dist')), mkdir(join(root, 'src'))]);
      for (const file of ['server.mjs', 'viewer.html', 'inspector.html', 'inspector.css', 'inspector-host.js']) await writeFile(join(root, 'dist', file), 'built');
      await writeFile(join(root, 'src', 'entry.ts'), 'source');
      const past = new Date(Date.now() - 10_000); const future = new Date(Date.now() + 10_000);
      for (const file of ['server.mjs', 'viewer.html', 'inspector.html', 'inspector.css', 'inspector-host.js']) await utimes(join(root, 'dist', file), past, past);
      await utimes(join(root, 'src', 'entry.ts'), future, future);

      const unstamped = await inspectBuild(root);
      expect(unstamped, 'no stamp leaves the modification-time heuristic in charge')
        .toMatchObject({ state: 'stale', heuristic: true, mtime: 'stale', content: { state: 'unknown', reason: 'no stamp' } });
      expect(describeBuildContent(unstamped.content)).toBe('unknown (no stamp)');

      const inputs = await hashBuildInputs(root);
      await writeFile(join(root, 'dist', BUILD_INPUT_STAMP_FILE),
        JSON.stringify({ version: BUILD_INPUT_STAMP_VERSION, hash: inputs!.hash, files: inputs!.files }));
      const stamped = await inspectBuild(root);
      expect(stamped, 'the same bytes the build read is fresh, whatever the clock says')
        .toMatchObject({ state: 'fresh', heuristic: false, mtime: 'stale', content: { state: 'fresh', hash: inputs!.hash } });
      expect(describeBuildContent(stamped.content)).toBe(`fresh (${inputs!.hash.slice(0, 12)})`);
      expect(formatDoctor(await runDoctor({ root, nodeVersion: '22.0.0',
        interfaces: () => ({ en0: [{ address: SYNTHETIC_LAN_IP, family: 'IPv4', internal: false }] }),
        command: async command => command === 'openssl' ? { stdout: 'OpenSSL test\n' } : { stdout: '' } })))
        .toContain('modification times say older than source');

      // Editing a source after the build is the case the check must still catch.
      await writeFile(join(root, 'src', 'entry.ts'), 'source edited');
      const edited = await inspectBuild(root);
      expect(edited).toMatchObject({ state: 'stale', heuristic: false, content: { state: 'stale', recorded: inputs!.hash } });
      expect(edited.content.state === 'stale' && edited.content.hash).not.toBe(inputs!.hash);

      // A stamp written by a rule this checkout does not know is unknown, not fresh.
      await writeFile(join(root, 'dist', BUILD_INPUT_STAMP_FILE), JSON.stringify({ version: 99, hash: inputs!.hash }));
      expect((await inspectBuild(root)).content).toMatchObject({ state: 'unknown', reason: 'no stamp' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('commits the stamp with the bundles, and a clean build can reproduce it', async () => {
    // A clone writes plugin/src after plugin/dist, so without the stamp in Git
    // every fresh clone read stale and `run quest` refused to start. CI checks
    // that a build leaves plugin/dist unchanged, so the stamp carries no clock.
    const ignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
    expect(ignore.split('\n')).toContain(`!dist/${BUILD_INPUT_STAMP_FILE}`);
    const stamp = JSON.parse(await readFile(new URL(`../dist/${BUILD_INPUT_STAMP_FILE}`, import.meta.url), 'utf8'));
    expect(Object.keys(stamp)).toEqual(['version', 'hash', 'files']);
    expect(stamp.version).toBe(BUILD_INPUT_STAMP_VERSION);
    const release = await readFile(new URL('../../docs/release.md', import.meta.url), 'utf8');
    const gitSection = release.split('## Git eligibility and release layout')[1]?.split('\n## ')[0] ?? '';
    expect(gitSection).toContain(`\`dist/${BUILD_INPUT_STAMP_FILE}\``);
  });

  it('hashes the same content to the same digest from any path, and notices one changed byte', async () => {
    const [leftRepo, rightRepo] = await Promise.all([mkdtemp(join(tmpdir(), 'stereofold-inputs-a-')), mkdtemp(join(tmpdir(), 'stereofold-inputs-b-'))]);
    // Paths are hashed relative to the repository root, so both checkouts put
    // the plugin where a real one has it. That is the point of the digest: it
    // is about content and layout, not about where a checkout happens to live.
    const [left, right] = [join(leftRepo, 'plugin'), join(rightRepo, 'plugin')];
    try {
      for (const root of [left, right]) {
        await mkdir(join(root, 'src', 'nested'), { recursive: true });
        await writeFile(join(root, 'src', 'a.ts'), 'alpha');
        await writeFile(join(root, 'src', 'nested', 'b.ts'), 'beta');
      }
      const first = await hashBuildInputs(left);
      expect(first).toMatchObject({ files: 2 });
      expect((await hashBuildInputs(right))!.hash).toBe(first!.hash);
      await writeFile(join(right, 'src', 'nested', 'b.ts'), 'beta.');
      expect((await hashBuildInputs(right))!.hash).not.toBe(first!.hash);
      // A release artifact ships dist without the sources that made it, and
      // "stale" would be a lie about a tree that was never there.
      expect(await hashBuildInputs(join(left, 'absent'))).toBeNull();
    } finally { await Promise.all([rm(leftRepo, { recursive: true, force: true }), rm(rightRepo, { recursive: true, force: true })]); }
  });

  it('keeps a runtime fresh when Python caches are created, edited or cleaned up', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'stereofold-cache-input-'));
    const root = join(repo, 'plugin');
    try {
      await mkdir(join(root, 'scripts', '__pycache__'), { recursive: true });
      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'scripts', 'prepare.py'), 'print("source")');
      for (const file of ['server.mjs', 'viewer.html', 'inspector.html', 'inspector.css', 'inspector-host.js'])
        await writeFile(join(root, 'dist', file), 'built');
      const before = await hashBuildInputs(root);
      const past = new Date(Date.now() - 20_000), future = new Date(Date.now() + 20_000);
      await utimes(join(root, 'scripts', 'prepare.py'), past, past);
      await writeFile(join(root, 'dist', BUILD_INPUT_STAMP_FILE),
        JSON.stringify({ version: BUILD_INPUT_STAMP_VERSION, ...before }));
      for (const suffix of ['pyc', 'pyo']) {
        await writeFile(join(root, 'scripts', `prepare.${suffix}`), 'cache');
        await utimes(join(root, 'scripts', `prepare.${suffix}`), future, future);
      }
      const cache = join(root, 'scripts', '__pycache__', 'prepare.cpython-313.pyc');
      await writeFile(cache, 'cache v1');
      await utimes(cache, future, future);
      expect(await hashBuildInputs(root)).toEqual(before);
      expect(await inspectBuild(root)).toMatchObject({ state: 'fresh', mtime: 'fresh', content: { state: 'fresh' } });
      await writeFile(cache, 'cache v2');
      expect(await hashBuildInputs(root)).toEqual(before);
      await rm(join(root, 'scripts', '__pycache__'), { recursive: true });
      await rm(join(root, 'scripts', 'prepare.pyc'));
      await rm(join(root, 'scripts', 'prepare.pyo'));
      expect(await hashBuildInputs(root)).toEqual(before);
      await writeFile(join(root, 'scripts', 'prepare.py'), 'print("changed source")');
      expect((await hashBuildInputs(root))!.hash).not.toBe(before!.hash);
      expect(await inspectBuild(root)).toMatchObject({ state: 'stale', content: { state: 'stale' } });
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it.each(['scripts/serve-inspection.ts', 'scripts/local-host-security.ts',
    'scripts/quest-share.ts', 'scripts/scene-socket-relay.ts'])('notices changes to bundled runtime input %s', async name => {
    const repo = await mkdtemp(join(tmpdir(), 'stereofold-runtime-input-'));
    const root = join(repo, 'plugin');
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'scripts'), { recursive: true });
      await writeFile(join(root, 'src/server.ts'), 'unchanged server');
      await writeFile(join(root, name), 'original child host input');
      const before = await hashBuildInputs(root);
      await writeFile(join(root, name), 'changed child host input');
      expect((await hashBuildInputs(root))!.hash).not.toBe(before!.hash);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it.each(['interruptible-command.mjs', 'named-publication.mjs', 'style.css'])(
    'notices a changed workspace dependency %s', async name => {
      const repo = await mkdtemp(join(tmpdir(), 'stereofold-workspace-input-'));
      const root = join(repo, 'plugin'), workspace = join(repo, 'lab/inspection');
      try {
        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, 'workspace.mjs'), 'unchanged workspace');
        await writeFile(join(workspace, name), 'original dependency');
        const before = await hashBuildInputs(root);
        await writeFile(join(workspace, name), 'changed dependency');
        expect((await hashBuildInputs(root))!.hash).not.toBe(before!.hash);
      } finally { await rm(repo, { recursive: true, force: true }); }
    });

  it('checks an explicit control file without returning its capability', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-doctor-control-'));
    const path = join(directory, 'control.json'); const token = 'a'.repeat(64);
    try {
      await writeFile(path, JSON.stringify({ origin: 'http://127.0.0.1:53191', token, sessionId: 'session-1' }), { mode: 0o600 });
      await chmod(path, 0o600);
      expect(await inspectControlFile(path)).toEqual({ state: 'secure' });
      const report = await runDoctor({ root: join(directory, 'no-runtime'), controlFile: path, nodeVersion: '22.0.0',
        interfaces: () => ({ en0: [{ address: SYNTHETIC_LAN_IP, family: 'IPv4', internal: false }] }),
        command: async command => command === 'openssl' ? { stdout: 'OpenSSL test\n' } : { stdout: '' } });
      expect(JSON.stringify(report)).not.toContain(token);
      await writeFile(path, JSON.stringify({ origin: 'http://127.0.0.1:53191/unsafe', token, sessionId: 'session-1' }), { mode: 0o600 });
      await chmod(path, 0o600); expect(await inspectControlFile(path)).toEqual({ state: 'invalid' });
      await chmod(path, 0o644); expect(await inspectControlFile(path)).toEqual({ state: 'insecure' });
      await rm(path); await symlink(join(directory, 'missing'), path); expect(await inspectControlFile(path)).toEqual({ state: 'invalid' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('parses safe explicit options and reports port states without binding', async () => {
    expect(parseDoctorArgs(['--json', '--port', '9443', '--control-file', '/tmp/control.json'])).toEqual({ json: true, port: 9443, controlFile: '/tmp/control.json' });
    expect(() => parseDoctorArgs(['--port', '0'])).toThrow('1 through 65535');
    expect(() => parseDoctorArgs(['--control-file', 'relative.json'])).toThrow('absolute path');
    expect(await inspectPort(8443, async () => ({ stdout: 'n*:8443\n' }))).toBe('listening');
    await expect(inspectPort(8443, async () => { const error = Object.assign(Error('none'), { code: 1 }); throw error; })).resolves.toBe('available');
    await expect(inspectPort(8443, async () => { const error = Object.assign(Error('permission'), { code: 1, stderr: 'lsof: permission denied' }); throw error; })).resolves.toBe('unknown');
  });

  it('asks a timed-out lsof once more and fails at once when lsof is missing', async () => {
    const sequence = (...answers: Array<Error | string>) => {
      const calls: string[] = [];
      const command = async (file: string) => {
        calls.push(file);
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return { stdout: answer ?? '' };
      };
      return { calls, command };
    };
    const killed = () => Object.assign(Error('Command failed: lsof'), { killed: true, signal: 'SIGTERM', code: null });
    const loaded = sequence(killed(), 'n*:8443\n');
    expect(await inspectPort(8443, loaded.command)).toBe('listening');
    expect(loaded.calls).toEqual(['lsof', 'lsof']);
    const stuck = sequence(killed(), killed());
    expect(await inspectPort(8443, stuck.command)).toBe('unknown');
    expect(stuck.calls).toHaveLength(2);
    const missing = sequence(Object.assign(Error('spawn lsof ENOENT'), { code: 'ENOENT' }));
    expect(await inspectPort(8443, missing.command)).toBe('unknown');
    expect(missing.calls).toHaveLength(1);
    // The real execFile timeout sets `killed`, which is what the retry reads.
    const execFileAsync = promisify(execFile);
    let attempts = 0;
    expect(await inspectPort(8443, async () => { attempts += 1; return execFileAsync('sleep', ['5'], { encoding: 'utf8', timeout: 50 }); })).toBe('unknown');
    expect(attempts).toBe(2);
    const text = formatDoctor({ ready: true, node: { check: 'ok', version: '22.0.0', required: '22+' }, openssl: { check: 'ok', version: 'OpenSSL test' },
      prerequisitesReady: true, build: { state: 'fresh', files: [], heuristic: false, stamps: { viewer: 'a'.repeat(64), inspector: 'b'.repeat(64) },
        content: { state: 'fresh', hash: 'c'.repeat(64) }, mtime: 'fresh' }, lan: { check: 'ok', addresses: [{ interface: 'en0', address: SYNTHETIC_LAN_IP }] }, port: { state: 'available', port: 8443 }, controlFile: { state: 'not-provided' } });
    expect(text).toContain('Stereofold setup doctor: READY');
    // The build line is what two hosts compare; an unstamped bundle says so
    // rather than printing nothing.
    expect(text).toContain(`OK build · viewer ${'a'.repeat(64)} · inspector ${'b'.repeat(64)}`);
    const unstamped = formatDoctor({ ready: true, node: { check: 'ok', version: '22.0.0', required: '22+' }, openssl: { check: 'ok', version: 'OpenSSL test' },
      prerequisitesReady: true, build: { state: 'fresh', files: [], heuristic: false, stamps: { viewer: null, inspector: null },
        content: { state: 'fresh', hash: 'c'.repeat(64) }, mtime: 'fresh' }, lan: { check: 'ok', addresses: [{ interface: 'en0', address: SYNTHETIC_LAN_IP }] }, port: { state: 'available', port: 8443 }, controlFile: { state: 'not-provided' } });
    expect(unstamped).toContain('!! build · viewer unstamped · inspector unstamped');
  });
});
