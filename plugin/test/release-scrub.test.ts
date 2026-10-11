import { lstat, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { releaseEntries } from '../scripts/release.js';
import * as transcription from '../src/push-to-talk-transcribe.js';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
// The home directory of whoever runs the suite, when it is specific enough to
// search for (`/home/runner`, not `/root`); `/Users/` covers any Mac.
const home = homedir();
// A reserved dummy host exercises host-specific rejection without retaining a device address.
const forbidden = ['/Users/', ...(home.split('/').filter(Boolean).length >= 2 ? [home] : []),
  'release-fixture.test', '1WMHH000X00000', 'harness/kits'];

async function filesUnder(path: string): Promise<string[]> {
  const stat = await lstat(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) throw Error(`Release input is not a regular file or directory: ${path}`);
  const entries = await readdir(path);
  return (await Promise.all(entries.sort().map(entry => filesUnder(resolve(path, entry))))).flat();
}

function findings(file: string, source: string): string[] {
  return source.split(/\r?\n/).flatMap((line, index) => forbidden
    .filter(value => line.toLowerCase().includes(value.toLowerCase()))
    .map(value => `${file}:${index + 1}: forbidden release text ${JSON.stringify(value)}`));
}

it('reports the file, line and forbidden value without printing the surrounding content', () => {
  expect(findings('fixture.txt', 'safe\nhost release-fixture.test\nsee harness/kits')).toEqual([
    'fixture.txt:2: forbidden release text "release-fixture.test"',
    'fixture.txt:3: forbidden release text "harness/kits"',
  ]);
});

it('keeps staged release inputs and shipped source free of machine-specific values', async () => {
  // Use the staging list itself, including dist: stale bundles must fail until
  // rebuilt. Tests are not staged, so no fixture exceptions are necessary.
  const roots = [...new Set<string>([...releaseEntries, 'skills', 'claude-code', 'assets', 'src'])];
  const files = (await Promise.all(roots.map(entry => filesUnder(resolve(pluginRoot, entry))))).flat();
  expect(files.length).toBeGreaterThan(50);
  const offenders = (await Promise.all(files.map(async file =>
    findings(`plugin/${relative(pluginRoot, file)}`, await readFile(file, 'utf8'))))).flat();
  expect(offenders, `Release scrub findings:\n${offenders.join('\n')}`).toEqual([]);
});

it('keeps repository fresh-install requirements in owner release instructions', async () => {
  const release = await readFile(resolve(pluginRoot, '..', 'docs/release.md'), 'utf8');
  expect(release).toContain('Every delivery must name\nan accessible repository URL and the exact tested tag or commit.');
  expect(release).toContain('Always use the pinned package-manager version with a frozen\nlockfile.');
});

it('keeps recipient fresh-install requirements in the shipped instructions', async () => {
  const quickstart = await readFile(resolve(pluginRoot, 'QUICKSTART.md'), 'utf8');
  expect(quickstart).toContain('Meta Web Launch is the ordinary route: press\n**Open** once');
  expect(quickstart).toContain('Voice needs `ffmpeg` plus either that Apple binary or `whisper-cli` with a\nreadable model');
  expect(quickstart).toContain('Speech Recognition consent');
  expect(quickstart).toContain('STEREOFOLD_REPLY_VOICE_PROVIDER=system');
  expect(quickstart).toContain('Keep an already configured spoken-reply provider.');
  expect(quickstart).toContain('Do not change a working OAuth setup');
  expect(quickstart).toContain('Spoken answers\nuse the configured reply provider.');
  expect(quickstart).toContain('Both transcription and\nreply audio need `ffmpeg`.');

  // Every install route the shipped pages name has to be runnable from an
  // installed plugin. These four sentences were each a dead end: a Claude Code
  // step with no command, a variable list behind a repository path, a tool
  // check that needs `pnpm`, and a growth demo that claimed a checkout.
  const readme = await readFile(resolve(pluginRoot, 'README.md'), 'utf8');
  expect(quickstart).toContain('claude plugin marketplace add /absolute/path/to/stereofold-share');
  expect(quickstart).toContain('claude plugin install stereofold@stereofold-local');
  expect(quickstart).toContain('A tier that is not cached is fetched during the\ngrow');
  expect(readme).toContain('claude plugin install stereofold@stereofold-local');
  expect(readme).toContain('node skills/stereofold-setup/scripts/open-check.mjs');
  expect(readme).not.toContain("source repository's `docs/install.md`");

  // Check each table against the source exports so a shared omission fails.
  const installDoc = await readFile(resolve(pluginRoot, '..', 'docs/install.md'), 'utf8');
  const variables = Object.entries(transcription)
    .filter(([name, value]) => name.endsWith('_ENV') && typeof value === 'string' && value.startsWith('STEREOFOLD_'))
    .map(([, value]) => value).sort();
  expect(variables.length).toBeGreaterThan(0);
  for (const [name, page] of [['README.md', readme], ['docs/install.md', installDoc]]) {
    const voice = page.split('## Voice on a Mac\n')[1]?.split('\n## ')[0] ?? '';
    const rows = [...voice.matchAll(/^\| `(STEREOFOLD_[A-Z_]+)` \| (.+) \|$/gmu)];
    expect(rows.map(([, variable]) => variable).sort(), name).toEqual(variables);
  }
});
