import test from 'node:test';
import assert from 'node:assert/strict';
import { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { TextBuilder } from 'molstar/lib/mol-geo/geometry/text/text-builder.js';
import { measurementText } from './measurement-text.mjs';
test('preallocated numeric glyphs match Mol* text across digit and decimal changes',()=>{
  setCanvasModule({createCanvas:()=>({getContext:()=>({measureText(s){return {width:s==='1'?24:40};},clearRect(){},fillText(){},
    getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(255)})})})});
  const props={background:true,backgroundMargin:.25,fontQuality:3,tether:false};
  const text=measurementText(props),g=text.geometry,mapping=g.mappingBuffer.ref.value,uv=g.tcoordBuffer.ref.value;
  for(const value of ['0.0 Å','9.9 Å','10.0 Å','81.5 Å','111.1 Å','1e+21 Å','3.2 Å']) {
    assert.equal(text.update(value),true);
    const b=TextBuilder.create(props);b.add(value,0,0,0,0,1,0);const expected=b.getText();
    for(const [actual,want] of [[mapping,expected.mappingBuffer.ref.value],[uv,expected.tcoordBuffer.ref.value]])
      for(let i=0;i<expected.charCount*8;i++) assert.ok(Math.abs(actual[i]-want[i])<1e-5,`${value} at ${i}: ${actual[i]} != ${want[i]}`);
    assert.equal(g.mappingBuffer.ref.value,mapping);assert.equal(g.tcoordBuffer.ref.value,uv);
    assert.ok(mapping.slice((value.length+1)*8).every(v=>v===0),'unused glyphs collapsed');
    assert.equal(text.update(value),false);
  }
});
