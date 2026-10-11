import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
// @ts-ignore Browser helpers exercised without a headset runtime.
import {componentLabelProjectionGain} from '../../lab/browser-roundtrip/component-labels.mjs';
// @ts-ignore Browser helpers exercised without a headset runtime.
import {CAPTION_FONT_METERS,CAPTION_TEXT_LIFT_METERS,captionSeat,captionTextOrigin} from '../../lab/browser-roundtrip/talk-caption.mjs';
// @ts-ignore Shared production geometry accounting, exercised by the renderer lab as well.
import {REPRESENTATION_BUDGETS,geometryBudgetReceipt,requireSceneGeometryBudget} from '../../lab/browser-roundtrip/representation-budget.mjs';
import {geometryBudgetReceiptSchema} from '../src/inspection-contract.js';

// Observed in Safari in the visionOS 27.0 Simulator.
const lab=(name:string)=>readFile(new URL(`../../lab/browser-roundtrip/${name}`,import.meta.url),'utf8');

it('reads each eye viewport inside the XR frame, never from a retained view', async()=>{
  // WebKit's getViewport throws InvalidStateError for a view whose frame has
  // ended. Label sizing runs from an async command, so a residue-label request
  // failed with "The object is in an invalid state." and wedged the panel.
  const viewer=await lab('viewer.mjs');
  expect(viewer).toMatch(/const labelViewports = labelViews\.map\(view => \{\s*try \{ const viewport = baseLayer\?\.getViewport\(view\)/);
  expect(viewer).toMatch(/labelViews, labelViewports \} : null;/);
  // The only getViewport call left in the viewer is the one inside the frame.
  expect(viewer.match(/getViewport\(/g)?.length).toBe(1);
});

it('sizes labels from the viewports captured with the views', ()=>{
  const left={projectionMatrix:[1.2,0,0,0,0,1.4]},right={projectionMatrix:[1.25,0,0,0,0,1.4]};
  const views=[left,right],viewports=[{width:1920,height:1824},{width:1920,height:1824}];
  const gain=componentLabelProjectionGain(views,(view:unknown)=>viewports[views.indexOf(view as typeof left)]??null);
  expect(gain).toBeCloseTo(1.4*1824/2,6);
  // A view whose viewport was not captured contributes nothing rather than throwing.
  expect(componentLabelProjectionGain(views,()=>null)).toBe(0);
});

it('writes caption text far enough in front of its plate to survive an oblique view', ()=>{
  // At 30-60 degrees off the plate the lower half of each caption line sank
  // behind the 86%-opaque plate with the old 4 mm lift.
  expect(CAPTION_TEXT_LIFT_METERS).toBeGreaterThanOrEqual(CAPTION_FONT_METERS/2*Math.sin(Math.PI/3));
});

it('lifts caption text toward the wearer, not behind the plate', async()=>{
  // The lift once ran away from the eyes, so every line was read through the
  // 86%-opaque plate and looked uniformly grey in the visionOS simulator.
  // Head rotation is yaw about +Y, then pitch about the turned X axis, then
  // roll about the view axis. A zero pose looks down -Z.
  const multiply=(a:number[][],b:number[][])=>a.map(row=>b[0].map((_,j)=>row.reduce((sum,value,k)=>sum+value*b[k][j],0)));
  const rotation=(yaw:number,pitch:number,roll:number)=>{
    const [cy,sy,cp,sp,cr,sr]=[Math.cos(yaw),Math.sin(yaw),Math.cos(pitch),Math.sin(pitch),Math.cos(roll),Math.sin(roll)];
    return multiply(multiply([[cy,0,sy],[0,1,0],[-sy,0,cy]],[[1,0,0],[0,cp,-sp],[0,sp,cp]]),[[cr,-sr,0],[sr,cr,0],[0,0,1]]);
  };
  const centre=[0.3,1.6,-0.2];
  // Level, turned, looking up, looking far down, rolled, all three at once,
  // and straight down, where the seat falls back to the head's right axis.
  for(const [yaw,pitch,roll] of [[0,0,0],[0.7,0,0],[-2.4,0,0],[0,0.6,0],[0.7,-1.2,0],[0,0,0.5],[-2.4,0.6,-0.5],[0.3,-Math.PI/2,0.2]]) {
    const r=rotation(yaw,pitch,roll);
    const matrix=[0,1,2].flatMap(column=>[r[0][column],r[1][column],r[2][column],0]).concat([...centre,1]);
    const seat=captionSeat({position:{x:centre[0],y:centre[1],z:centre[2]},matrix}),text=captionTextOrigin(seat);
    const pose=`yaw ${yaw}, pitch ${pitch}, roll ${roll}`;
    const distance=(eye:number[],point:number[])=>Math.hypot(...point.map((value,axis)=>eye[axis]-value));
    expect(distance(centre,seat.origin)-distance(centre,text),pose).toBeCloseTo(CAPTION_TEXT_LIFT_METERS,6);
    // Each eye sits 32 mm along the head's own right axis, roll included.
    for(const side of [-1,1]) {
      const eye=centre.map((value,axis)=>value+side*0.032*r[axis][0]);
      expect(distance(eye,text),pose).toBeLessThan(distance(eye,seat.origin));
    }
  }
  // `draw` writes its glyphs from this helper rather than a lift of its own.
  expect(await lab('talk-caption.mjs')).toMatch(/const origin = captionTextOrigin\(nextSeat\);/);
});

it('sends a geometry receipt the host accepts from every headset class, or none', ()=>{
  // A presenting scene with a style layer came back `reduced` against the
  // Vision Pro's Infinity budget. JSON sent budget and estimatedVertices as
  // null, and complete_inspection answered 409 three times in the simulator.
  const scene=[{representation:'cartoon',atoms:4400,bonds:5280,residues:801},
    {representation:'ball-and-stick',atoms:327,bonds:392,residues:46}];
  let receipts=0;
  for(const deviceClass of Object.keys(REPRESENTATION_BUDGETS)) {
    for(const decision of requireSceneGeometryBudget(scene,{presenting:true,deviceClass,quality:'high',standalone:false})) {
      const receipt=geometryBudgetReceipt(decision);
      if(deviceClass!=='quest2') { expect(decision.status,deviceClass).toBe('unchanged'); expect(receipt).toBeUndefined(); continue; }
      receipts++;
      expect(geometryBudgetReceiptSchema.safeParse(JSON.parse(JSON.stringify(receipt))).success).toBe(true);
    }
  }
  expect(receipts).toBe(scene.length);
});
