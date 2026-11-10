import { edgeMap, grayscale } from "./image-processor";
import type { MatchCandidate, MatchMethod } from "./types";

declare const cv: any;

export class TemplateMatcher {
  static isOpenCvReady() { return typeof cv !== "undefined" && typeof cv.Mat === "function"; }
  static async match(template: HTMLCanvasElement, target: HTMLCanvasElement, method: MatchMethod, threshold: number) {
    const start = performance.now();
    if (this.isOpenCvReady()) try { return { matches: this.openCv(template, target, method, threshold), timeMs: performance.now() - start }; } catch (error) { console.warn("OpenCV failed; using the Lab NCC fallback", error); }
    return { matches: this.pureJs(template, target, method, threshold), timeMs: performance.now() - start };
  }
  private static openCv(template: HTMLCanvasElement, target: HTMLCanvasElement, method: MatchMethod, threshold: number) {
    const src = cv.imread(target), tpl = cv.imread(template); let a: any, b: any;
    if (method === "grayscale") { a=new cv.Mat(); b=new cv.Mat(); cv.cvtColor(src,a,cv.COLOR_RGBA2GRAY); cv.cvtColor(tpl,b,cv.COLOR_RGBA2GRAY); }
    else if (method === "edge") { const ag=new cv.Mat(), bg=new cv.Mat(); a=new cv.Mat(); b=new cv.Mat(); cv.cvtColor(src,ag,cv.COLOR_RGBA2GRAY); cv.cvtColor(tpl,bg,cv.COLOR_RGBA2GRAY); cv.Canny(ag,a,50,150); cv.Canny(bg,b,50,150); ag.delete(); bg.delete(); }
    else { a=src.clone(); b=tpl.clone(); }
    const rows=target.height-template.height+1, cols=target.width-template.width+1, result=new cv.Mat(), raw: Array<{x:number;y:number;score:number}>=[];
    if (rows > 0 && cols > 0) { cv.matchTemplate(a,b,result,cv.TM_CCOEFF_NORMED); for(let y=0;y<rows;y++) for(let x=0;x<cols;x++){const score=result.floatAt(y,x); if(score>=threshold) raw.push({x,y,score});} }
    src.delete(); tpl.delete(); a.delete(); b.delete(); result.delete(); raw.sort((x,y)=>y.score-x.score);
    return this.nms(raw,template.width,template.height,method);
  }
  private static pureJs(template: HTMLCanvasElement, target: HTMLCanvasElement, method: MatchMethod, threshold: number) {
    const tc=template.getContext("2d",{willReadFrequently:true})!, sc=target.getContext("2d",{willReadFrequently:true})!;
    const ti=tc.getImageData(0,0,template.width,template.height), si=sc.getImageData(0,0,target.width,target.height);
    const t=method==="edge"?edgeMap(ti):grayscale(ti), s=method==="edge"?edgeMap(si):grayscale(si), tw=template.width, th=template.height, sw=target.width, sh=target.height, count=tw*th;
    let tsum=0; for(let i=0;i<t.data.length;i+=4) tsum+=t.data[i]!; const tm=tsum/count; let tv=0; for(let i=0;i<t.data.length;i+=4) tv+=(t.data[i]!-tm)**2; const ts=Math.sqrt(tv)||1;
    const raw: Array<{x:number;y:number;score:number}>=[];
    for(let sy=0;sy<=sh-th;sy++) for(let sx=0;sx<=sw-tw;sx++){let sum=0; for(let y=0;y<th;y++) for(let x=0;x<tw;x++) sum+=s.data[((sy+y)*sw+sx+x)*4]!; const sm=sum/count; let num=0,sv=0; for(let y=0;y<th;y++) for(let x=0;x<tw;x++){const td=t.data[(y*tw+x)*4]!-tm,sd=s.data[((sy+y)*sw+sx+x)*4]!-sm;num+=td*sd;sv+=sd*sd;} const score=num/(ts*(Math.sqrt(sv)||1)); if(score>=threshold)raw.push({x:sx,y:sy,score});}
    raw.sort((a,b)=>b.score-a.score); return this.nms(raw,tw,th,method);
  }
  private static nms(raw:Array<{x:number;y:number;score:number}>,width:number,height:number,method:MatchMethod){const kept:MatchCandidate[]=[];for(const cur of raw){let overlaps=false;for(const item of kept){const iw=Math.max(0,Math.min(cur.x+width,item.bbox.x+width)-Math.max(cur.x,item.bbox.x)),ih=Math.max(0,Math.min(cur.y+height,item.bbox.y+height)-Math.max(cur.y,item.bbox.y));if((iw*ih)/(2*width*height-iw*ih)>.35){overlaps=true;break;}}if(!overlaps)kept.push({id:`match_${kept.length+1}`,bbox:{x:cur.x,y:cur.y,width,height},score:Math.round(cur.score*1000)/1000,method,isBest:kept.length===0});if(kept.length>=20)break;}return kept;}
}
