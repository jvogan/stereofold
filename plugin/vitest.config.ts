import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { patchMolstarStereoSource } from './src/molstar-stereo-patch';

/**
 * Unit tests import the same patched Mol* the browser bundle ships.
 *
 * `scripts/build.ts` applies `patchMolstarStereoSource` through an esbuild
 * `onLoad` hook, so until now nothing under `test/` could import the patched
 * `StereoCamera` — the tests could only assert on the patched *text*, and a
 * defect in what that text computes was invisible to them. The
 * outward-displacement bug lived in exactly that gap. This Vite plugin is the
 * same transform on the same file, so `import { StereoCamera } from
 * 'molstar/lib/mol-canvas3d/camera/stereo.js'` inside a test is the shipped
 * class, not the stock one.
 */
export default defineConfig({
  plugins: [
    {
      name: 'stereofold-molstar-stereo-patch',
      enforce: 'pre',
      transform(code: string, id: string) {
        if (!/mol-canvas3d[/\\]camera[/\\]stereo\.js$/u.test(id)) return null;
        return { code: patchMolstarStereoSource(code), map: null };
      },
    },
  ],
  test: {
    environment: 'node',
    setupFiles: ['test/setup-device-isolation.ts'],
    include: ['test/**/*.test.ts'],
    // A server built without its own scene-service file looks up the owner
    // record when it meets an unknown session. Point that lookup at a scratch
    // path, so a test never reaches a share running on the developer's Mac.
    env: { STEREOFOLD_SCENE_SERVICE: join(tmpdir(), `stereofold-vitest-${process.pid}`, 'scene-service.json') },
    // The stereo-frame test builds real Mol* Camera and StereoCamera objects
    // and projects through them at dozens of poses; Mol*'s first import alone
    // costs several seconds on a loaded machine.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
