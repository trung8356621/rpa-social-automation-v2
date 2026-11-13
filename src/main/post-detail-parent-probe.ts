import type { PostDetailParentProbeInput } from "../shared/post-detail-collector/types.js";

export function orderProgressiveCandidates<T extends { parentLevel: number; descendantCount: number }>(items: T[], expected: number | null): { items: T[]; mode: "EXACT" | "EXPANDED_PLUS_MINUS_ONE" | "FULL_PROGRESSIVE" } {
  const out = [...items];
  if (expected !== null && out.some((x) => x.parentLevel === expected)) {
    out.sort((a, b) => Number(b.parentLevel === expected) - Number(a.parentLevel === expected) || b.descendantCount - a.descendantCount);
    return { items: out, mode: "EXACT" };
  }
  if (expected !== null && out.some((x) => Math.abs(x.parentLevel - expected) === 1)) {
    out.sort((a, b) => Number(Math.abs(b.parentLevel - expected) === 1) - Number(Math.abs(a.parentLevel - expected) === 1) || b.descendantCount - a.descendantCount);
    return { items: out, mode: "EXPANDED_PLUS_MINUS_ONE" };
  }
  out.sort((a, b) => b.descendantCount - a.descendantCount);
  return { items: out, mode: "FULL_PROGRESSIVE" };
}

export function buildPostDetailActionAnchorProbeJs(input: PostDetailParentProbeInput): string {
  const data = JSON.stringify(input).replace(/</g, "\\u003c");
  return `(() => {
    const input=${data}, sx=innerWidth/input.screenshot.width, sy=innerHeight/input.screenshot.height;
    const old=window.__rpaPdcActionProbe;if(old?.dispose)old.dispose();
    const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
    const pick=(a)=>{const point={x:(a.bbox.x+a.bbox.width/2)*sx,y:(a.bbox.y+a.bbox.height/2)*sy}, stack=document.elementsFromPoint(point.x,point.y).filter(el=>!el.closest('[data-rpa-pdc-debug]'));
      const scored=stack.map((el,i)=>{const r=el.getBoundingClientRect(),role=el.getAttribute('role'),interactive=el.matches('a,button,[role=button]')||el.querySelector('svg');const size=Math.abs(r.width-a.bbox.width*sx)+Math.abs(r.height-a.bbox.height*sy);return{el,r,score:(interactive?60:0)-size-i*2}}).filter(x=>x.r.width>=4&&x.r.height>=4&&x.r.width<=180&&x.r.height<=100).sort((a,b)=>b.score-a.score);return{type:a.type,point,node:scored[0]?.el||null,stack:stack.slice(0,8).map(el=>({tag:el.tagName,role:el.getAttribute('role'),rect:rect(el),text:String(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,80)}))}};
    const hits=input.anchors.map(pick);if(hits.length<3||hits.some(h=>!h.node))return{status:'STALE_VISUAL_ANCHOR',hits:hits.map(h=>({type:h.type,point:h.point,tag:h.node?.tagName||null,role:h.node?.getAttribute('role')||null,rect:h.node?rect(h.node):null,text:String(h.node?.getAttribute('aria-label')||h.node?.textContent||'').trim().slice(0,100)})),actionRow:null,diagnostics:['One or more screenshot points did not resolve to a geometric DOM node.']};
    const chains=hits.map(h=>{const out=[];let n=h.node;while(n instanceof Element){out.push(n);n=n.parentElement}return out}), common=chains[0].filter(el=>chains.slice(1).every(c=>c.includes(el)));
    const xs=hits.map(h=>h.point.x),span=Math.max(...xs)-Math.min(...xs);const row=common.find(el=>{const r=el.getBoundingClientRect();return r.width>=span&&r.height>=18&&r.height<=140&&r.width<=innerWidth})||null;
    if(!row)return{status:'AMBIGUOUS',hits:hits.map(h=>({type:h.type,point:h.point,tag:h.node.tagName,role:h.node.getAttribute('role'),rect:rect(h.node),text:String(h.node.getAttribute('aria-label')||h.node.textContent||'').trim().slice(0,100)})),actionRow:null,diagnostics:['Three DOM hits have no safe compact common row ancestor.']};
    const colors={LIKE:'#3b82f6',COMMENT:'#f59e0b',SHARE:'#a855f7'},overlays=[];const add=(node,color,width)=>{const o=document.createElement('div');o.dataset.rpaPdcDebug='1';o.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border-style:solid;border-radius:5px;background:transparent;';o.style.borderColor=color;o.style.borderWidth=width+'px';document.documentElement.appendChild(o);overlays.push({o,node})};hits.forEach(h=>add(h.node,colors[h.type],3));add(row,'#06b6d4',2);let raf=0;const paint=()=>{overlays.forEach(({o,node})=>{const r=node.getBoundingClientRect();Object.assign(o.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',display:r.width&&r.height?'block':'none'})});raf=requestAnimationFrame(paint)};window.__rpaPdcActionProbe={row,hits:hits.map(h=>h.node),dispose:()=>{cancelAnimationFrame(raf);overlays.forEach(x=>x.o.remove());delete window.__rpaPdcActionProbe}};paint();
    return{status:'FOUND',hits:hits.map(h=>({type:h.type,point:h.point,tag:h.node.tagName,role:h.node.getAttribute('role'),rect:rect(h.node),text:String(h.node.getAttribute('aria-label')||h.node.textContent||'').trim().slice(0,100)})),actionRow:{tag:row.tagName,role:row.getAttribute('role'),rect:rect(row),descendantCount:row.querySelectorAll('*').length},diagnostics:[]};
  })()`;
}

