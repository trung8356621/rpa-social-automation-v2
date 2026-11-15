import type {
  PostDetailParentConfig,
  PostDetailParentProbeInput,
} from "../shared/post-detail-collector/types.js";
import type { Rect } from "../shared/contracts.js";

export function mapScreenshotAnchorToViewport(
  bbox: Rect,
  screenshot: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number; scaleX: number; scaleY: number } {
  if (screenshot.width <= 0 || screenshot.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    throw new Error("INVALID_SCREENSHOT_VIEWPORT_GEOMETRY");
  }
  const scaleX = viewport.width / screenshot.width;
  const scaleY = viewport.height / screenshot.height;
  return {
    x: (bbox.x + bbox.width / 2) * scaleX,
    y: (bbox.y + bbox.height / 2) * scaleY,
    scaleX,
    scaleY,
  };
}

export function classifyDualXPathResolution<T>(
  absoluteNodes: T[],
  relativeNodes: T[],
  evidence: {
    postIdentityVerified: boolean;
    actionRowVerified: boolean;
    parentVerified: boolean;
  },
):
  | "MATCHED"
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "INVALID"
  | "CONFLICT"
  | "REMATCH_REQUIRED" {
  const absolute = Array.from(new Set(absoluteNodes));
  const relative = Array.from(new Set(relativeNodes));
  if (absolute.length > 1 || relative.length > 1) return "AMBIGUOUS";
  if (!absolute.length && !relative.length) return "NOT_FOUND";
  if (absolute.length && relative.length && absolute[0] !== relative[0])
    return "CONFLICT";
  if (!evidence.actionRowVerified) return "INVALID";
  if (!evidence.postIdentityVerified || !evidence.parentVerified)
    return "REMATCH_REQUIRED";
  return "MATCHED";
}

export type ActionControlDescriptor = {
  ariaLabel?: string;
  title?: string;
  alt?: string;
  directText?: string;
};
export function classifyActionControlDescriptor(
  value: ActionControlDescriptor,
): "LIKE" | "COMMENT" | "SHARE" | null {
  const own = [value.ariaLabel, value.title, value.alt, value.directText]
    .filter(Boolean)
    .join(" ");
  if (/\b(?:like|thích|bày tỏ)\b/i.test(own)) return "LIKE";
  if (/\b(?:comment|bình luận)\b/i.test(own)) return "COMMENT";
  if (/\b(?:share|chia sẻ)\b/i.test(own)) return "SHARE";
  return null;
}

export type ActionRowStructuralSignature = {
  tag: string;
  role: string;
  childCount: number;
  svgCount: number;
  buttonCount: number;
  anchorCount: number;
  directPattern: string;
  controlOrder?: string;
};
export function structuralActionRowsMatch(
  a: ActionRowStructuralSignature,
  b: ActionRowStructuralSignature,
): boolean {
  return (
    a.tag === b.tag &&
    a.role === b.role &&
    Math.abs(a.childCount - b.childCount) <= 1 &&
    Math.abs(a.svgCount - b.svgCount) <= 1 &&
    Math.abs(a.buttonCount - b.buttonCount) <= 1 &&
    Math.abs(a.anchorCount - b.anchorCount) <= 1 &&
    a.directPattern === b.directPattern
  );
}

export function dedupeNestedActionRows<T>(
  original: T,
  candidates: T[],
  contains: (outer: T, inner: T) => boolean,
): T[] {
  const independent = candidates.filter(
    (item) =>
      item !== original &&
      !contains(original, item) &&
      !contains(item, original),
  );
  const unique = independent.filter(
    (item, index) => independent.indexOf(item) === index,
  );
  return [
    original,
    ...unique.filter(
      (item, index) =>
        !unique.some(
          (other, otherIndex) => otherIndex !== index && contains(item, other),
        ),
    ),
  ];
}

export function orderProgressiveCandidates<
  T extends { parentLevel: number; descendantCount: number },
>(
  items: T[],
  expected: number | null,
): {
  items: T[];
  mode: "EXACT" | "EXPANDED_PLUS_MINUS_ONE" | "FULL_PROGRESSIVE";
} {
  const out = [...items];
  if (expected !== null && out.some((x) => x.parentLevel === expected)) {
    out.sort(
      (a, b) =>
        Number(b.parentLevel === expected) -
          Number(a.parentLevel === expected) ||
        b.descendantCount - a.descendantCount,
    );
    return { items: out, mode: "EXACT" };
  }
  if (
    expected !== null &&
    out.some((x) => Math.abs(x.parentLevel - expected) === 1)
  ) {
    out.sort(
      (a, b) =>
        Number(Math.abs(b.parentLevel - expected) === 1) -
          Number(Math.abs(a.parentLevel - expected) === 1) ||
        b.descendantCount - a.descendantCount,
    );
    return { items: out, mode: "EXPANDED_PLUS_MINUS_ONE" };
  }
  out.sort((a, b) => b.descendantCount - a.descendantCount);
  return { items: out, mode: "FULL_PROGRESSIVE" };
}

