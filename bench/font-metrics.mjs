import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
GlobalFonts.registerFromPath('assets/fonts/NotoSansSC-Black.otf','NotoSC Black');
const c=createCanvas(600,200), g=c.getContext('2d');
const PFB='"NotoSC Black", "PingFang SC", "Hiragino Sans GB", sans-serif';
for (const w of [900,800,700]) {
  g.font = `${w} 44px ${PFB}`;
  const m = g.measureText('定稿再渲');
  console.log(w, 'measureText width', m.width, 'per char', m.width/4, 'actualBounding', m.actualBoundingBoxLeft, m.actualBoundingBoxRight);
}
g.font = `900 44px ${PFB}`;
g.fillStyle='#000'; g.fillText('定稿再渲', 20, 100);
const d=g.getImageData(0,0,600,200).data;
let x0=1e9,x1=-1; for(let y=0;y<200;y++)for(let x=0;x<600;x++){if(d[(y*600+x)*4+3]>40){if(x<x0)x0=x;if(x>x1)x1=x;}}
console.log('ink from x0',x0,'to',x1,'width',x1-x0+1);
