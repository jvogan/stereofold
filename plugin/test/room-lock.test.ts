import { describe, expect, it } from 'vitest';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra';
// @ts-ignore Import-free room-lock maths, shared with the browser XR layer.
import { applyMatrix4, headBasis, invertMatrix4, roomToSceneMatrix } from '../../lab/browser-roundtrip/room-lock.mjs';
// @ts-ignore Pure geometry exports are shared by the browser XR toolbar.
import { createToolbarPanel, hitToolbarPanel, mapXrPointToScene, toolbarPlateOutline } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';

type Point = readonly number[];
const close = (actual:Point, expected:Point, digits = 9) => expected.forEach((n,i) => expect(actual[i]).toBeCloseTo(n, digits));
const minus = (a:Point, b:Point) => a.map((value,index) => value - b[index]);
const dot = (a:Point, b:Point) => a.reduce((sum,value,index) => sum + value * b[index], 0);
const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

/** A camera view matrix, the way Mol* builds one: a look-at, so rigid. */
function view(position:Point, target:Point, up:Point = [0,1,0]) {
  return Array.from(Mat4.lookAt(Mat4(), position as any, target as any, up as any));
}

/** Carry a point the way the renderer does: `eyeView · scale · aTransform`. */
function toEye(point:Point, matrix:number[], cameraScale:number, eyeView:number[]) {
  const scene = applyMatrix4([...point], matrix)!;
  const world = scene.map((value:number) => value * cameraScale);
  return applyMatrix4(world, eyeView)!;
}

/**
 * The eye's own view matrix in Mol* XR: the headset pose taken inside the
 * offset reference space the XR manager builds from `camera.view`, which is
 * `pose⁻¹ · cameraView`.
 */
function eyeView(cameraView:number[], headPose:number[]) {
  return Array.from(Mat4.mul(Mat4(), Mat4.invert(Mat4(), headPose as any), cameraView as any));
}

const cameras: Array<{name:string, view:number[], scale:number}> = [
  { name: 'entry', view: view([0,0,10],[0,0,0]), scale: 0.0506 },
  { name: 'mid-orbit', view: view([7,2,7],[0,0,0]), scale: 0.0506 },
  { name: 'far side', view: view([0,3,-10],[0,0,0]), scale: 0.0506 },
  { name: 'scaled up', view: view([0,0,10],[0,0,0]), scale: 0.0709 },
  { name: 'orbited and scaled', view: view([-6,-4,5],[1,0.5,-2]), scale: 0.21 },
];

describe('the room-lock transform', () => {
  it('is the matrix form of the per-point mapping it replaces', () => {
    // The per-point map is what the panel used to bake into its geometry, and
    // it is known to place controls correctly. Proving the matrix agrees with
    // it is what carries that correctness across.
    for (const camera of cameras) {
      const matrix = roomToSceneMatrix(camera.view, camera.scale);
      const inverse = Mat4.invert(Mat4(), camera.view as any);
      for (const point of [[0,0,0], [0.4,1.6,-0.95], [-1.2,0.2,2.5]]) {
        close(applyMatrix4(point, matrix), mapXrPointToScene(point, inverse, camera.scale));
      }
    }
  });

  it('puts a room point in the same place in the eye whatever the camera does', () => {
    // This is the whole claim. Mol* draws a scene point through
    // `uModel · aTransform`, where `uModel` is the camera scale and the eye
    // view is the headset pose inside the offset space built from
    // `camera.view`. Give `aTransform` this matrix and both cancel, so the
    // eye sees the point where it stands in the room. A tour spin, a Fit, a
    // Scale row and a controller drag all move only `camera.view` and
    // `camera.scale`, so none of them can move a control.
    const head = view([0.1,1.6,0.2],[0.1,1.6,-1]);
    const roomPoints = [[0,1.6,-0.95], [-0.44,1.42,-0.86], [0.55,1.6,-0.71]];
    const expected = roomPoints.map(point => applyMatrix4(point, Array.from(Mat4.invert(Mat4(), head as any))));
    for (const camera of cameras) {
      const matrix = roomToSceneMatrix(camera.view, camera.scale);
      const eye = eyeView(camera.view, head);
      roomPoints.forEach((point, index) => close(toEye(point, matrix, camera.scale, eye), expected[index]!, 7));
    }
  });

  it('holds under a continuous orbit, to the precision a pixel could show', () => {
    // A tour spin moves the camera about a degree a frame. Sixty of those must
    // leave a control within 0.1 mm, against the 35 pixels the drawn menu
    // moved across one orbit before this change.
    const head = view([0,1.6,0],[0,1.6,-1]);
    const point = [-0.40,1.42,-0.86];
    const reference = applyMatrix4(point, Array.from(Mat4.invert(Mat4(), head as any)))!;
    for (let frame = 0; frame < 60; frame++) {
      const angle = frame * 1.5 * Math.PI / 180;
      const camera = view([Math.sin(angle) * 10, 2, Math.cos(angle) * 10], [0,0,0]);
      const scale = 0.05 * (1 + frame / 200);
      const seen = toEye(point, roomToSceneMatrix(camera, scale)!, scale, eyeView(camera, head));
      // A tenth of a millimetre at 0.9 m is far below one Quest 2 pixel.
      close(seen, reference, 4);
    }
  });

  it('refuses a camera it cannot invert rather than placing a control at the origin', () => {
    expect(roomToSceneMatrix(cameras[0]!.view, 0)).toBeUndefined();
    expect(roomToSceneMatrix(cameras[0]!.view, Number.NaN)).toBeUndefined();
    expect(roomToSceneMatrix(new Array(16).fill(0), 1)).toBeUndefined();
    expect(roomToSceneMatrix(undefined, 1)).toBeUndefined();
    expect(roomToSceneMatrix([1,2,3], 1)).toBeUndefined();
  });

  it('inverts a matrix the way Mol* does', () => {
    for (const camera of cameras) {
      close(invertMatrix4(camera.view), Array.from(Mat4.invert(Mat4(), camera.view as any)), 9);
    }
    expect(invertMatrix4(identity)).toEqual(identity);
    expect(invertMatrix4(new Array(16).fill(Number.NaN))).toBeUndefined();
  });
});

