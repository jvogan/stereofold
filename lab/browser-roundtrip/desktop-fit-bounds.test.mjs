import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { BoundaryHelper } from 'molstar/lib/mol-math/geometry/boundary-helper.js';
import { motionFixture } from './motion-benchmark-fixture.mjs';
import { updatePlacementBounds } from './placement-bounds.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const source=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const object=(type,center,radius)=>({type,state:{visible:true},values:{drawCount:{ref:{value:12}},boundingSphere:{ref:{value:{center,radius}}}}});
function fitContext(representations) {
  const fits=[], resets=[];
  const c=vm.createContext({BoundaryHelper, volume:undefined, assertReady(){},
    scientificRepresentations:includeCompanion=>{assert.equal(includeCompanion,true);return representations();},
    canvas:{xr:{isPresenting:{value:false}},requestCameraReset:options=>resets.push(options)},
    plugin:{managers:{camera:{focusSphere:(sphere,options)=>fits.push({sphere:plain(sphere),options:plain(options)})}}},
    molecularAnimation:{envelope:()=>undefined},inspectionMutation:async action=>action(),syncInspectionPayload(){},
    inspectionState:{recordPayload(){},setPayload(){}},inspectionPayload:()=>({}),snapshot:()=>({}),
    presentationTransform:()=>{throw Error('Committed molecular spheres are already transformed.');},
  });
  for(const name of ['molecularBounds','fitInspection'])vm.runInContext(pageFunction(source,name),c);
  return {c,fits,resets};
}

// Real parsed local sources and Mol* CPU geometry; camera submission is adapted.
// A moved comparison and giant label are separate objects with actual placement
// transforms, so the test detects double transforms and accidental label bounds.
for(const file of ['4HHB.cif','identity-edge.cif'])test(`atomic Fit ignores annotation padding for local ${file}, placed comparison and source change`,async()=>{
  const h=await motionFixture({source:readFileSync(new URL(`../../fixtures/${file}`,import.meta.url),'utf8'),animation:null});
  try{
    const primary=[...h.plugin.state.data.cells.values()].find(cell=>cell.obj?.data?.repr?.renderObjects?.some(o=>o.type==='mesh')).obj.data.repr;
    const transform=Mat4.fromUniformScaling(Mat4(),2);transform[12]=120;transform[13]=-25;transform[14]=70;
    primary.setState({transform});updatePlacementBounds(primary);
    const molecular=primary.renderObjects.filter(o=>o.state.visible&&o.values.drawCount.ref.value);
    assert.ok(molecular.length,'actual source must produce molecular geometry');
    const label={renderObjects:[object('text',[10000,10000,10000],9000)]};
    const image={renderObjects:[{...label.renderObjects[0],type:'image'}]};
    const companion={renderObjects:[object('mesh',[400,-25,70],30)]};
    let current=[primary,label,image,companion];const {c,fits,resets}=fitContext(()=>current);
    assert.ok(c.molecularBounds(true).radius>9000,'existing room-bound callers retain their original annotation policy');
    await c.fitInspection();
    assert.equal(resets.length,0,'atomic Fit must not use aggregate scene padding');
    const fitted=fits.at(-1).sphere;
    assert.ok(fitted.radius<500,'selected-residue labels and UI images do not inflate camera fit');
    for(const object of [...molecular,...companion.renderObjects]){
      const s=object.values.boundingSphere.ref.value;
      const distances=s.extrema?.length?s.extrema.map(p=>Math.hypot(...p.map((v,i)=>v-fitted.center[i])))
        :[Math.hypot(...s.center.map((v,i)=>v-fitted.center[i]))+s.radius];
      assert.ok(distances.every(distance=>distance<=fitted.radius+1e-6),
        'Fit includes transformed molecular extrema and the comparison sphere');
    }
    assert.deepEqual(fits.at(-1).options,{durationMs:0,extraRadius:0,minRadius:0});
    // New source membership is read at every request; no old annotation/camera
    // sphere can survive replacement, and hidden/empty objects are excluded.
    const next=object('mesh',[-80,3,9],12);
    current=[{renderObjects:[next,{...next,state:{visible:false},values:label.renderObjects[0].values},
      {...next,values:{...label.renderObjects[0].values,drawCount:{ref:{value:0}}}}]}];
    await c.fitInspection();
    assert.ok(fits.at(-1).sphere.center.every((v,i)=>Math.abs(v-[-80,3,9][i])<1e-9));
    assert.ok(Math.abs(fits.at(-1).sphere.radius-12)<1e-9);
  }finally{await h.dispose();}
});

test('density retains its camera reset and XR retains focusSelection',async()=>{
  const {c,resets,fits}=fitContext(()=>{throw Error('Density/XR must not enter desktop atomic bounds.');});
  c.volume={};await c.fitInspection();assert.equal(resets.length,1);assert.equal(fits.length,0);
  c.canvas.xr.isPresenting.value=true;let focused=0;c.focusSelection=async options=>{focused++;assert.deepEqual(plain(options),{wholeStructure:true,liftEmphasis:false});};
  await c.fitInspection();assert.equal(focused,1);assert.equal(resets.length,1);
});
