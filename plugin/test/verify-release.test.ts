import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { demoLessonPaths, verifyBuiltCopies, verifyLayout } from '../scripts/verify-release.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** A hermetic index: one plain lesson and one staged lesson in a subdirectory. */
const stubIndex = {
  version: 1,
  demos: [
    { name: 'stub', lesson: 'stub.json', stages: [{ lesson: 'nested/tier.json' }] },
  ],
};

/** Files verifyLayout parses rather than merely lists: copy the real ones. */
const parsedFromCheckout = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'THIRD_PARTY_NOTICES.md',
  '.claude-plugin/plugin.json',
  '.claude-plugin/icon.png',
  'claude-code/skills/stereofold-quest/SKILL.md',
];

/** Everything else verifyLayout only lists: content is irrelevant. */
const stubbed = [
  'LICENSE',
  'README.md',
  'QUICKSTART.md',
  'INSPECTOR.md',
  'assets/icon-256.png',
  'assets/logo-1024.png',
  'assets/oauth-transcribe.py',
  'codex/INSTALL.md',
  'dist/server.mjs',
  'dist/headset-host.mjs',
  'dist/serve-inspection.mjs',
  'dist/scene-socket-relay.mjs',
  'dist/viewer.html',
  'dist/inspector.html',
  'dist/inspector.css',
  'dist/inspector-script-1.js',
  'dist/inspector-script-2.js',
  'dist/inspector-host.js',
  'dist/molstar/molstar.js',
  'dist/molstar/molstar.css',
  'dist/molstar/LICENSE',
  'native/applespeech/transcribe.swift',
  'native/applespeech/Info.plist',
  'native/applespeech/build.sh',
  'skills/stereo-structure/SKILL.md',
  'skills/molecular-presentation/SKILL.md',
  'skills/molecular-presentation/scripts/lesson.mjs',
  'skills/molecular-presentation/references/live-authoring.md',
  'skills/stereofold-setup/SKILL.md',
  'skills/stereofold-setup/scripts/setup-check.mjs',
  'demos/stub.json',
  'demos/nested/tier.json',
];

async function createArtifact(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'stereofold-verify-release-'));
  const artifact = resolve(parent, 'stereofold');
  for (const relative of parsedFromCheckout) {
    const target = resolve(artifact, relative);
    await mkdir(resolve(target, '..'), { recursive: true });
    await cp(resolve(pluginRoot, relative), target);
  }
  for (const relative of stubbed) {
    const target = resolve(artifact, relative);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, 'stub\n');
  }
  await writeFile(resolve(artifact, 'demos/index.json'), JSON.stringify(stubIndex));
  return artifact;
}

describe('verify-release demo coverage', () => {
  it('collects entry and stage lessons from the index, deduplicated and sorted', () => {
    expect(demoLessonPaths({
      version: 1,
      demos: [
        { lesson: 'b.json', stages: [{ lesson: 'nested/tier.json' }] },
        { lesson: 'a.json' },
        { lesson: 'b.json' },
      ],
    })).toEqual(['a.json', 'b.json', 'nested/tier.json']);
  });

  it('refuses an index with no usable lesson list', () => {
    expect(() => demoLessonPaths({ version: 2, demos: [{ lesson: 'a.json' }] })).toThrow(/demo index/);
    expect(() => demoLessonPaths({ version: 1, demos: [] })).toThrow(/demo index/);
    expect(() => demoLessonPaths({ version: 1, demos: [{ stages: [] }] })).toThrow(/no lessons/);
  });

  it('lists every lesson the checked-in index names, and each one exists', async () => {
    const index = JSON.parse(await readFile(resolve(pluginRoot, 'demos/index.json'), 'utf8'));
    const lessons = demoLessonPaths(index);
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons).toContain('hemoglobin.json');
    expect(lessons).toContain('microtubule-growth/wall.json');
    for (const lesson of lessons) {
      await expect(readFile(resolve(pluginRoot, 'demos', lesson), 'utf8')).resolves.toContain('"id"');
    }
  });

  it('passes a release that carries the index and every lesson it lists', async () => {
    const artifact = await createArtifact();
    try {
      await expect(verifyLayout(artifact)).resolves.toBeUndefined();
    } finally {
      await rm(resolve(artifact, '..'), { force: true, recursive: true });
    }
  });

  it('rejects oversized runtime files and a missing split stylesheet before delivery', async () => {
    const artifact = await createArtifact();
    try {
      await writeFile(resolve(artifact, 'dist/inspector.html'), Buffer.alloc(5 * 1024 * 1024));
      await expect(verifyLayout(artifact)).rejects.toThrow(/5 MiB limit: dist\/inspector\.html/u);
      await writeFile(resolve(artifact, 'dist/inspector.html'), 'stub');
      await rm(resolve(artifact, 'dist/inspector.css'));
      await expect(verifyLayout(artifact)).rejects.toThrow(/missing dist\/inspector\.css/u);
    } finally {
      await rm(resolve(artifact, '..'), { force: true, recursive: true });
    }
  });

  // The first-run page is the only instruction a fresh install can follow, so
  // a release that drops it is a release nobody can start.
  it('fails a release missing the quickstart', async () => {
    const artifact = await createArtifact();
    try {
      await rm(resolve(artifact, 'QUICKSTART.md'));
      await expect(verifyLayout(artifact)).rejects.toThrow(/QUICKSTART\.md/);
    } finally {
      await rm(resolve(artifact, '..'), { force: true, recursive: true });
    }
  });

  it('fails a release missing the bundled headset command or standalone relay', async () => {
    for (const name of ['headset-host.mjs', 'serve-inspection.mjs', 'scene-socket-relay.mjs']) {
      const artifact = await createArtifact();
      try {
        await rm(resolve(artifact, 'dist', name));
        await expect(verifyLayout(artifact)).rejects.toThrow(name);
      } finally { await rm(resolve(artifact, '..'), { force: true, recursive: true }); }
    }
  });

  it('fails a release missing the demo index', async () => {
    const artifact = await createArtifact();
    try {
      await rm(resolve(artifact, 'demos/index.json'));
      await expect(verifyLayout(artifact)).rejects.toThrow(/demos\/index\.json/);
    } finally {
      await rm(resolve(artifact, '..'), { force: true, recursive: true });
    }
  });

  it('fails a release missing a lesson the index lists', async () => {
    const artifact = await createArtifact();
    try {
      await rm(resolve(artifact, 'demos/nested/tier.json'));
      await expect(verifyLayout(artifact)).rejects.toThrow(/demos\/nested\/tier\.json/);
    } finally {
      await rm(resolve(artifact, '..'), { force: true, recursive: true });
    }
  });
});