describe('the seat the room lock holds', () => {
  const rows = Array.from({length:9}, (_,index) => ({ label: `Control ${index}`, action: { index } }));
  const head = { position: {x:0,y:1.6,z:0}, matrix: identity };

  it('reads one head basis for every seat, right-handed and level', () => {
    const basis = headBasis(head)!;
    close(basis.origin, [0,1.6,0]);
    close(basis.forward, [0,0,-1]);
    close(basis.right, [1,0,0]);
    close(basis.up, [0,1,0]);
    // Turned to face -x, so right becomes -z. A seat built on this basis
    // follows the wearer's entry orientation and nothing else.
    const turned = headBasis({ ...head, matrix: [0,0,-1,0, 0,1,0,0, 1,0,0,0, 0,0,0,1] })!;
    close(turned.forward, [-1,0,0]);
    close(turned.right, [0,0,-1]);
    close(turned.up, [0,1,0]);
    expect(headBasis(undefined)).toBeUndefined();
    expect(headBasis({ matrix: identity } as any)).toBeUndefined();
  });

  it('places the panel from the entry pose and from nothing else', () => {
    // `createToolbarPanel` takes no camera, so a camera cannot reach it. The
    // panel two different cameras produce is the same object, byte for byte.
    const first = createToolbarPanel({ rows, head });
    const second = createToolbarPanel({ rows, head });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const basis = headBasis(head)!;
    // Every drawn point stays in the room: it is a fixed combination of the
    // entry origin and the entry basis, in metres.
    for (const button of first.buttons) {
      const offset = minus(button.point, basis.origin);
      expect(Math.abs(dot(offset, basis.forward))).toBeGreaterThan(0.5);
      expect(Math.hypot(...offset)).toBeLessThan(2);
    }
  });

  it('hits the row it draws, in the room, with the ray transformed the same way', () => {
    // Drawing and hit testing now read the same room metres, so a plate the
    // wearer sees and the plate a ray accepts cannot drift apart. Each row's
    // drawn face has to contain the point its own ray lands on.
    const panel = createToolbarPanel({ rows, head });
    const origin = [0,1.6,0];
    panel.buttons.forEach((button:any, index:number) => {
      const hit = hitToolbarPanel(panel, { origin, direction: minus(button.point, origin) });
      expect(hit?.action.index).toBe(index);
      const outline = toolbarPlateOutline(panel, button, { inset: panel.plateInsetMeters, depth: 0, segments: 3 });
      const x = outline.map((point:Point) => dot(minus(point, button.point), panel.right));
      const y = outline.map((point:Point) => dot(minus(point, button.point), panel.up));
      expect(Math.max(...x)).toBeLessThanOrEqual(button.halfWidth + 1e-9);
      expect(Math.max(...y)).toBeLessThanOrEqual(button.halfHeight + 1e-9);
    });
  });

  it('draws each row where its own ray lands, under every camera', () => {
    // The hit test works in room metres from controller poses; the draw goes
    // through the room-lock matrix. If the two disagreed, the wearer would
    // press a row that is not under the ray. So take the point the ray
    // actually strikes on the panel plane, carry it down the render chain,
    // and require it to reach the eye at the same place as the row's drawn
    // centre. It has to hold for a camera mid-orbit as well as at entry.
    const panel = createToolbarPanel({ rows, head });
    const origin = [0,1.6,0];
    const pose = view([0,1.6,0],[0,1.6,-1]);
    const inversePose = Array.from(Mat4.invert(Mat4(), pose as any));
    for (const camera of cameras) {
      const matrix = roomToSceneMatrix(camera.view, camera.scale)!;
      const eye = eyeView(camera.view, pose);
      panel.buttons.forEach((button:any, index:number) => {
        const direction = minus(button.point, origin);
        expect(hitToolbarPanel(panel, { origin, direction })?.action.index).toBe(index);
        // Where the ray meets the panel plane, in room metres.
        const distance = dot(minus(panel.anchor, origin), panel.normal) / dot(direction, panel.normal);
        const struck = direction.map((value,axis) => origin[axis]! + value * distance);
        close(toEye(struck, matrix, camera.scale, eye), applyMatrix4(struck, inversePose)!, 7);
      });
    }
  });
});