export function buildPostDetailActionAnchorProbeJs(
  input: PostDetailParentProbeInput,
): string {
  const data = JSON.stringify(input).replace(/</g, "\\u003c");
  return `(() => {
    const input=${data}, sx=innerWidth/input.screenshot.width, sy=innerHeight/input.screenshot.height,clean=v=>String(v||'').replace(/\s+/g,' ').trim();
    const old=window.__rpaPdcActionProbe;if(old?.dispose)old.dispose();
    const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
    const identity=(raw,base=location.href)=>{try{const u=new URL(raw,base),p=u.pathname,m=/(?:\\/posts\\/|\\/permalink\\/)([0-9A-Za-z_-]+)/i.exec(p)||/^\\/@[^/]+\\/post\\/([^/?#]+)/i.exec(p);if(m)return{id:m[1]};for(const k of ['multi_permalinks','story_fbid']){const v=u.searchParams.get(k);if(v)return{id:v}}return null}catch{return null}};
    const directText=el=>Array.from(el.childNodes).filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent||'').join(' '),semantic=(el)=>{const icon=el.querySelector(':scope > svg title,:scope > img[alt]'),text=clean([el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('alt'),icon?.textContent,icon?.getAttribute?.('alt'),directText(el)].join(' '));return /\b(?:like|thích|bày tỏ)\b/i.test(text)?'LIKE':/\b(?:comment|bình luận)\b/i.test(text)?'COMMENT':/\b(?:share|chia sẻ)\b/i.test(text)?'SHARE':null};
    let liveScroll=null,scrollSynchronized=false;if(input.evidenceScroll){const expected=input.evidenceScroll,candidates=Array.from(document.querySelectorAll('*')).filter(el=>el.tagName===expected.tag&&el.getAttribute('role')===expected.role&&el.scrollHeight>el.clientHeight+1),target=candidates.sort((a,b)=>Math.abs((a.scrollHeight-a.clientHeight)-expected.maxScroll)-Math.abs((b.scrollHeight-b.clientHeight)-expected.maxScroll))[0];if(target){const before=target.scrollTop;if(Math.abs(before-expected.scrollTop)>2)target.scrollTop=Math.max(0,Math.min(target.scrollHeight-target.clientHeight,expected.scrollTop));liveScroll={tag:target.tagName,role:target.getAttribute('role'),before,after:target.scrollTop,maxScroll:target.scrollHeight-target.clientHeight};scrollSynchronized=Math.abs(target.scrollTop-expected.scrollTop)<=2}}
    const coordinateDiagnostics={screenshot:input.screenshot,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio,visualScale:visualViewport?.scale||1,zoomRatio:outerWidth?innerWidth/outerWidth:null},webContentsId:input.expectedWebContentsId,evidenceScroll:input.evidenceScroll||null,liveScroll,scrollSynchronized};
    const pick=(a)=>{const point={x:(a.bbox.x+a.bbox.width/2)*sx,y:(a.bbox.y+a.bbox.height/2)*sy}, stack=document.elementsFromPoint(point.x,point.y).filter(el=>!el.closest('[data-rpa-pdc-debug]'));
      const scored=stack.map((el,i)=>{const r=el.getBoundingClientRect(),interactive=el.matches('a,button,[role=button]')||Boolean(el.querySelector(':scope > svg,:scope > img')),kind=semantic(el);const size=Math.abs(r.width-a.bbox.width*sx)+Math.abs(r.height-a.bbox.height*sy);return{el,r,kind,score:(interactive?60:0)+(kind===a.type?80:0)-size-i*2}}).filter(x=>x.r.width>=4&&x.r.height>=4&&x.r.width<=Math.max(240,innerWidth*.45)&&x.r.height<=160&&x.kind===a.type).sort((a,b)=>b.score-a.score);return{type:a.type,screenshotBbox:a.bbox,point,node:scored[0]?.el||null,reason:!stack.length?'ELEMENTS_FROM_POINT_EMPTY':scored.length?'POINT_SEMANTIC_MATCH':'NO_SEMANTIC_CONTROL_AT_POINT',stack:stack.slice(0,8).map(el=>({tag:el.tagName,role:el.getAttribute('role'),rect:rect(el),semantic:semantic(el),text:String(el.getAttribute('aria-label')||directText(el)||'').trim().slice(0,80)}))}};
    const hitDto=h=>({type:h.type,screenshotBbox:h.screenshotBbox,point:h.point,tag:h.node?.tagName||null,role:h.node?.getAttribute('role')||null,rect:h.node?rect(h.node):null,text:String(h.node?.getAttribute('aria-label')||directText(h.node)||'').trim().slice(0,100),reason:h.reason,stack:h.stack});
    let hits=input.anchors.map(pick);if(hits.length<3||hits.some(h=>!h.node)){const controls=Array.from(document.querySelectorAll('button,[role=button],a')).map(node=>({node,type:semantic(node),r:node.getBoundingClientRect()})).filter(x=>x.type&&x.r.width>=4&&x.r.height>=4&&x.r.bottom>0&&x.r.top<innerHeight),byType=type=>controls.filter(x=>x.type===type);let resolved=null;for(const like of byType('LIKE')){const chain=[];let n=like.node;while(n instanceof Element){chain.push(n);n=n.parentElement}const row=chain.find(el=>{const r=el.getBoundingClientRect();if(r.height<18||r.height>180)return false;const descendants=controls.filter(x=>el.contains(x.node));return ['LIKE','COMMENT','SHARE'].every(type=>descendants.some(x=>x.type===type))});if(row){const descendants=controls.filter(x=>row.contains(x.node));resolved=['LIKE','COMMENT','SHARE'].map(type=>{const found=descendants.find(x=>x.type===type);return{type,screenshotBbox:input.anchors.find(a=>a.type===type)?.bbox||{x:0,y:0,width:0,height:0},point:found?{x:found.r.x+found.r.width/2,y:found.r.y+found.r.height/2}:{x:0,y:0},node:found?.node||null,reason:'LIVE_SEMANTIC_RERESOLVE',stack:[]}});break}}if(resolved)hits=resolved}
    if(hits.length<3||hits.some(h=>!h.node))return{status:'STALE_VISUAL_ANCHOR',hits:hits.map(hitDto),actionRow:null,coordinateDiagnostics,diagnostics:['One or more screenshot points did not resolve; live semantic Action Row re-resolution also failed.']};
    const chains=hits.map(h=>{const out=[];let n=h.node;while(n instanceof Element){out.push(n);n=n.parentElement}return out}), common=chains[0].filter(el=>chains.slice(1).every(c=>c.includes(el)));
    const xs=hits.map(h=>h.point.x),span=Math.max(...xs)-Math.min(...xs);const row=common.find(el=>{const r=el.getBoundingClientRect();return r.width>=span&&r.height>=18&&r.height<=140&&r.width<=innerWidth})||null;
    if(!row)return{status:'AMBIGUOUS',hits:hits.map(hitDto),actionRow:null,coordinateDiagnostics,diagnostics:['Three DOM hits have no safe compact common row ancestor.']};
    const target=identity(location.href)||identity(input.sourceUrl),isPrimary=a=>{try{const u=new URL(a.href,location.href),id=identity(a.href);return id&&target&&id.id===target.id&&!u.searchParams.has('comment_id')&&!u.searchParams.has('reply_comment_id')}catch{return false}},primaryLinks=Array.from(document.querySelectorAll('a[href]')).filter(isPrimary);
    let postParent=null;for(const link of primaryLinks){let node=link.parentElement;while(node&&node!==document.body&&node!==document.documentElement&&!node.contains(row))node=node.parentElement;if(node&&node!==document.body&&node!==document.documentElement&&(!postParent||node.querySelectorAll('*').length<postParent.querySelectorAll('*').length))postParent=node}
    const closestArticle=row.closest('[role=article],article'),articlePrimary=closestArticle&&primaryLinks.some(link=>closestArticle.contains(link)),commentLink=closestArticle&&Array.from(closestArticle.querySelectorAll('a[href]')).some(a=>{try{const u=new URL(a.href,location.href);return u.searchParams.has('comment_id')||u.searchParams.has('reply_comment_id')}catch{return false}}),commentOwnerFound=Boolean(closestArticle&&!articlePrimary&&commentLink);
    let rowBranch=row;while(postParent&&rowBranch.parentElement&&rowBranch.parentElement!==postParent)rowBranch=rowBranch.parentElement;const preceding=postParent?Array.from(postParent.children).slice(0,Math.max(0,Array.from(postParent.children).indexOf(rowBranch))).map(el=>el.getBoundingClientRect().bottom).filter(v=>Number.isFinite(v)&&v<=row.getBoundingClientRect().top+2):[],bodyEnd=preceding.length?Math.max(...preceding):null;
    const following=postParent?Array.from(postParent.querySelectorAll('[role=article],form,[aria-label]')).filter(el=>{const r=el.getBoundingClientRect();return r.top>=row.getBoundingClientRect().bottom&&(/comment|bình luận/i.test(clean(el.getAttribute('aria-label'))) || el.matches('[role=article]'))}):[],commentStart=following.map(el=>el.getBoundingClientRect().top).filter(Number.isFinite).sort((a,b)=>a-b)[0]??null;
    const ownershipStatus=commentOwnerFound?'COMMENT_ITEM':postParent&&target&&bodyEnd!==null&&bodyEnd<=row.getBoundingClientRect().top+2&&(commentStart===null||row.getBoundingClientRect().bottom<=commentStart+2)?'MAIN_POST':'AMBIGUOUS',ownership={status:ownershipStatus,postIdentityVerified:Boolean(target&&primaryLinks.length),parentVerified:Boolean(postParent&&postParent.contains(row)),commentOwnerFound,postParent:postParent?{tag:postParent.tagName,role:postParent.getAttribute('role'),rect:rect(postParent)}:null,postBodyEndY:bodyEnd,commentSectionStartY:commentStart};
    const colors={LIKE:'#3b82f6',COMMENT:'#f59e0b',SHARE:'#a855f7'},overlays=[];let debugVisible=Boolean(input.debugAnchors);const add=(node,color,width,alwaysVisible)=>{const o=document.createElement('div');o.dataset.rpaPdcDebug='1';o.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border-style:solid;border-radius:5px;background:transparent;';o.style.borderColor=color;o.style.borderWidth=width+'px';document.documentElement.appendChild(o);overlays.push({o,node,alwaysVisible})};hits.forEach(h=>add(h.node,colors[h.type],3,true));add(row,'#06b6d4',2,false);let raf=0;const paint=()=>{overlays.forEach(({o,node,alwaysVisible})=>{const r=node.getBoundingClientRect();Object.assign(o.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',display:(alwaysVisible||debugVisible)&&r.width&&r.height?'block':'none'})});raf=requestAnimationFrame(paint)};window.__rpaPdcActionProbe={row,hits:hits.map(h=>h.node),hitRoles:hits.map(h=>h.type),setVisible:value=>{debugVisible=Boolean(value)},dispose:()=>{cancelAnimationFrame(raf);overlays.forEach(x=>x.o.remove());delete window.__rpaPdcActionProbe}};paint();
    return{status:ownershipStatus==='MAIN_POST'?'FOUND':'AMBIGUOUS',hits:hits.map(hitDto),actionRow:{tag:row.tagName,role:row.getAttribute('role'),rect:rect(row),descendantCount:row.querySelectorAll('*').length},ownership,coordinateDiagnostics,diagnostics:ownershipStatus==='MAIN_POST'?[]:[ownershipStatus==='COMMENT_ITEM'?'DOM ownership places Action Row inside a comment item.':'Post Parent ownership could not be verified.']};
  })()`;
}

