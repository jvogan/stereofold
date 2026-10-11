/** Test-only instrumentation of the HTML served to isolated demo acceptance.
 * No file in dist is changed. Fail closed if the compiled initialization moves.
 */
export function instrumentDemoRenderObjects(html: string): string {
  const initialization = /let ([$\w]+)=([$\w]+)\.canvas3d;if\(!\1\)throw \2\.dispose\(\),new Error\("Mol\* did not create Canvas3D\."\);/g;
  const matches = [...html.matchAll(initialization)];
  if (matches.length !== 1) throw Error('Expected one known Canvas3D initialization for the test-only render probe.');
  const match = matches[0]!;
  const canvas = match[1]!;
  const probe = `globalThis.__stereofoldDemoRenderObjects=()=>{
    const objects=${canvas}.getRenderObjects();
    const primitives=objects.filter(o=>o.state.visible && o.type!=='direct-volume');
    // Same visible-primitive mean as Mol* Scene.calculateMarkerAverage. The
    // public Canvas3D accessor does not expose the renderer uniform itself.
    const derivedSceneMarkerAverage=primitives.length
      ? primitives.reduce((sum,o)=>sum+(o.values.markerAverage?.ref?.value ?? NaN),0)/primitives.length : 0;
    const eligible=${canSkipFullyTransparentMesh.toString()};
    const records=objects.map(o=>{
      const v=k=>o.values[k]?.ref?.value;
      return {id:o.id,type:o.type,visible:o.state.visible,
        drawCount:v('drawCount'),instances:v('instanceCount'),
        alpha:v('alpha'),alphaFactor:o.state.alphaFactor,
        transparencyAverage:v('transparencyAverage'),
        transparencyEnabled:v('dTransparency'),transparencyType:v('dTransparencyType'),
        transparencyStrength:v('uTransparencyStrength'),geometryType:v('dGeometryType'),
        markerAverage:v('markerAverage'),markerUniform:v('uMarker'),
        doubleSided:v('uDoubleSided'),backfaces:v('dTransparentBackfaces'),
        blendedColorSkipEligible:o.state.visible && eligible(o.values,derivedSceneMarkerAverage)};
    });
    return {representationCount:${canvas}.reprCount.value,derivedSceneMarkerAverage,
      markerAverageScope:'Recomputed visible primitive mean; not a read of the renderer uniform.',
      blendedColorSkipEligible:records.filter(o=>o.blendedColorSkipEligible).length,
      skipScope:'Guard eligibility before frustum/occlusion/instance culling; not measured GPU submissions.',objects:records};
  };`;
  return html.slice(0, match.index! + match[0].length) + probe + html.slice(match.index! + match[0].length);
}
import { canSkipFullyTransparentMesh } from '../src/molstar-transparent-mesh-patch.js';