/**
 * A build directory holding the same bytes as the artifact's staged
 * bundles, with a server that registers the loopback panel tool.
 */
async function createBuilt(artifact: string): Promise<string> {
  await writeFile(resolve(artifact, 'dist/server.mjs'), 'registerAppTool(server,"stereo_structure.open_inspector")\n');
  const built = resolve(artifact, '..', 'built');
  await mkdir(built, { recursive: true });
  for (const name of ['server.mjs', 'headset-host.mjs', 'serve-inspection.mjs', 'scene-socket-relay.mjs',
    'inspector-host.js', 'inspector.html', 'inspector.css', 'inspector-script-1.js', 'inspector-script-2.js', 'viewer.html']) {
    await cp(resolve(artifact, 'dist', name), resolve(built, name));
  }
  return built;
}

describe('verify-release built copies', () => {
  it('refuses a stale bundled child host even when its parent and server match', async () => {
    const artifact = await createArtifact();
    try {
      const built = await createBuilt(artifact);
      await writeFile(resolve(built, 'serve-inspection.mjs'), 'rebuilt child host\n');
      await expect(verifyBuiltCopies(artifact, built)).rejects.toThrow(/dist\/serve-inspection\.mjs differs from the built/u);
    } finally {
      await rm(resolve(artifact, '..'), { force: true, recursive: true });
    }
  });

  it('passes when every staged bundle is the built one and the server registers open_inspector', async () => {
    const artifact = await createArtifact();
    try {
      const built = await createBuilt(artifact);
      await expect(verifyBuiltCopies(artifact, built)).resolves.toBeUndefined();
    } finally {
      await rm(resolve(artifact, '..'), { force: true, recursive: true });
    }
  });

  // The artifact is staged from dist/, so a rebuild after staging leaves a
  // release that ships an older bundle than the one the checkout just tested.
  it('fails a staged bundle whose bytes are not the built ones', async () => {
    const artifact = await createArtifact();
    try {
      const built = await createBuilt(artifact);
      await writeFile(resolve(built, 'inspector-host.js'), 'rebuilt after staging\n');
      await expect(verifyBuiltCopies(artifact, built)).rejects.toThrow(/dist\/inspector-host\.js differs from the built/u);
      await cp(resolve(artifact, 'dist/inspector-host.js'), resolve(built, 'inspector-host.js'));
      await writeFile(resolve(built, 'server.mjs'), 'registerAppTool(server,"stereo_structure.open_inspector") // newer\n');
      await expect(verifyBuiltCopies(artifact, built)).rejects.toThrow(/dist\/server\.mjs differs from the built/u);
    } finally {
      await rm(resolve(artifact, '..'), { force: true, recursive: true });
    }
  });

  it('fails a staged server built before open_inspector existed', async () => {
    const artifact = await createArtifact();
    try {
      const built = await createBuilt(artifact);
      await writeFile(resolve(artifact, 'dist/server.mjs'), 'stub\n');
      await writeFile(resolve(built, 'server.mjs'), 'stub\n');
      await expect(verifyBuiltCopies(artifact, built)).rejects.toThrow(/does not register stereo_structure\.open_inspector/u);
    } finally {
      await rm(resolve(artifact, '..'), { force: true, recursive: true });
    }
  });

  it('fails when the build has not run', async () => {
    const artifact = await createArtifact();
    try {
      const built = await createBuilt(artifact);
      await rm(resolve(built, 'viewer.html'));
      await expect(verifyBuiltCopies(artifact, built)).rejects.toThrow(/built dist\/viewer\.html is missing/u);
    } finally {
      await rm(resolve(artifact, '..'), { force: true, recursive: true });
    }
  });
});
