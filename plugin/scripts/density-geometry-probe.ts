/** Test-only readback of the texture vertices used by Mol*'s isosurface shader. */
export function readDensityGeometryObjects(objects: any[], gl: any, bindFramebuffer: (target: number, framebuffer: any) => void) {
  if (!gl || typeof bindFramebuffer !== 'function') throw Error('Density readback requires the active XR rendering context.');
  const cell = (object: any, key: string) => object?.values?.[key]?.ref?.value;
  const visible = objects.filter(object => object.state?.visible !== false && !object.state?.disposed
    && (cell(object,'alpha') ?? 1) * (object.state?.alphaFactor ?? 1) > 0 && cell(object,'drawCount') > 0);
  if (!visible.length) throw Error('No visible density draw objects.');
  return visible.map(object => {
    if (object.type !== 'texture-mesh' || cell(object,'dGeometryType') !== 'textureMesh')
      throw Error('Density acceptance requires the committed GPU isosurface texture mesh.');
    if (cell(object,'dTransparency')) throw Error('Density readback cannot claim lit bounds for a transparency mask.');
    const count=cell(object,'drawCount'), live=cell(object,'uVertexCount'), texture=cell(object,'tPosition');
    const [width,height]=cell(object,'uGeoTexDim') ?? [];
    if (!Number.isSafeInteger(count) || count <= 0 || count % 3 || count !== live
      || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || width*height > 4_194_304 || count > width*height || !texture?.attachFramebuffer)
      throw Error('Invalid live density texture dimensions or triangle count.');
    const webgl2=typeof gl.readBuffer==='function';
    const previousRead=gl.getParameter(webgl2?gl.READ_FRAMEBUFFER_BINDING:gl.FRAMEBUFFER_BINDING);
    const previousDraw=webgl2?gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING):previousRead;
    const packKeys=[gl.PACK_ALIGNMENT,...(webgl2?[gl.PACK_ROW_LENGTH,gl.PACK_SKIP_ROWS,gl.PACK_SKIP_PIXELS]:[])];
    const packValues=packKeys.map(key=>gl.getParameter(key));
    const packBuffer=webgl2?gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING):null;
    const framebuffer=gl.createFramebuffer();
    if (!framebuffer) throw Error('Could not allocate density readback framebuffer.');
    const rgba=new Float32Array(width*height*4);
    try {
      texture.attachFramebuffer({bind:()=>bindFramebuffer(gl.FRAMEBUFFER,framebuffer)},0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw Error('Density readback framebuffer is incomplete.');
      if (webgl2) gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);
      packKeys.forEach((key,index)=>gl.pixelStorei(key,index===0?1:0));
      gl.readPixels(0,0,width,height,gl.RGBA,gl.FLOAT,rgba);
      if (gl.getError()!==gl.NO_ERROR) throw Error('Density vertex texture readback failed.');
    } finally {
      if (webgl2) gl.bindBuffer(gl.PIXEL_PACK_BUFFER,packBuffer);
      packKeys.forEach((key,index)=>gl.pixelStorei(key,packValues[index]));
      if (webgl2) {
        bindFramebuffer(gl.READ_FRAMEBUFFER,previousRead);
        bindFramebuffer(gl.DRAW_FRAMEBUFFER,previousDraw);
      } else bindFramebuffer(gl.FRAMEBUFFER,previousRead);
      gl.deleteFramebuffer(framebuffer);
    }
    const positions=new Float32Array(count*3);
    for (let vertex=0;vertex<count;vertex++) for (let axis=0;axis<3;axis++) {
      const coordinate=rgba[vertex*4+axis];
      if (!Number.isFinite(coordinate)) throw Error('Non-finite live density vertex.');
      positions[vertex*3+axis]=coordinate;
    }
    // Preserve the committed instance transforms and visibility. Only the
    // position storage changes for the shared production projection reader.
    return {...object,type:'mesh',values:{...object.values,aPosition:{ref:{value:positions}}}};
  });
}
