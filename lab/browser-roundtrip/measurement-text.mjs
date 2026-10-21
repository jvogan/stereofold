import { TextBuilder } from 'molstar/lib/mol-geo/geometry/text/text-builder.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';

/** Preallocate the numeric plate once. Moving distances only copy glyph quads
 * from the same font atlas into existing buffers, including digit-count changes.
 * No shape/geometry recreation or async work in the pose loop.
 */
export function measurementText(props) {
  const glyphs=new Map();
  for(const char of '0123456789. Åe+-') {
    const builder=TextBuilder.create(props,4,4);
    builder.add(char,0,0,0,0,1,0);
    const text=builder.getText(),mapping=text.mappingBuffer.ref.value;
    // At backgroundMargin=.25 Mol* adds .2 mapping units on each side.
    glyphs.set(char,{mapping:mapping.slice(8,16),uv:text.tcoordBuffer.ref.value.slice(8,16),
      width:mapping[4]-mapping[0]-.4, background:mapping.slice(0,8)});
  }
  const capacity=32,builder=TextBuilder.create(props,capacity+1,4);
  builder.add('0'.repeat(capacity),0,0,0,0,1,0);
  const geometry=builder.getText();
  let current='',halfWidth=0,halfHeight=0;
  return {geometry,get halfWidth(){return halfWidth;},get halfHeight(){return halfHeight;},
    update(value) {
      if(value===current) return false;
      if(value.length>capacity) throw Error('Distance text exceeds numeric plate capacity.');
      const mapping=geometry.mappingBuffer.ref.value,uv=geometry.tcoordBuffer.ref.value;
      let width=0;for(let i=0;i<value.length;i++) width+=glyphs.get(value[i]).width;
      const bg=glyphs.get('0').background;
      mapping.fill(0);uv.fill(0);
      for(let i=0;i<8;i+=2) {mapping[i]=(i<4?-1:1)*(width/2+.2);mapping[i+1]=bg[i+1];uv[i]=10;uv[i+1]=10;}
      let x=-width/2;
      for(let n=0;n<value.length;n++) {
        const g=glyphs.get(value[n]),offset=(n+1)*8;
        for(let i=0;i<8;i+=2) {mapping[offset+i]=g.mapping[i]+x+g.width/2;mapping[offset+i+1]=g.mapping[i+1];}
        uv.set(g.uv,offset);x+=g.width;
      }
      halfWidth=width/2+.2;halfHeight=Math.max(Math.abs(bg[1]),Math.abs(bg[3]),Math.abs(bg[5]),Math.abs(bg[7]));
      ValueCell.update(geometry.mappingBuffer,mapping);ValueCell.update(geometry.tcoordBuffer,uv);
      current=value;return true;
    }};
}
