import test from 'node:test';
import assert from 'node:assert/strict';
import {toolbarFrameRuntime,toolbarFrameHarness} from './fixtures/toolbar-frame-runtime.mjs';
const runtime=await toolbarFrameRuntime(new URL('./',import.meta.url));
const head={matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,1.6,0,1],position:{x:0,y:1.6,z:0}};
const relocated={...head,matrix:[.57,0,.82,0,0,1,0,0,-.82,0,.57,0,0,1.6,0,1]};
test('restart restores the entry head and anchor before chapter one framing measures the glass',async()=>{
  let move=false;
  const f=toolbarFrameHarness(runtime,{state:{voice:{state:'idle'}},beforeMenuDraw:async()=>move?{menuRelocation:{head:relocated,anchor:[-1,1.6,-.7],constants:runtime.SPATIAL_TOOLBAR_LAYOUT}}:undefined});
  try {
    await f.toolbar.update();
    const entryHead=f.toolbar.head(), entry=f.toolbar.placementPreview({headInRoom:head.matrix,restoreTourSeat:true});
    move=true; f.setState({voice:{state:'idle'},tour:{active:true,step:2,title:'Later',bodyPage:'Later'}}); await f.toolbar.update();
    assert.equal(f.toolbar.head(),relocated,'fixture moves the menu by 55 degrees');
    move=false;
    await f.toolbar.update({restoreTourSeat:true,restartTourSeat:true});
    assert.equal(f.toolbar.head(),entryHead,'restart returns to entry forward');
    const restarted=f.toolbar.placementPreview({headInRoom:head.matrix,restoreTourSeat:true});
    assert.deepEqual(restarted.menuPoints(),entry.menuPoints(),'chapter one frames against its entry glass');
  }finally{await f.toolbar.dispose();}
});

test('restart keeps the incoming chapter readout instead of drawing Done during entry framing', async()=>{
  let lines=[];
  const f=toolbarFrameHarness(runtime,{state:{voice:{state:'idle'}},presentation:{add:repr=>{
    if(repr.shape?.name==='Stereofold toolbar readout') lines=repr.shape.geometry.lines;
  }}});
  try{
    await f.toolbar.update();
    f.setState({voice:{state:'idle'},tour:{active:true,step:2,selectedId:'lesson',title:'Later',bodyPage:'Later',
      chapterPreview:{title:'Entry',progress:'Scene 1 / 3',bodyPage:'Opening words'}}});
    await f.toolbar.update({restoreTourSeat:true,restartTourSeat:true});
    assert.ok(lines.join('').includes('Openingwords'),JSON.stringify(lines));
  }finally{await f.toolbar.dispose();}
});
