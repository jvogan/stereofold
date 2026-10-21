import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from '../../plugin/node_modules/typescript/lib/typescript.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { registerTetherCaption, updateTetherCaption, tetherCaption, placeTetherCaption } from './tether-caption.mjs';

function fixture(offsets = {}) {
  const repr = {renderObjects:[{values:{aMapping:{ref:{value:[-5,-.7,5,.7]}}}}]};
  registerTetherCaption(repr, {from:{position:[-10,10,-50]}, to:{position:[10,10,-50]}, centre:[0,0,-50], ...offsets});
  return {repr, caption:tetherCaption(repr)};
}

test('automatic captions clear horizontal, vertical, diagonal, reversed and end-on connectors outward', () => {
  const {repr,caption} = fixture(), camera = {view:Mat4.identity(),scale:1,state:{mode:'orthographic'}};
  for (const [from,to] of [ [[-10,10,-50],[10,10,-50]], [[10,-10,-50],[10,10,-50]],
    [[-10,0,-50],[10,20,-50]], [[10,20,-50],[-10,0,-50]], [[0,0,-40],[0,0,-60]], [[0,0,-50],[0,0,-50]] ]) {
    updateTetherCaption(repr,from,to,Mat4.identity());
    for (const unit of [1,6,28]) {
      assert.equal(placeTetherCaption(caption,camera,unit),caption);
      const dx=to[0]-from[0],dy=to[1]-from[1],length=Math.hypot(dx,dy);
      assert.ok(Math.abs(caption.x*dx+caption.y*dy)<1e-8,'perpendicular displacement');
      assert.ok(caption.x*(from[0]+to[0])/2+caption.y*(from[1]+to[1])/2>=-1e-8,'away from centre');
      const distance=length ? Math.abs(dx*caption.y-dy*caption.x)/length : Math.hypot(caption.x,caption.y);
      const support=(Math.abs(caption.nx)*caption.halfWidth+Math.abs(caption.ny)*caption.halfHeight)*unit;
      assert.ok(distance>=support+2*caption.halfHeight*unit,'entire plate plus measurement gap clears line');
    }
  }
});

test('moving midpoint, presentation transforms and camera rotation retain reusable caption storage', () => {
  const {repr,caption}=fixture(), camera={view:Mat4.identity(),scale:1,state:{mode:'perspective'}};
  const arrays=Object.values(caption).filter(Array.isArray), from=Vec3(),to=Vec3(),presentation=Mat4.identity();
  for(let i=0;i<1000;i++) {
    Vec3.set(from,-10+i*.01,10,-50);Vec3.set(to,10+i*.02,10,-50);
    updateTetherCaption(repr,from,to,presentation);placeTetherCaption(caption,camera,6);
    assert.ok(Math.abs((caption.from[0]+caption.to[0])/2-i*.015)<1e-10,'anchor follows pair midpoint');
    assert.ok(caption.y>caption.halfHeight*6);
    assert.deepEqual(Object.values(caption).filter(Array.isArray),arrays);
    Object.values(caption).filter(Array.isArray).forEach((array,j)=>assert.equal(array,arrays[j]));
  }
  const before=caption.y;
  Mat4.fromRotation(camera.view,Math.PI/2,[0,0,1]);placeTetherCaption(caption,camera,6);
  assert.ok(Math.abs(caption.x)>0 && Math.abs(caption.y)<1e-8,'camera changes update paused captions');
  assert.ok(before>0);
  Mat4.fromTranslation(presentation,[7,8,9]);updateTetherCaption(repr,from,to,presentation);
  assert.deepEqual(caption.centre,[7,8,-41]);
  assert.equal(fixture({offsetX:0}).caption.automatic,false);
  assert.equal(fixture({offsetY:20}).caption.automatic,false);
});

test('caption frame helpers allocate no vectors, arrays, objects or closures; uniform setter stays at module scope', () => {
  for (const [file,names] of [['tether-caption.mjs',['updateTetherCaption','project','placeTetherCaption']],
    ['immersive-annotations.mjs',['setUniform','sizeImmersiveAnnotation']]]) {
    const source=ts.createSourceFile(file,readFileSync(new URL(file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    for(const name of names) {
      const fn=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
      assert.ok(fn,`${name} declared at module scope`);
      const visit=node=>{
        assert.ok(!ts.isNewExpression(node)&&!ts.isArrayLiteralExpression(node)&&!ts.isObjectLiteralExpression(node)
          &&!ts.isArrowFunction(node)&&!ts.isFunctionExpression(node),`${name}: allocation ${node.getText(source)}`);
        if(ts.isCallExpression(node)) assert.ok(!/^(Vec3|Mat4)$|\.(clone|map|filter|slice)$/.test(node.expression.getText(source)),name);
        ts.forEachChild(node,visit);
      };
      visit(fn.body);
    }
  }
});