export function buildPostDetailParentProbeJs(input: PostDetailParentProbeInput): string {
  const data = JSON.stringify(input).replace(/</g, "\\u003c");
  return `(() => {
    const input=${data}, clean=v=>String(v||'').replace(/\\s+/g,' ').trim();
    const box=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
    const identity=(raw,base=location.href)=>{try{const u=new URL(raw,base),p=u.pathname;
      let m=/^\\/@[^/]+\\/post\\/([^/?#]+)/i.exec(p);if(m)return{id:m[1],platform:'threads',reason:'threads-post-path'};
      m=/(?:\\/posts\\/|\\/permalink\\/)([0-9A-Za-z_-]+)/i.exec(p);if(m)return{id:m[1],platform:'facebook',reason:/permalink/i.test(m[0])?'facebook-permalink-path':'facebook-posts-path'};
      for(const k of ['multi_permalinks','story_fbid']){const v=u.searchParams.get(k);if(v)return{id:v,platform:'facebook',reason:'query-'+k}}
      const set=u.searchParams.get('set'),media=set&&/^(?:gm|pcb)\\.([0-9A-Za-z_-]+)/i.exec(set);if(media)return{id:media[1],platform:'facebook',reason:'facebook-media-set'};
      const f=u.searchParams.get('fbid');return f?{id:f,platform:'facebook',reason:'query-fbid'}:null}catch{return null}};
    const target=identity(location.href)||identity(input.sourceUrl);if(!target)return{status:'URL_NOT_FOUND',currentUrl:location.href,postId:null,actionRow:null,actionRowHtml:'',actionRowSignature:null,urlCandidates:[],levels:[],candidates:[],selectedIndex:null,stopReason:'NO_POST_ID',boundaryLevel:null,diagnostics:['No supported post identity.']};
    const classify=el=>{const t=clean(el.getAttribute('aria-label'))+' '+clean(el.getAttribute('title'))+' '+clean(el.textContent);return /like|thích|bày tỏ/i.test(t)?'LIKE':/comment|bình luận/i.test(t)?'COMMENT':/share|chia sẻ/i.test(t)?'SHARE':null};
    const sx=innerWidth/input.screenshot.width,sy=innerHeight/input.screenshot.height;
    const hits=input.anchors.map(a=>{const x=(a.bbox.x+a.bbox.width/2)*sx,y=(a.bbox.y+a.bbox.height/2)*sy;const stack=document.elementsFromPoint(x,y).filter(el=>!el.closest('[data-rpa-pdc-debug]'));return stack.map((el,i)=>{const r=el.getBoundingClientRect(),interactive=el.matches('a,button,[role=button]')||el.querySelector('svg');return{el,r,score:(interactive?60:0)-Math.abs(r.width-a.bbox.width*sx)-Math.abs(r.height-a.bbox.height*sy)-i*2}}).filter(v=>v.r.width>=4&&v.r.height>=4&&v.r.width<=180&&v.r.height<=100).sort((a,b)=>b.score-a.score)[0]?.el||null});
    if(hits.length<3||hits.some(x=>!x))return{status:'STALE_VISUAL_ANCHOR',currentUrl:location.href,postId:target.id,actionRow:null,actionRowHtml:'',actionRowSignature:null,urlCandidates:[],levels:[],candidates:[],selectedIndex:null,stopReason:'STALE_VISUAL_ANCHOR',boundaryLevel:null,diagnostics:['Confirmed screenshot anchors do not resolve to the live DOM.']};
    const chains=hits.map(hit=>{const out=[];let n=hit;while(n instanceof Element){out.push(n);n=n.parentElement}return out});
    const common=chains[0].filter(el=>chains.slice(1).every(c=>c.includes(el)));
    const row=window.__rpaPdcActionProbe?.row||common.find(el=>{const r=el.getBoundingClientRect();return r.width>=140&&r.height>=20&&r.height<=180})||common[0];
    const signatureOf=el=>{const controls=Array.from(el.querySelectorAll('button,[role=button],a')).map(x=>({type:classify(x),role:x.getAttribute('role')||x.tagName.toLowerCase(),svg:x.querySelectorAll('svg').length,title:clean(x.querySelector('svg title')?.textContent)})).filter(x=>x.type);const ordered=[];for(const c of controls)if(!ordered.includes(c.type))ordered.push(c.type);return{order:ordered,roles:controls.map(x=>x.role),svgCount:controls.reduce((n,x)=>n+x.svg,0),buttonCount:el.querySelectorAll('button,[role=button]').length}};
    const signature=signatureOf(row);
    const similarRoots=scope=>{const controls=Array.from(scope.querySelectorAll('button,[role=button],a')).filter(classify),roots=[];for(const start of controls.filter(x=>classify(x)==='LIKE')){let n=start;for(let i=0;i<7&&n&&n!==scope.parentElement;i++,n=n.parentElement){const types=new Set(Array.from(n.querySelectorAll('button,[role=button],a')).map(classify).filter(Boolean));if(types.has('LIKE')&&types.has('COMMENT')&&types.has('SHARE')){const s=signatureOf(n);if(s.order.join('|')===signature.order.join('|'))roots.push(n);break}}}return roots.filter((n,i,a)=>a.indexOf(n)===i&&!a.some((other,j)=>j!==i&&n.contains(other)))};
    const urlMatches=scope=>Array.from(scope.querySelectorAll('a[href]')).map(a=>{const id=identity(a.href);let reason=id&&id.id===target.id?id.reason:null;if(!reason&&a.href.includes(target.id))reason=new URL(a.href,location.href).searchParams.has('comment_id')?'related-comment-link':'related-id-token';return reason?{href:a.href,reason}:null}).filter(Boolean);
    const fingerprint=el=>[el.tagName,el.getAttribute('role')||'',el.children.length,el.querySelectorAll(':scope > *').length].join(':');
    const levels=[],valid=[];let node=row,level=0,boundaryLevel=null,stopReason='NO_SECOND_ACTION_ROW';
    while(node instanceof Element&&node!==document.body&&node!==document.documentElement){const urls=urlMatches(node),rows=similarRoots(node),desc=node.querySelectorAll('*').length,htmlSize=node.outerHTML.length;const item={parentLevel:level,descendantCount:desc,urlMatchCount:urls.length,similarRowCount:rows.length,rect:box(node),htmlSize,fingerprint:fingerprint(node),tag:node.tagName,role:node.getAttribute('role'),status:rows.length>1?'BOUNDARY_CROSSED':urls.length&&rows.length===1?'CANDIDATE':'SCANNED',urlCandidates:urls};levels.push(item);if(rows.length>1){boundaryLevel=level;stopReason='SECOND_ACTION_ROW_FOUND';break}if(urls.length&&rows.length===1)valid.push({...item,node});node=node.parentElement;level++}
    const expected=Number.isInteger(input.expectedParentLevel)?input.expectedParentLevel:null, exact=expected===null?[]:valid.filter(x=>x.parentLevel===expected),near=expected===null?[]:valid.filter(x=>Math.abs(x.parentLevel-expected)===1);let calibrationMode='FULL_PROGRESSIVE';
    if(exact.length){calibrationMode='EXACT';valid.sort((a,b)=>(b.parentLevel===expected?1:0)-(a.parentLevel===expected?1:0)||b.descendantCount-a.descendantCount)}else if(near.length){calibrationMode='EXPANDED_PLUS_MINUS_ONE';valid.sort((a,b)=>{const ac=Math.abs(a.parentLevel-expected)===1?1:0,bc=Math.abs(b.parentLevel-expected)===1?1:0;return bc-ac||b.descendantCount-a.descendantCount})}else valid.sort((a,b)=>b.descendantCount-a.descendantCount);
    const old=window.__rpaPdcParentProbe;if(old?.dispose)old.dispose();const overlays=valid.map(()=>{const o=document.createElement('div');o.style.cssText='position:fixed;pointer-events:none;z-index:2147483646;border:3px solid #ff9f1c;border-radius:6px;box-sizing:border-box;background:transparent;';document.documentElement.appendChild(o);return o});let selected=0,confirmed=false,raf=0;
    const paint=()=>{valid.forEach((c,i)=>{const r=c.node.getBoundingClientRect(),o=overlays[i];Object.assign(o.style,{left:r.left+'px',top:r.top+'px',width:Math.max(0,r.width)+'px',height:Math.max(0,r.height)+'px',borderColor:i===selected?'#22c55e':'#ff9f1c',borderWidth:i===selected&&confirmed?'5px':i===selected?'3px':'2px',display:r.width&&r.height?'block':'none'})});raf=requestAnimationFrame(paint)};
    window.__rpaPdcParentProbe={select:i=>{selected=Math.max(0,Math.min(valid.length-1,i));confirmed=false;return selected},confirm:i=>{selected=Math.max(0,Math.min(valid.length-1,i));confirmed=true;return selected},dispose:()=>{cancelAnimationFrame(raf);overlays.forEach(o=>o.remove());delete window.__rpaPdcParentProbe}};paint();
    const candidates=valid.map(({node,...x},index)=>({...x,index}));return{status:candidates.length?'FOUND':'AMBIGUOUS',currentUrl:location.href,postId:target.id,platform:target.platform,actionRow:{tag:row.tagName,rect:box(row)},actionRowHtml:row.outerHTML,actionRowSignature:signature,urlCandidates:urlMatches(document),levels,candidates,selectedIndex:candidates.length?0:null,stopReason,boundaryLevel,expectedParentLevel:expected,calibrationMode,diagnostics:expected!==null&&calibrationMode==='FULL_PROGRESSIVE'?['Exact and ±1 calibration levels were invalid; fell back to full progressive candidates.']:[]};
  })()`;
}

export function buildPostDetailParentSelectJs(index: number, confirm: boolean): string { const i=Math.max(0,Math.floor(index)); return `(()=>{const p=window.__rpaPdcParentProbe;if(!p)return{ok:false,reason:'NO_ACTIVE_PARENT_PROBE'};return{ok:true,selectedIndex:p.${confirm?"confirm":"select"}(${i}),confirmed:${confirm}}})()`; }
export const CLEAR_POST_DETAIL_PARENT_HIGHLIGHT_JS=`(()=>{window.__rpaPdcParentProbe?.dispose?.();window.__rpaPdcActionProbe?.dispose?.();return{ok:true}})()`;
