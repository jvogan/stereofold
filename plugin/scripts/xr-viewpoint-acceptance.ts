import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import type { Page } from 'playwright';
const { Mat4, Quat, Vec3 } = createRequire(import.meta.url)('molstar/lib/commonjs/mol-math/linear-algebra.js') as typeof import('molstar/lib/mol-math/linear-algebra');

/** Read-only geometry inspection over the existing served-HTML accessor. */
async function installViewpointProbe(page: Page) {
  const directory = fileURLToPath(new URL('../../lab/browser-roundtrip/', import.meta.url));
  const bundle = await build({ bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
    stdin: { resolveDir: directory, sourcefile: 'viewpoint-probe.mjs', contents: `
import { renderedSubjectPoints } from './component-label-measurement.mjs';
import { litVertex } from './entry-standoff.mjs';
import { applyMatrix4, invertMatrix4 } from './room-lock.mjs';
globalThis.__stereofoldViewpointSnapshot = () => {
  const geometry = globalThis.__stereofoldReadGeometry?.();
  if (!geometry?.objects?.length || !geometry.views?.length || geometry.renderFromRoom?.length !== 16)
    throw Error('Viewpoint acceptance requires the live molecular geometry accessor.');
  const roomFromRender = invertMatrix4(geometry.renderFromRoom);
  if (!roomFromRender) throw Error('Molecular render-to-room transform is not invertible.');
  const points = geometry.objects.flatMap(object => renderedSubjectPoints(object, geometry.cameraScale, Infinity, litVertex));
  if (!points.length) throw Error('Viewpoint acceptance has no live lit molecular vertices.');
  const bounds = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity] };
  for (const point of points) {
    const room = applyMatrix4(point, roomFromRender);
    if (!room?.every(Number.isFinite)) throw Error('A molecular room-space vertex is not finite.');
    for (let axis=0;axis<3;axis++) { bounds.min[axis]=Math.min(bounds.min[axis],room[axis]); bounds.max[axis]=Math.max(bounds.max[axis],room[axis]); }
  }
  const rows = globalThis.__stereofoldDiagnostics?.entries?.().filter(entry => entry.kind === 'toolbar' && entry.detail.phase === 'rows') ?? [];
  const draw = rows.at(-1)?.detail.draw;
  const menu = rows.filter(entry => entry.detail.draw === draw).flatMap(entry => entry.detail.x.map((x,i) => ({
    action:entry.detail.actions[i], point:[x,entry.detail.y[i],entry.detail.z[i]]
  })));
  return { vertexCount: points.length, roomBoundsMeters: bounds, cameraScale: geometry.cameraScale,
    renderFromRoom: Array.from(geometry.renderFromRoom),
    eyes: geometry.views.map(view=>({eye:view.eye, inverse:Array.from(view.transform.inverse.matrix), projection:Array.from(view.projectionMatrix)})),
    projected: globalThis.__stereofoldMeasureMolecule().eyes,
    drawSerial: globalThis.__companionXrTest.drawSerial(), menu: {draw,rows:menu},
    viewerFrame: globalThis.__controllerAcceptance?.viewerFrame };
};` },
    plugins: [{ name: 'viewpoint-existing-lit-reader', setup(api) {
      api.onLoad({ filter: /[/\\]entry-standoff\.mjs$/ }, async args => ({
        contents: `${await readFile(args.path, 'utf8')}\nexport { litVertex };`, loader: 'js',
      }));
    } }],
  });
  await page.evaluate(bundle.outputFiles[0]!.text);
}

const close = (a: number[], b: number[], tolerance: number, label: string) => {
  assert.ok(a?.length === b?.length && a.every((v, i) => Number.isFinite(v) && Number.isFinite(b[i]) && Math.abs(v - b[i]) <= tolerance),
    `${label}: ${JSON.stringify(a)} versus ${JSON.stringify(b)}`);
};
const vector = (values: number[]) => Vec3.create(values[0], values[1], values[2]);
const quaternion = (values: number[]) => Quat.create(values[0], values[1], values[2], values[3]);

/** A simulated orbit of the viewer, using IWER head input only. Call after a
 * rendered reset with controller buttons and sticks released. The supplied
 * frameWait is the native-frame waiter from controller acceptance. */