export function buildPostDetailParentProbeJs(
  input: PostDetailParentProbeInput,
): string {
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
    const directText=el=>Array.from(el.childNodes).filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent||'').join(' ');
    const classify=el=>{const icon=el.querySelector(':scope > svg title,:scope > img[alt]'),t=[el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('alt'),icon?.textContent,icon?.getAttribute?.('alt'),directText(el)].map(clean).join(' ');return /\\b(?:like|thích|bày tỏ)\\b/i.test(t)?'LIKE':/\\b(?:comment|bình luận)\\b/i.test(t)?'COMMENT':/\\b(?:share|chia sẻ)\\b/i.test(t)?'SHARE':null};
    const sx=innerWidth/input.screenshot.width,sy=innerHeight/input.screenshot.height,saved=window.__rpaPdcActionProbe;
    const remapHits=()=>input.anchors.map(a=>{const x=(a.bbox.x+a.bbox.width/2)*sx,y=(a.bbox.y+a.bbox.height/2)*sy,stack=document.elementsFromPoint(x,y).filter(el=>!el.closest('[data-rpa-pdc-debug]'));return stack.map((el,i)=>{const r=el.getBoundingClientRect(),interactive=el.matches('a,button,[role=button]')||Boolean(el.querySelector(':scope > svg,:scope > img')),type=classify(el);return{el,r,type,score:(interactive?60:0)+(type===a.type?80:0)-Math.abs(r.width-a.bbox.width*sx)-Math.abs(r.height-a.bbox.height*sy)-i*2}}).filter(v=>v.r.width>=4&&v.r.height>=4&&v.r.width<=Math.max(240,innerWidth*.45)&&v.r.height<=160&&v.type===a.type).sort((a,b)=>b.score-a.score)[0]?.el||null});
    const cachedHits=saved?.hits?.length===3&&saved.hits.every(node=>node?.isConnected)&&new Set(saved.hitRoles||[]).size===3?saved.hits:null,hits=cachedHits||remapHits();
    if(hits.length<3||hits.some(x=>!x))return{status:'STALE_VISUAL_ANCHOR',currentUrl:location.href,postId:target.id,actionRow:null,actionRowHtml:'',actionRowSignature:null,urlCandidates:[],levels:[],candidates:[],selectedIndex:null,stopReason:'STALE_VISUAL_ANCHOR',boundaryLevel:null,diagnostics:['Confirmed screenshot anchors do not resolve to the live DOM.']};
    const chains=hits.map(hit=>{const out=[];let n=hit;while(n instanceof Element){out.push(n);n=n.parentElement}return out});
    const common=chains[0].filter(el=>chains.slice(1).every(c=>c.includes(el)));
    const row=saved?.row?.isConnected&&cachedHits?saved.row:(common.find(el=>{const r=el.getBoundingClientRect();return r.width>=140&&r.height>=20&&r.height<=180})||common[0]);
    const signatureOf=el=>({tag:el.tagName,role:el.getAttribute('role')||'',childCount:el.children.length,svgCount:el.querySelectorAll('svg').length,buttonCount:el.querySelectorAll('button,[role=button]').length,anchorCount:el.querySelectorAll('a[href]').length,directPattern:Array.from(el.children).map(x=>x.tagName+':'+(x.getAttribute('role')||'')).join('|'),controlOrder:Array.from(el.querySelectorAll('button,[role=button],a')).map(classify).filter(Boolean).join('|')});
    const signature=signatureOf(row),sameSignature=s=>s.tag===signature.tag&&s.role===signature.role&&Math.abs(s.childCount-signature.childCount)<=1&&Math.abs(s.svgCount-signature.svgCount)<=1&&Math.abs(s.buttonCount-signature.buttonCount)<=1&&Math.abs(s.anchorCount-signature.anchorCount)<=1&&s.directPattern===signature.directPattern&&(!signature.controlOrder||s.controlOrder===signature.controlOrder);
    const similarRoots=scope=>{const rr=row.getBoundingClientRect(),independent=[];for(const candidate of scope.querySelectorAll(row.tagName.toLowerCase())){if(candidate===row||row.contains(candidate)||candidate.contains(row)||!sameSignature(signatureOf(candidate)))continue;const r=candidate.getBoundingClientRect();if(r.width<Math.max(40,rr.width*.55)||r.width>rr.width*1.8||r.height<Math.max(12,rr.height*.45)||r.height>rr.height*2.2)continue;independent.push(candidate)}const dedup=independent.filter((n,i,a)=>!a.some((other,j)=>j!==i&&n.contains(other)));return scope.contains(row)?[row,...dedup]:dedup};
    const urlMatches=scope=>Array.from(scope.querySelectorAll('a[href]')).map(a=>{const id=identity(a.href);let reason=id&&id.id===target.id?id.reason:null;if(!reason&&a.href.includes(target.id))reason=new URL(a.href,location.href).searchParams.has('comment_id')?'related-comment-link':'related-id-token';return reason?{href:a.href,reason}:null}).filter(Boolean);
    const fingerprint=el=>[el.tagName,el.getAttribute('role')||'',el.children.length,el.querySelectorAll(':scope > *').length].join(':');
    const levels=[],valid=[];let node=row,level=0,boundaryLevel=null,stopReason='NO_SECOND_ACTION_ROW';
    while(node instanceof Element&&node!==document.body&&node!==document.documentElement){const urls=urlMatches(node),rows=similarRoots(node),desc=node.querySelectorAll('*').length,htmlSize=node.outerHTML.length;const item={parentLevel:level,descendantCount:desc,urlMatchCount:urls.length,similarRowCount:rows.length,rect:box(node),htmlSize,fingerprint:fingerprint(node),tag:node.tagName,role:node.getAttribute('role'),status:rows.length>1?'BOUNDARY_CROSSED':urls.length&&rows.length===1?'CANDIDATE':'SCANNED',urlCandidates:urls};levels.push(item);if(rows.length>1){boundaryLevel=level;stopReason='SECOND_ACTION_ROW_FOUND';break}if(urls.length&&rows.length===1)valid.push({...item,node});node=node.parentElement;level++}
    const expected=Number.isInteger(input.expectedParentLevel)?input.expectedParentLevel:null, exact=expected===null?[]:valid.filter(x=>x.parentLevel===expected),near=expected===null?[]:valid.filter(x=>Math.abs(x.parentLevel-expected)===1);let calibrationMode='FULL_PROGRESSIVE';
    if(exact.length){calibrationMode='EXACT';valid.sort((a,b)=>(b.parentLevel===expected?1:0)-(a.parentLevel===expected?1:0)||b.descendantCount-a.descendantCount)}else if(near.length){calibrationMode='EXPANDED_PLUS_MINUS_ONE';valid.sort((a,b)=>{const ac=Math.abs(a.parentLevel-expected)===1?1:0,bc=Math.abs(b.parentLevel-expected)===1?1:0;return bc-ac||b.descendantCount-a.descendantCount})}else valid.sort((a,b)=>b.descendantCount-a.descendantCount);
    const old=window.__rpaPdcParentProbe;if(old?.dispose)old.dispose();const overlay=document.createElement('div');overlay.dataset.rpaPdcDebug='parent-active';overlay.style.cssText='position:fixed;pointer-events:none;z-index:2147483646;border:3px solid #22c55e;border-radius:6px;box-sizing:border-box;background:transparent;';document.documentElement.appendChild(overlay);let selected=0,confirmed=false,raf=0;
    const paint=()=>{const node=valid[selected]?.node;if(!node){overlay.style.display='none'}else{const r=node.getBoundingClientRect();Object.assign(overlay.style,{left:r.left+'px',top:r.top+'px',width:Math.max(0,r.width)+'px',height:Math.max(0,r.height)+'px',borderWidth:confirmed?'5px':'3px',display:r.width&&r.height?'block':'none'})}raf=requestAnimationFrame(paint)};
    const xpathLiteral=value=>!value.includes("'")?"'"+value+"'":!value.includes('"')?'"'+value+'"':'concat('+value.split("'").map((part,index)=>(index?',"\\\'",':'')+"'"+part+"'").join('')+')';
    const stablePredicate=el=>{const values=[];for(const name of ['role','data-testid','data-pagelet','data-ad-rendering-role']){const value=el.getAttribute(name);if(value)values.push('@'+name+'='+xpathLiteral(value))}return values.length?'['+values.join(' and ')+']':''};
    const structuralRowPredicates=(el,controlSlots=[])=>{const parts=[],role=el.getAttribute('role'),childCount=el.children.length,svgCount=el.querySelectorAll('svg').length,buttonCount=el.querySelectorAll('button,[role=button]').length;if(role)parts.push('@role='+xpathLiteral(role));const stable=stablePredicate(el);if(stable)parts.push(stable.slice(1,-1));if(childCount)parts.push('count(*)='+childCount);if(svgCount)parts.push("count(.//*[local-name()='svg'])>="+Math.min(svgCount,3));if(buttonCount)parts.push("count(.//button | .//*[@role='button'])>="+Math.min(buttonCount,3));if(controlSlots.length===3&&new Set(controlSlots).size===3&&controlSlots.every(x=>x>0)){for(const slot of controlSlots)parts.push("count(*["+slot+"][self::button or @role='button' or .//button or .//*[@role='button']])=1")}return Array.from(new Set(parts))};
    const structuralRowPredicate=el=>{const parts=structuralRowPredicates(el);return parts.length?'['+parts.join(' and ')+']':''};
    const absoluteXPathOf=el=>{const parts=[];let node=el;while(node instanceof Element){let position=1,previous=node.previousElementSibling;while(previous){if(previous.tagName===node.tagName)position++;previous=previous.previousElementSibling}parts.unshift(node.tagName.toLowerCase()+'['+position+']');if(node===document.documentElement)break;node=node.parentElement}return '/'+parts.join('/')};
    const locator=()=>{const parent=valid[selected]?.node;if(!parent)return{ok:false,reason:'NO_CONFIRMED_PARENT',diagnostics:{postId:target.id,currentUrl:location.href,selectedParentIndex:selected}};const links=Array.from(parent.querySelectorAll('a[href]')),commentReplyLinks=links.filter(a=>{try{const u=new URL(a.href,location.href);return u.searchParams.has('comment_id')||u.searchParams.has('reply_comment_id')}catch{return false}}),isPrimaryPostAnchor=a=>{try{const u=new URL(a.href,location.href);return!u.searchParams.has('comment_id')&&!u.searchParams.has('reply_comment_id')}catch{return false}};const anchors=links.filter(isPrimaryPostAnchor).map(a=>({a,id:identity(a.href)})).filter(x=>x.id?.id===target.id),absoluteXPath=absoluteXPathOf(row),controlSlots=(saved?.hits||[]).map(hit=>{let child=hit;while(child?.parentElement&&child.parentElement!==row)child=child.parentElement;return child?.parentElement===row?Array.from(row.children).indexOf(child)+1:0});const diagnostics={postId:target.id,currentUrl:location.href,actionRowTag:row.tagName,actionRowRole:row.getAttribute('role'),selectedParentLevel:valid[selected].parentLevel,parentContainsActionRow:parent.contains(row),primaryAnchorCount:anchors.length,commentReplyAnchorCount:commentReplyLinks.length,totalLinkCount:links.length,absoluteXPath,relativeXPath:null,controlSlots,commonAncestor:null,relativePrefixResults:[],firstZeroPrefix:null,absoluteVerify:null,relativeVerify:null,sameNode:null,parentVerified:false};const choices=[],rowTag=row.tagName.toLowerCase(),rowPredicates=structuralRowPredicates(row,controlSlots);for(const {a,id} of anchors){let common=a.parentElement;while(common&&!common.contains(row))common=common.parentElement;if(!common)continue;let scope=common;while(scope!==document.body&&scope!==document.documentElement&&!stablePredicate(scope))scope=scope.parentElement;if(!scope||scope===document.body||scope===document.documentElement)continue;const stable=stablePredicate(scope),base='ancestor::'+scope.tagName.toLowerCase()+stable+'[1]',rowBase=base+'/descendant::'+rowTag,prefixes=[base,rowBase];for(let i=0;i<rowPredicates.length;i++)prefixes.push(rowBase+'['+rowPredicates.slice(0,i+1).join(' and ')+']');choices.push({a,id,scope,common,relativeXPath:prefixes[prefixes.length-1],prefixes})}for(const candidate of choices){diagnostics.relativeXPath=candidate.relativeXPath;diagnostics.commonAncestor={tag:candidate.common.tagName,role:candidate.common.getAttribute('role'),stableScopeTag:candidate.scope.tagName,stableScopeRole:candidate.scope.getAttribute('role')};diagnostics.relativePrefixResults=[];diagnostics.firstZeroPrefix=null;for(const prefix of candidate.prefixes){try{const snapshot=document.evaluate(prefix,candidate.a,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null),item={prefix,count:snapshot.snapshotLength,containsConfirmedRow:Array.from({length:snapshot.snapshotLength},(_,i)=>snapshot.snapshotItem(i)).some(node=>node===row||node?.contains?.(row))};diagnostics.relativePrefixResults.push(item);if(item.count===0&&!diagnostics.firstZeroPrefix)diagnostics.firstZeroPrefix=prefix}catch(error){diagnostics.relativePrefixResults.push({prefix,error:String(error)});if(!diagnostics.firstZeroPrefix)diagnostics.firstZeroPrefix=prefix}}let baseSnapshot,relativeSnapshot,absoluteSnapshot;try{baseSnapshot=document.evaluate(candidate.prefixes[0],candidate.a,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);relativeSnapshot=document.evaluate(candidate.relativeXPath,candidate.a,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);absoluteSnapshot=document.evaluate(absoluteXPath,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null)}catch(error){diagnostics.relativeVerify={evaluated:false,error:String(error)};continue}if(baseSnapshot.snapshotLength!==1||baseSnapshot.snapshotItem(0)!==candidate.scope||!candidate.scope.contains(row)){diagnostics.relativeVerify={evaluated:true,matchCount:relativeSnapshot.snapshotLength,matchedConfirmedRow:false,reason:'STABLE_COMMON_ANCESTOR_DID_NOT_RESOLVE_EXACT_SCOPE'};continue}const relativeMatches=[],absoluteMatches=[];for(let i=0;i<relativeSnapshot.snapshotLength;i++)relativeMatches.push(relativeSnapshot.snapshotItem(i));for(let i=0;i<absoluteSnapshot.snapshotLength;i++)absoluteMatches.push(absoluteSnapshot.snapshotItem(i));const relativeExact=relativeMatches.filter(node=>node?.tagName===row.tagName&&node.getAttribute('role')===row.getAttribute('role')),absoluteExact=absoluteMatches.filter(node=>node?.tagName===row.tagName&&node.getAttribute('role')===row.getAttribute('role'));diagnostics.absoluteVerify={evaluated:true,matchCount:absoluteExact.length,matchedConfirmedRow:absoluteExact.length===1&&absoluteExact[0]===row};diagnostics.relativeVerify={evaluated:true,matchCount:relativeExact.length,matchedConfirmedRow:relativeExact.length===1&&relativeExact[0]===row};diagnostics.sameNode=relativeExact.length===1&&absoluteExact.length===1&&relativeExact[0]===absoluteExact[0];if(relativeExact.length!==1||relativeExact[0]!==row||absoluteExact.length!==1||absoluteExact[0]!==row||relativeExact[0]!==absoluteExact[0])continue;let resolvedParent=row;for(let i=0;i<valid[selected].parentLevel&&resolvedParent;i++)resolvedParent=resolvedParent.parentElement;diagnostics.parentVerified=resolvedParent===parent;if(resolvedParent!==parent)continue;const locator={version:2,strategy:'POST_SCOPED_RELATIVE_XPATH',postIdentityAnchor:{platform:target.platform,reason:candidate.id.reason,xpathTemplate:"//a[@href and contains(@href, {{POST_ID}}) and not(contains(@href, 'comment_id=')) and not(contains(@href, 'reply_comment_id='))]"},absoluteXPath,relativeXPath:candidate.relativeXPath,diagnosticXPathPrefixes:candidate.prefixes,actionRowTag:row.tagName,actionRowRole:row.getAttribute('role'),actionRowStructure:{childCount:signature.childCount,svgCount:signature.svgCount,buttonCount:signature.buttonCount,directPattern:signature.directPattern},confirmedParentLevel:valid[selected].parentLevel,teachingEvidence:{anchorTag:candidate.a.tagName,anchorReason:candidate.id.reason,anchorHrefPattern:candidate.a.getAttribute('href')||'',absoluteMatchCount:absoluteExact.length,relativeMatchCount:relativeExact.length,sameNode:true,confirmedRowMatched:true,confirmedParentMatched:true}};console.info('[RPA ActionRowLocatorV2 teaching verified]',JSON.stringify(locator));return{ok:true,locator,verification:{...diagnostics,anchorMatches:anchors.length,absoluteMatchCount:absoluteExact.length,relativeMatchCount:relativeExact.length,sameNode:true,rowMatched:true,parentMatched:true,absoluteXPath,relativeXPath:candidate.relativeXPath}}}const reason=!anchors.length?'PRIMARY_POST_IDENTITY_ANCHOR_NOT_FOUND':!choices.length?'STABLE_COMMON_ANCESTOR_NOT_FOUND':diagnostics.relativeVerify?.matchCount>1?'AMBIGUOUS_ACTION_ROW':'DUAL_XPATH_DID_NOT_VERIFY_CONFIRMED_ACTION_ROW';console.warn('[RPA ActionRowLocatorV2 teaching failed]',reason,JSON.stringify(diagnostics));return{ok:false,reason,diagnostics}};
    const domAnchors=()=>{const parent=valid[selected]?.node,nodes=saved?.hits||hits,types=saved?.hitRoles||nodes.map(classify);if(!parent||nodes.length<3||new Set(types).size!==3)return{};const relativePath=node=>{const path=[];let current=node;while(current&&current!==parent){const owner=current.parentElement;if(!owner)return null;path.unshift(Array.from(owner.children).indexOf(current));current=owner}return current===parent?path:null};const roleFor=type=>({LIKE:'like_anchor',COMMENT:'comment_anchor',SHARE:'share_anchor'})[type];return Object.fromEntries(nodes.map((node,index)=>{const role=roleFor(types[index]),path=relativePath(node),r=node.getBoundingClientRect();return[role,{semanticRole:role,parentRelativePath:path||[],structuralSignature:{tag:node.tagName,role:node.getAttribute('role')||'',childCount:node.children.length,svgCount:node.querySelectorAll('svg').length},actionRowRelationship:'DESCENDANT',sourceEvidence:{text:String(node.getAttribute('aria-label')||node.textContent||'').trim().slice(0,100),tag:node.tagName,role:node.getAttribute('role'),rect:{x:r.x,y:r.y,width:r.width,height:r.height}},confidence:path?'high':'low',verificationStatus:path?'VERIFIED':'NOT_VERIFIED',countSource:{relationship:'UNKNOWN',verificationStatus:'NOT_VERIFIED'}}]}))};
    window.__rpaPdcParentProbe={select:i=>{selected=Math.max(0,Math.min(valid.length-1,i));confirmed=false;return selected},confirm:(i,result)=>{selected=Math.max(0,Math.min(valid.length-1,i));confirmed=Boolean(result?.ok&&result.locator);return confirmed},locator,domAnchors,dispose:()=>{cancelAnimationFrame(raf);overlay.remove();delete window.__rpaPdcParentProbe}};paint();
    const candidates=valid.map(({node,...x},index)=>({...x,index}));return{status:candidates.length?'FOUND':'AMBIGUOUS',currentUrl:location.href,postId:target.id,platform:target.platform,actionRow:{tag:row.tagName,rect:box(row)},actionRowHtml:row.outerHTML,actionRowSignature:signature,urlCandidates:urlMatches(document),levels,candidates,selectedIndex:candidates.length?0:null,stopReason,boundaryLevel,expectedParentLevel:expected,calibrationMode,diagnostics:expected!==null&&calibrationMode==='FULL_PROGRESSIVE'?['Exact and ±1 calibration levels were invalid; fell back to full progressive candidates.']:[]};
  })()`;
}

export function buildPostDetailParentSelectJs(
  index: number,
  confirm: boolean,
): string {
  const i = Math.max(0, Math.floor(index));
  return `(()=>{const p=window.__rpaPdcParentProbe;if(!p)return{ok:false,reason:'NO_ACTIVE_PARENT_PROBE'};const selectedIndex=p.select(${i});const result=${confirm ? "p.locator()" : "null"};if(result&&!result.ok)return{ok:false,reason:result.reason,diagnostics:result.diagnostics,selectedIndex,confirmed:false};const confirmed=${confirm ? "p.confirm(selectedIndex,result)" : "false"};return{ok:true,selectedIndex,confirmed,actionRowLocator:result?.locator,domAnchors:confirmed?p.domAnchors():{},verification:result?.verification}})()`;
}
export function buildPostDetailActionDebugJs(visible: boolean): string {
  return `(()=>{const p=window.__rpaPdcActionProbe;if(!p)return{ok:false,reason:'NO_ACTIVE_ACTION_PROBE'};p.setVisible(${Boolean(visible)});return{ok:true,visible:${Boolean(visible)}}})()`;
}
export const CLEAR_POST_DETAIL_PARENT_HIGHLIGHT_JS = `(()=>{window.__rpaPdcParentProbe?.dispose?.();window.__rpaPdcActionProbe?.dispose?.();return{ok:true}})()`;

export function buildResolveSavedParentJs(
  config: PostDetailParentConfig,
): string {
  const data = JSON.stringify(config).replace(/</g, "\\u003c");
  return `(()=>{
    const config=${data},locator=config.actionRowLocator;
    const meta={locatorVersion:locator?.version||null,postId:null,absoluteXPath:locator?.absoluteXPath||null,relativeXPath:locator?.relativeXPath||null,absoluteMatchCount:0,relativeMatchCount:0,sameNode:false,postIdentityVerified:false,actionRowVerified:false,parentVerified:false,failureCode:null,anchorXPathTemplate:locator?.postIdentityAnchor?.xpathTemplate||null,confirmedParentLevel:locator?.confirmedParentLevel??null,xpathPrefixCounts:[],anchorSamples:[]};
    const fail=(code,message,status='REMATCH_REQUIRED')=>{meta.failureCode=code;console.warn('[RPA ActionRowLocatorV2 resolve failed]',code,message,JSON.stringify(meta));delete window.__rpaPdcSavedParent;return{status,innerHTML:'',rect:null,failureCode:code,diagnosticMeta:meta,diagnostics:[message]}};
    const identity=raw=>{try{const u=new URL(raw,location.href),p=u.pathname;let m=/(?:\\/posts\\/|\\/permalink\\/)([0-9A-Za-z_-]+)/i.exec(p)||/^\\/@[^/]+\\/post\\/([^/?#]+)/i.exec(p);if(m)return{id:m[1],reason:/permalink/i.test(m[0])?'facebook-permalink-path':/posts/i.test(m[0])?'facebook-posts-path':'threads-post-path',primary:true};for(const k of ['multi_permalinks','story_fbid']){const v=u.searchParams.get(k);if(v)return{id:v,reason:'query-'+k,primary:true}}const set=u.searchParams.get('set'),sm=set&&/^(?:gm|pcb)\\.([0-9A-Za-z_-]+)/i.exec(set);return sm?{id:sm[1],reason:'facebook-media-set',primary:false}:null}catch{return null}};
    const sameReason=(a,b)=>a===b||(/^facebook-(?:permalink|posts)-path$/.test(a)&&/^facebook-(?:permalink|posts)-path$/.test(b));
    const xpathLiteral=value=>!value.includes("'")?"'"+value+"'":!value.includes('"')?'"'+value+'"':'concat('+value.split("'").map((part,index)=>(index?',"\\\'",':'')+"'"+part+"'").join('')+')',target=identity(location.href),isPrimaryPostHref=raw=>{try{const u=new URL(raw,location.href);return!u.searchParams.has('comment_id')&&!u.searchParams.has('reply_comment_id')}catch{return false}};
    if(document.readyState==='loading'||!document.body)return fail('BROWSER_NOT_READY','Browser DOM is still loading.','BROWSER_NOT_READY');
    if(!target)return fail('BROWSER_NOT_READY','Live post identity is not available yet.','BROWSER_NOT_READY');meta.postId=target.id;
    if(!locator)return fail('NOT_FOUND','Saved Action Row locator is not configured; manual Rematch is required.');
    if(locator.version!==2||locator.strategy!=='POST_SCOPED_RELATIVE_XPATH')return fail('INVALID','Legacy V1 locator is preserved but cannot be heuristically upgraded; manual Rematch is required.');
    let anchorSnapshot,absoluteSnapshot;try{const anchorXPath=locator.postIdentityAnchor.xpathTemplate.replace('{{POST_ID}}',xpathLiteral(target.id));anchorSnapshot=document.evaluate(anchorXPath,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);absoluteSnapshot=document.evaluate(locator.absoluteXPath,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null)}catch{return fail('INVALID','Saved absolute or post identity XPath is invalid.')}
    const anchors=[];for(let i=0;i<anchorSnapshot.snapshotLength;i++){const a=anchorSnapshot.snapshotItem(i),value=a&&identity(a.href);if(value?.id===target.id&&isPrimaryPostHref(a.href)&&sameReason(value.reason,locator.postIdentityAnchor.reason))anchors.push(a)}meta.anchorSamples=anchors.slice(0,4).map(a=>({tag:a.tagName,href:a.getAttribute('href'),connected:a.isConnected}));
    const absoluteRows=[];for(let i=0;i<absoluteSnapshot.snapshotLength;i++)absoluteRows.push(absoluteSnapshot.snapshotItem(i));
    const relativeRows=[];for(const anchor of anchors){const prefixCounts=[];for(const prefix of locator.diagnosticXPathPrefixes||[]){try{prefixCounts.push({prefix,count:document.evaluate(prefix,anchor,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null).snapshotLength})}catch(error){prefixCounts.push({prefix,error:String(error)})}}meta.xpathPrefixCounts.push(prefixCounts);let snapshot;try{snapshot=document.evaluate(locator.relativeXPath,anchor,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null)}catch{return fail('INVALID','Saved relative XPath is invalid.')}for(let i=0;i<snapshot.snapshotLength;i++)relativeRows.push(snapshot.snapshotItem(i))}
    const absoluteUnique=Array.from(new Set(absoluteRows)),relativeUnique=Array.from(new Set(relativeRows));meta.absoluteMatchCount=absoluteUnique.length;meta.relativeMatchCount=relativeUnique.length;
    if(absoluteUnique.length>1||relativeUnique.length>1)return fail('AMBIGUOUS','One saved XPath resolved multiple independent nodes.');
    if(!absoluteUnique.length&&!relativeUnique.length)return fail('NOT_FOUND','Neither saved XPath resolved an Action Row.');
    if(absoluteUnique.length&&relativeUnique.length&&absoluteUnique[0]!==relativeUnique[0])return fail('CONFLICT','Absolute and relative XPath resolved different nodes.');
    const row=absoluteUnique[0]||relativeUnique[0];meta.sameNode=Boolean(absoluteUnique.length&&relativeUnique.length&&absoluteUnique[0]===relativeUnique[0]);
    if(!(row instanceof Element))return fail('INVALID','Saved XPath did not resolve an Element.');
    const structure=locator.actionRowStructure,directPattern=Array.from(row.children).map(x=>x.tagName+':'+(x.getAttribute('role')||'')).join('|');meta.actionRowVerified=row.tagName===locator.actionRowTag&&row.getAttribute('role')===locator.actionRowRole&&row.children.length===structure.childCount&&row.querySelectorAll('svg').length>=Math.min(structure.svgCount,3)&&row.querySelectorAll('button,[role=button]').length>=Math.min(structure.buttonCount,3)&&directPattern===structure.directPattern;
    if(!meta.actionRowVerified)return fail('INVALID','Resolved node does not match the confirmed Action Row boundary.');
    let parent=row;for(let i=0;i<locator.confirmedParentLevel&&parent;i++)parent=parent.parentElement;
    if(!parent||parent===document.body||parent===document.documentElement||!parent.contains(row))return fail('PARENT_MISMATCH','Confirmed Parent Level crossed the page boundary.');
    const identityLinks=Array.from(parent.querySelectorAll('a[href]')).filter(a=>isPrimaryPostHref(a.href)).map(a=>identity(a.href)).filter(Boolean),targetCount=identityLinks.filter(x=>x.id===target.id).length,foreign=Array.from(new Set(identityLinks.filter(x=>x.primary&&x.id!==target.id).map(x=>x.id)));meta.postIdentityVerified=targetCount>0&&!foreign.length;meta.parentVerified=Boolean(parent.contains(row)&&meta.postIdentityVerified);
    if(!meta.parentVerified)return fail('PARENT_MISMATCH',!targetCount?'Resolved Parent does not contain the primary current-post identity.':'Resolved Parent contains another independent post identity.');
    const resolvePath=path=>{let node=parent;for(const index of path||[]){node=node?.children?.[index];if(!node)break}return node instanceof Element?node:null},anchorRecords=config.domAnchors||{},anchorRoles=['like_anchor','comment_anchor','share_anchor'];meta.anchorVerification=Object.fromEntries(anchorRoles.map(role=>{const record=anchorRecords[role],node=record?resolvePath(record.parentRelativePath):null,sig=record?.structuralSignature||{},matches=Boolean(node&&(!sig.tag||node.tagName===sig.tag)&&(!sig.role||node.getAttribute('role')===sig.role)&&(!Number.isInteger(sig.childCount)||node.children.length===sig.childCount));return[role,{configured:Boolean(record),resolved:Boolean(node),matches}]}));meta.domAnchorsVerified=anchorRoles.every(role=>meta.anchorVerification[role].matches);
    const r=parent.getBoundingClientRect();console.info('[RPA ActionRowLocatorV2 resolve matched]',JSON.stringify(meta));window.__rpaPdcSavedParent=parent;return{status:'PARENT_MATCHED',innerHTML:parent.innerHTML,rect:{x:r.x,y:r.y,width:r.width,height:r.height},diagnosticMeta:meta,diagnostics:meta.domAnchorsVerified?[]:['Parent verified; one or more Like/Comment/Share DOM anchors are missing or stale.']};
  })()`;
}

export function buildHighlightSavedParentNodeJs(path: number[]): string {
  const safePath = JSON.stringify(
    path.map((value) => Math.max(0, Math.floor(value))),
  );
  return `(()=>{const parent=window.__rpaPdcSavedParent;if(!parent?.isConnected)return{ok:false,reason:'PARENT_NOT_RESOLVED'};let node=parent;for(const index of ${safePath}){node=node?.children?.[index];if(!node)return{ok:false,reason:'NODE_PATH_NOT_FOUND'}}if(node!==parent&&!parent.contains(node))return{ok:false,reason:'NODE_OUTSIDE_PARENT'};let state=window.__rpaPdcExplorerHighlight;if(!state){const overlay=document.createElement('div');overlay.dataset.rpaPdcDebug='explorer-node';overlay.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:3px solid #22c55e;border-radius:4px;box-sizing:border-box;background:rgba(34,197,94,.06)';document.documentElement.appendChild(overlay);state={overlay,node:null,raf:0};window.__rpaPdcExplorerHighlight=state;const paint=()=>{const current=state.node;if(!current?.isConnected||!parent.contains(current)){overlay.style.display='none'}else{const r=current.getBoundingClientRect();Object.assign(overlay.style,{left:r.left+'px',top:r.top+'px',width:Math.max(0,r.width)+'px',height:Math.max(0,r.height)+'px',display:r.width&&r.height?'block':'none'})}state.raf=requestAnimationFrame(paint)};paint()}state.node=node;return{ok:true,tagName:node.tagName}})()`;
}

export const CLEAR_SAVED_PARENT_NODE_HIGHLIGHT_JS = `(()=>{const state=window.__rpaPdcExplorerHighlight;if(state){cancelAnimationFrame(state.raf);state.overlay?.remove?.();delete window.__rpaPdcExplorerHighlight}return{ok:true}})()`;
