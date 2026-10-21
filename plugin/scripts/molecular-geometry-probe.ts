/** Read-only test instrumentation; never written into distributed HTML. */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export function instrumentMolecularGeometry(html: string): string {
  const modern = /getEntryGeometry:\(\{keyOnly:/u;
  const start = html.search(modern);
  if (start >= 0) {
    if ([...html.matchAll(/getEntryGeometry:\(\{keyOnly:/gu)].length !== 1)
      throw Error('Expected exactly one production molecular entry-geometry reader.');
    const tail = html.slice(start), end = tail.indexOf('beforeMenuDraw:');
    if (end < 0) throw Error('Expected the molecular geometry reader before menu drawing.');
    const reader = tail.slice(0, end);
    const primary = reader.match(/:\[([A-Za-z_$][\w$]*)\?\.obj\?\.data\?\.repr,/u)?.[1];
    if (!primary || !reader.includes('return{objects:')) throw Error('Expected source-backed molecular geometry.');
    return html.slice(0, start) + reader.replace('getEntryGeometry:', 'getEntryGeometry:globalThis.__stereofoldReadGeometry=')
      .replace('return{objects:', `return{sourceBoundary:${primary}?.obj?.data?.sourceData?.boundary?.sphere,objects:`) + tail.slice(end);
  }
  const target = 'getEntryGeometry:()=>({objects:';
  if (html.split(target).length !== 2) throw Error('Expected exactly one production molecular entry-geometry reader.');
  const primary = html.match(/getEntryGeometry:\(\)=>\(\{objects:\[([A-Za-z_$][\w$]*)\?\.obj\?\.data\?\.repr,/u)?.[1];
  if (!primary) throw Error('Expected a primary molecular representation in the geometry reader.');
  return html.replace(target, `getEntryGeometry:globalThis.__stereofoldReadGeometry=()=>({sourceBoundary:${primary}?.obj?.data?.sourceData?.boundary?.sphere,objects:`);
}

export async function molecularGeometryProbeBundle(): Promise<string> {
  const directory = fileURLToPath(new URL('../../lab/browser-roundtrip/', import.meta.url));
  const separationReader = fileURLToPath(new URL('./xr-frustum-separation.ts', import.meta.url));
  const densityReader = fileURLToPath(new URL('./density-geometry-probe.ts', import.meta.url));
  const bundled = await build({ bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
    stdin: { resolveDir: directory, sourcefile: 'molecular-geometry-probe.mjs', contents: `
import { measureEntryStandoff, litVertex } from './entry-standoff.mjs';
import { renderedSubjectPoints, renderedSubjectSpheres, labelObjectVisible, measureComponentLabels } from './component-label-measurement.mjs';
import { applyMatrix4 } from './room-lock.mjs';
import { readDensityGeometryObjects } from ${JSON.stringify(densityReader)};
import { rightFrustumSphereSeparation } from ${JSON.stringify(separationReader)};
globalThis.__stereofoldMeasureMolecule = menuPoints => {
  const geometry = globalThis.__stereofoldReadGeometry?.();
  if (!geometry?.objects?.length || !geometry.views?.length) throw Error('Molecular geometry is unavailable.');
  const points = geometry.objects.flatMap(object => renderedSubjectPoints(object, geometry.cameraScale, Infinity, litVertex));
  if (!points.length) throw Error('No live lit molecular vertices.');
  const liveObjects = geometry.objects.filter(object => object.type !== 'text' && labelObjectVisible(object));
  if (!liveObjects.length) throw Error('No live molecular objects.');
  const spheres = liveObjects.flatMap(object => {
    const bounds = renderedSubjectSpheres(object, geometry.cameraScale);
    if (!bounds.length) throw Error('A live molecular object has no rendered sphere bounds.');
    // Cylinder impostor bounds can keep shader padding separate from the
    // invariant sphere. Inflate conservatively (double padding for readers
    // that already included it is safe) using the largest instance scale.
    const padding = object.values?.padding?.ref?.value ?? 0;
    if (!Number.isFinite(padding) || padding < 0) throw Error('Invalid molecular impostor padding.');
    if (padding > 0) {
      const transforms = object.values?.aTransform?.ref?.value;
      const matrices = transforms?.length >= 16 ? transforms : object.values?.matrix?.ref?.value;
      if (!matrices?.length || matrices.length % 16) throw Error('Missing molecular padding transform.');
      let maximumScale = 0;
      for (let index=0;index<matrices.length;index+=16) for (const axis of [0,4,8])
        maximumScale = Math.max(maximumScale,Math.hypot(matrices[index+axis],matrices[index+axis+1],matrices[index+axis+2]));
      if (!(maximumScale > 0) || !Number.isFinite(maximumScale)) throw Error('Invalid molecular padding scale.');
      for (const bound of bounds) bound.radius += padding * maximumScale * geometry.cameraScale;
    }
    return bounds;
  });
  const bounds = points => {
    const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
    for (const point of points) for (let i=0;i<3;i++) { min[i]=Math.min(min[i],point[i]); max[i]=Math.max(max[i],point[i]); }
    return {min,max,extent:max.map((v,i)=>v-min[i])};
  };
  const measured = measureComponentLabels({ views: geometry.views, subject: { points } });
  const angle = (center, half) => (Math.atan(center+half)-Math.atan(center-half))*180/Math.PI;
  return {
    scope: 'Read-only served-HTML accessor; production live-count and lit-membership readers, all live vertices in the primary and ligand representations; excludes toolbar/text and separate styled or comparison representations. Simulator geometry, not physical headset evidence.',
    vertexCount: points.length, objectCount: geometry.objects.length, sphereCount: spheres.length, liveObjectCount: liveObjects.length,
    separationScope: 'Conservative full rendered instance spheres for primary and ligand representations only, including triangle and impostor extent; excludes separate styled or comparison representations. Both eyes must have strictly positive right-plane separation and nearest sphere depth.',
    cameraScale: geometry.cameraScale,
    renderCoordinateBoundsMeters: bounds(points),
    eyes: measured.map(eye => {
      const view = geometry.views.find(view=>view.eye===eye.eye);
      const physical = bounds(points.map(point=>applyMatrix4(point,view.transform.inverse.matrix)));
      const s=eye.silhouette;
      return {eye:eye.eye,tangentSilhouette:s,angularDegrees:s?{width:angle(s[0],s[2]),height:angle(s[1],s[3])}:null,
        silhouetteScope:'Live vertices inside this eye frustum; clipped geometry is excluded by production projection.',
        rightFrustumSeparation:rightFrustumSphereSeparation(spheres.map(sphere=>({
          center:applyMatrix4(sphere.center,view.transform.inverse.matrix),radius:sphere.radius})),view.projectionMatrix),
        eyeCoordinateBoundsMeters:physical,depthMeters:{nearest:-physical.max[2],farthest:-physical.min[2]}};
    }),
    sampledProductionStandoff: menuPoints?.length ? measureEntryStandoff({...geometry,menuPoints}) : null,
    menuPointScope: 'Optional toolbar row centres supplied by harness; standoff is advisory, not full panel clearance proof.'
  };
};
globalThis.__stereofoldMeasureDensity = () => {
  const geometry=globalThis.__stereofoldReadGeometry?.(), active=globalThis.__companionXrTest?.active;
  if (!geometry?.objects?.length || !geometry.views?.length) throw Error('Density geometry is unavailable.');
  // IWER presents through a null default FBO: no non-null bind is observed,
  // so its XR layer context is authoritative, as in the frame capture reader.
  const gl=active?.gl ?? active?.session?.renderState?.baseLayer?.context;
  const bindFramebuffer=active?.nativeBindFramebuffer ?? gl?.bindFramebuffer?.bind(gl);
  const objects=readDensityGeometryObjects(geometry.objects,gl,bindFramebuffer);
  const points=objects.flatMap(object=>renderedSubjectPoints(object,geometry.cameraScale,Infinity));
  if (!points.length) throw Error('No live density vertices.');
  const bounds=points=>{
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for (const point of points) for (let axis=0;axis<3;axis++) {min[axis]=Math.min(min[axis],point[axis]);max[axis]=Math.max(max[axis],point[axis]);}
    return {min,max,extent:max.map((value,axis)=>value-min[axis])};
  };
  const measured=measureComponentLabels({views:geometry.views,subject:{points}});
  const angle=(center,half)=>(Math.atan(center+half)-Math.atan(center-half))*180/Math.PI;
  return {scope:'Read-only GPU isosurface position-texture readback, live triangle vertices and committed instance transforms; production per-eye projection. Excludes toolbar/text. Simulator evidence, not physical headset evidence.',
    vertexCount:points.length,triangleCount:objects.reduce((count,object)=>count+object.values.drawCount.ref.value/3,0),
    objectCount:objects.length,cameraScale:geometry.cameraScale,renderCoordinateBoundsMeters:bounds(points),
    eyes:measured.map(eye=>{
      const view=geometry.views.find(view=>view.eye===eye.eye),physical=bounds(points.map(point=>applyMatrix4(point,view.transform.inverse.matrix))),s=eye.silhouette;
      return {eye:eye.eye,tangentSilhouette:s,angularDegrees:s?{width:angle(s[0],s[2]),height:angle(s[1],s[3])}:null,
        silhouetteScope:'Live isosurface vertices inside this eye frustum; clipped geometry is excluded by production projection.',
        eyeCoordinateBoundsMeters:physical,depthMeters:{nearest:-physical.max[2],farthest:-physical.min[2]}};
    })};
};` },

  });
  return bundled.outputFiles[0]!.text;
}