export async function runViewpointAcceptance(page: Page, readSaved: () => Promise<any>,
  frameWait: (milliseconds: number) => Promise<unknown>, evidence: any = {}) {
  Object.assign(evidence, {
    scope: 'IWER translated head poses around the molecular centre; production rendered geometry and saved pose. No physical walking or headset comfort evidence.',
    geometryScope: 'All live lit vertices of primary and ligand representations; excludes separate styled/comparison representations and text.',
    menuScope: 'Latest published production toolbar row centres in room metres; excludes plate/glyph edges and does not establish current pixel visibility or gesture clearance.',
    samples: [],
  });
  await installViewpointProbe(page);
  const original = await page.evaluate(() => {
    const device = (globalThis as any).__companionXrTest.device;
    return { position: [device.position.x, device.position.y, device.position.z],
      quaternion: [device.quaternion.x, device.quaternion.y, device.quaternion.z, device.quaternion.w] };
  });
  const placement = async () => (await readSaved()).scene.inspection.placement;
  const snapshot = () => page.evaluate(() => (globalThis as any).__stereofoldViewpointSnapshot());
  const setHead = (pose: typeof original) => page.evaluate(pose => {
    const device = (globalThis as any).__companionXrTest.device;
    device.position.set(...pose.position); device.quaternion.set(...pose.quaternion);
  }, pose);
  const saved = await placement();
  let originalFailure: unknown;
  let baseline: any;
  try {
    await frameWait(250);
    baseline = await snapshot();
    assert.equal(baseline.eyes.length, 2, 'Viewpoint replay requires two rendered eye views');
    assert.ok(baseline.viewerFrame?.viewerFromRoom?.length === 16, 'No native viewer-to-room measurement');
    const bounds = baseline.roomBoundsMeters;
    const center = bounds.min.map((v: number, i: number) => (v + bounds.max[i]) / 2);
    const radius = Math.max(.75, Math.hypot(...bounds.max.map((v: number, i: number) => v - bounds.min[i])) * .625 + .25);
    const deviceFromViewer = Mat4.compose(Mat4(), vector(original.position), quaternion(original.quaternion), Vec3.create(1,1,1));
    // The native viewer pose is in XR reference-space metres, which can be
    // offset from IWER device coordinates by the session's origin.
    const deviceFromRoom = Mat4.mul(Mat4(), deviceFromViewer, Mat4.fromArray(Mat4(), baseline.viewerFrame.viewerFromRoom, 0));
    evidence.baseline = { placement: saved, ...baseline };
    evidence.orbit = { centerRoomMeters: center, radiusMeters: radius, anglesDegrees: [0,90,180,270,360] };
    const verify = async (sample: any, label: string) => {
      const current = await placement();
      close(current.translation, saved.translation, 1e-8, `${label} moved saved molecular placement`);
      close(current.rotation, saved.rotation, 1e-8, `${label} rotated saved molecular placement`);
      close([current.scale], [saved.scale], 1e-8, `${label} resized saved molecular placement`);
      assert.equal(sample.vertexCount, baseline.vertexCount, `${label} changed molecular geometry membership`);
      for (const bound of ['min','max']) close(sample.roomBoundsMeters[bound], baseline.roomBoundsMeters[bound], 1e-4, `${label} moved rendered room-space molecular bounds`);
      assert.deepEqual(sample.eyes.map((eye: any) => eye.eye).sort(), ['left','right'], `${label} lost an eye`);
      sample.savedPlacementUnchanged = true;
      const previousRows = baseline.menu.rows, rows = sample.menu.rows;
      const comparableMenu = previousRows.length && rows.length === previousRows.length
        && rows.every((row: any, i: number) => row.action === previousRows[i].action);
      // An unchanged draw number is historical row evidence. A bounded ring
      // may also retain only part of a draw; neither proves a current menu.
      const freshMenu = sample.menu.draw > baseline.menu.draw;
      sample.menuRoomAnchor = comparableMenu && freshMenu ? 'checked-published-row-centres'
        : freshMenu ? 'incomplete-or-changed-menu-rows' : 'no-new-menu-geometry';
      if (comparableMenu && freshMenu) {
        for (let i=0;i<rows.length;i++) {
          close(rows[i].point, previousRows[i].point, 1e-4, `${label} moved published room-space menu row ${i}`);
        }
      }
    };
    let previous = baseline;
    for (const degrees of [0,90,180,270,360]) {
      const angle = degrees * Math.PI / 180;
      const roomPosition = Vec3.create(center[0] + radius * Math.sin(angle), center[1], center[2] + radius * Math.cos(angle));
      const roomFromViewer = Mat4.targetTo(Mat4(), roomPosition, vector(center), Vec3.create(0,1,0));
      const deviceFromPose = Mat4.mul(Mat4(), deviceFromRoom, roomFromViewer);
      const injected = { position: Array.from(Mat4.getTranslation(Vec3(), deviceFromPose)),
        quaternion: Array.from(Quat.fromMat4(Quat(), deviceFromPose)) };
      await setHead(injected);
      await frameWait(250);
      const sample = await snapshot();
      Object.assign(sample, { degrees, positionRoomMeters: Array.from(roomPosition), injectedPose: injected });
      evidence.samples.push(sample);
      assert.ok(sample.drawSerial > previous.drawSerial, `${degrees}° viewpoint produced no new draw`);
      if (degrees > 0) {
        const before = previous.eyes.find((eye: any) => eye.eye === 'left').inverse;
        const after = sample.eyes.find((eye: any) => eye.eye === 'left').inverse;
        assert.ok(after.some((v: number, i: number) => Math.abs(v - before[i]) > .05), `${degrees}° did not change the rendered eye viewpoint`);
      }
      assert.ok(sample.projected.every((eye: any) => eye.tangentSilhouette && eye.depthMeters.farthest > 0),
        `${degrees}° rendered viewpoint does not see molecular geometry`);
      await verify(sample, `${degrees}° viewpoint`);
      previous = sample;
    }
    const first = evidence.samples[0], returned = evidence.samples.at(-1);
    for (const eye of first.eyes) close(returned.eyes.find((value: any) => value.eye === eye.eye).inverse, eye.inverse, 1e-4, 'The 360° return changed the original orbit viewpoint');
    evidence.completed = true;
    return evidence;
  } catch (error) {
    originalFailure = error;
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      await setHead(original);
      await frameWait(250);
      evidence.originalHeadPoseRestored = true;
      if (baseline) {
        const restored = await snapshot();
        close(restored.roomBoundsMeters.min, baseline.roomBoundsMeters.min, 1e-4, 'Head restoration moved molecular room bounds');
        close(restored.roomBoundsMeters.max, baseline.roomBoundsMeters.max, 1e-4, 'Head restoration moved molecular room bounds');
        const current = await placement();
        close(current.translation, saved.translation, 1e-8, 'Head restoration moved saved molecule');
        close(current.rotation, saved.rotation, 1e-8, 'Head restoration rotated saved molecule');
        close([current.scale], [saved.scale], 1e-8, 'Head restoration resized saved molecule');
        evidence.restoredDrawSerial = restored.drawSerial;
      }
    } catch (error) {
      evidence.restoreFailure = error instanceof Error ? error.message : String(error);
      if (!originalFailure) throw error;
    }
  }
}
