import type {
  PostDetailParentConfig,
  PostDetailParentProbeInput,
} from "../shared/post-detail-collector/types.js";

export function classifyDualXPathResolution<T>(
  absoluteNodes: T[],
  relativeNodes: T[],
  evidence: { postIdentityVerified: boolean; actionRowVerified: boolean; parentVerified: boolean },
): "MATCHED" | "NOT_FOUND" | "AMBIGUOUS" | "INVALID" | "CONFLICT" | "REMATCH_REQUIRED" {
  const absolute = Array.from(new Set(absoluteNodes));
  const relative = Array.from(new Set(relativeNodes));
  if (absolute.length > 1 || relative.length > 1) return "AMBIGUOUS";
  if (!absolute.length && !relative.length) return "NOT_FOUND";
  if (absolute.length && relative.length && absolute[0] !== relative[0]) return "CONFLICT";
  if (!evidence.actionRowVerified) return "INVALID";
  if (!evidence.postIdentityVerified || !evidence.parentVerified) return "REMATCH_REQUIRED";
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
    const input=${data}, sx=innerWidth/input.screenshot.width, sy=innerHeight/input.screenshot.height;
    const old=window.__rpaPdcActionProbe;if(old?.dispose)old.dispose();
    const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
    const pick=(a)=>{const point={x:(a.bbox.x+a.bbox.width/2)*sx,y:(a.bbox.y+a.bbox.height/2)*sy}, stack=document.elementsFromPoint(point.x,point.y).filter(el=>!el.closest('[data-rpa-pdc-debug]'));
      const scored=stack.map((el,i)=>{const r=el.getBoundingClientRect(),role=el.getAttribute('role'),interactive=el.matches('a,button,[role=button]')||el.querySelector('svg');const size=Math.abs(r.width-a.bbox.width*sx)+Math.abs(r.height-a.bbox.height*sy);return{el,r,score:(interactive?60:0)-size-i*2}}).filter(x=>x.r.width>=4&&x.r.height>=4&&x.r.width<=180&&x.r.height<=100).sort((a,b)=>b.score-a.score);return{type:a.type,point,node:scored[0]?.el||null,stack:stack.slice(0,8).map(el=>({tag:el.tagName,role:el.getAttribute('role'),rect:rect(el),text:String(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,80)}))}};
    const hits=input.anchors.map(pick);if(hits.length<3||hits.some(h=>!h.node))return{status:'STALE_VISUAL_ANCHOR',hits:hits.map(h=>({type:h.type,point:h.point,tag:h.node?.tagName||null,role:h.node?.getAttribute('role')||null,rect:h.node?rect(h.node):null,text:String(h.node?.getAttribute('aria-label')||h.node?.textContent||'').trim().slice(0,100)})),actionRow:null,diagnostics:['One or more screenshot points did not resolve to a geometric DOM node.']};
    const chains=hits.map(h=>{const out=[];let n=h.node;while(n instanceof Element){out.push(n);n=n.parentElement}return out}), common=chains[0].filter(el=>chains.slice(1).every(c=>c.includes(el)));
    const xs=hits.map(h=>h.point.x),span=Math.max(...xs)-Math.min(...xs);const row=common.find(el=>{const r=el.getBoundingClientRect();return r.width>=span&&r.height>=18&&r.height<=140&&r.width<=innerWidth})||null;
    if(!row)return{status:'AMBIGUOUS',hits:hits.map(h=>({type:h.type,point:h.point,tag:h.node.tagName,role:h.node.getAttribute('role'),rect:rect(h.node),text:String(h.node.getAttribute('aria-label')||h.node.textContent||'').trim().slice(0,100)})),actionRow:null,diagnostics:['Three DOM hits have no safe compact common row ancestor.']};
    const colors={LIKE:'#3b82f6',COMMENT:'#f59e0b',SHARE:'#a855f7'},overlays=[];let debugVisible=Boolean(input.debugAnchors);const add=(node,color,width,alwaysVisible)=>{const o=document.createElement('div');o.dataset.rpaPdcDebug='1';o.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border-style:solid;border-radius:5px;background:transparent;';o.style.borderColor=color;o.style.borderWidth=width+'px';document.documentElement.appendChild(o);overlays.push({o,node,alwaysVisible})};hits.forEach(h=>add(h.node,colors[h.type],3,true));add(row,'#06b6d4',2,false);let raf=0;const paint=()=>{overlays.forEach(({o,node,alwaysVisible})=>{const r=node.getBoundingClientRect();Object.assign(o.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',display:(alwaysVisible||debugVisible)&&r.width&&r.height?'block':'none'})});raf=requestAnimationFrame(paint)};window.__rpaPdcActionProbe={row,hits:hits.map(h=>h.node),setVisible:value=>{debugVisible=Boolean(value)},dispose:()=>{cancelAnimationFrame(raf);overlays.forEach(x=>x.o.remove());delete window.__rpaPdcActionProbe}};paint();
    return{status:'FOUND',hits:hits.map(h=>({type:h.type,point:h.point,tag:h.node.tagName,role:h.node.getAttribute('role'),rect:rect(h.node),text:String(h.node.getAttribute('aria-label')||h.node.textContent||'').trim().slice(0,100)})),actionRow:{tag:row.tagName,role:row.getAttribute('role'),rect:rect(row),descendantCount:row.querySelectorAll('*').length},diagnostics:[]};
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
    const sx=innerWidth/input.screenshot.width,sy=innerHeight/input.screenshot.height;
    const hits=input.anchors.map(a=>{const x=(a.bbox.x+a.bbox.width/2)*sx,y=(a.bbox.y+a.bbox.height/2)*sy;const stack=document.elementsFromPoint(x,y).filter(el=>!el.closest('[data-rpa-pdc-debug]'));return stack.map((el,i)=>{const r=el.getBoundingClientRect(),interactive=el.matches('a,button,[role=button]')||el.querySelector('svg');return{el,r,score:(interactive?60:0)-Math.abs(r.width-a.bbox.width*sx)-Math.abs(r.height-a.bbox.height*sy)-i*2}}).filter(v=>v.r.width>=4&&v.r.height>=4&&v.r.width<=180&&v.r.height<=100).sort((a,b)=>b.score-a.score)[0]?.el||null});
    if(hits.length<3||hits.some(x=>!x))return{status:'STALE_VISUAL_ANCHOR',currentUrl:location.href,postId:target.id,actionRow:null,actionRowHtml:'',actionRowSignature:null,urlCandidates:[],levels:[],candidates:[],selectedIndex:null,stopReason:'STALE_VISUAL_ANCHOR',boundaryLevel:null,diagnostics:['Confirmed screenshot anchors do not resolve to the live DOM.']};
    const chains=hits.map(hit=>{const out=[];let n=hit;while(n instanceof Element){out.push(n);n=n.parentElement}return out});
    const common=chains[0].filter(el=>chains.slice(1).every(c=>c.includes(el)));
    const saved=window.__rpaPdcActionProbe,row=saved?.row?.isConnected?saved.row:(common.find(el=>{const r=el.getBoundingClientRect();return r.width>=140&&r.height>=20&&r.height<=180})||common[0]);
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
    const structuralRowPredicate=el=>{const parts=[],role=el.getAttribute('role'),childCount=el.children.length,svgCount=el.querySelectorAll('svg').length,buttonCount=el.querySelectorAll('button,[role=button]').length;if(role)parts.push('@role='+xpathLiteral(role));const stable=stablePredicate(el);if(stable)parts.push(stable.slice(1,-1));if(childCount)parts.push('count(*)='+childCount);if(svgCount)parts.push('count(.//svg)>='+Math.min(svgCount,3));if(buttonCount)parts.push("count(.//button | .//*[@role='button'])>="+Math.min(buttonCount,3));return parts.length?'['+Array.from(new Set(parts)).join(' and ')+']':''};
    const absoluteXPathOf=el=>{const parts=[];let node=el;while(node instanceof Element){let position=1,previous=node.previousElementSibling;while(previous){if(previous.tagName===node.tagName)position++;previous=previous.previousElementSibling}parts.unshift(node.tagName.toLowerCase()+'['+position+']');if(node===document.documentElement)break;node=node.parentElement}return '/'+parts.join('/')};
    const locator=()=>{const parent=valid[selected]?.node;if(!parent)return{ok:false,reason:'NO_CONFIRMED_PARENT'};const isPrimaryPostAnchor=a=>{try{const u=new URL(a.href,location.href);return!u.searchParams.has('comment_id')&&!u.searchParams.has('reply_comment_id')}catch{return false}};const anchors=Array.from(parent.querySelectorAll('a[href]')).filter(isPrimaryPostAnchor).map(a=>({a,id:identity(a.href)})).filter(x=>x.id?.id===target.id);const choices=[],rowTag=row.tagName.toLowerCase(),rowPredicate=structuralRowPredicate(row),absoluteXPath=absoluteXPathOf(row);for(const {a,id} of anchors){let cursor=a.parentElement,tagIndexes={};while(cursor&&cursor!==document.body&&cursor!==document.documentElement){const tag=cursor.tagName.toLowerCase();tagIndexes[tag]=(tagIndexes[tag]||0)+1;if(cursor.contains(row)){const stable=stablePredicate(cursor),base=stable?'ancestor::'+tag+stable+'[1]':'ancestor::'+tag+'['+tagIndexes[tag]+']',relativeXPath=base+'/descendant::'+rowTag+rowPredicate;choices.push({a,id,relativeXPath,prefixes:[base,relativeXPath],stable:Boolean(stable),depth:tagIndexes[tag]})}cursor=cursor.parentElement}}choices.sort((a,b)=>Number(b.stable)-Number(a.stable)||a.depth-b.depth);for(const candidate of choices){let relativeSnapshot,absoluteSnapshot;try{relativeSnapshot=document.evaluate(candidate.relativeXPath,candidate.a,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);absoluteSnapshot=document.evaluate(absoluteXPath,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null)}catch{continue}const relativeMatches=[],absoluteMatches=[];for(let i=0;i<relativeSnapshot.snapshotLength;i++)relativeMatches.push(relativeSnapshot.snapshotItem(i));for(let i=0;i<absoluteSnapshot.snapshotLength;i++)absoluteMatches.push(absoluteSnapshot.snapshotItem(i));const relativeExact=relativeMatches.filter(node=>node?.tagName===row.tagName&&node.getAttribute('role')===row.getAttribute('role')),absoluteExact=absoluteMatches.filter(node=>node?.tagName===row.tagName&&node.getAttribute('role')===row.getAttribute('role'));if(relativeExact.length!==1||relativeExact[0]!==row||absoluteExact.length!==1||absoluteExact[0]!==row||relativeExact[0]!==absoluteExact[0])continue;let resolvedParent=row;for(let i=0;i<valid[selected].parentLevel&&resolvedParent;i++)resolvedParent=resolvedParent.parentElement;if(resolvedParent!==parent)continue;const locator={version:2,strategy:'POST_SCOPED_RELATIVE_XPATH',postIdentityAnchor:{platform:target.platform,reason:candidate.id.reason,xpathTemplate:"//a[@href and contains(@href, {{POST_ID}}) and not(contains(@href, 'comment_id=')) and not(contains(@href, 'reply_comment_id='))]"},absoluteXPath,relativeXPath:candidate.relativeXPath,diagnosticXPathPrefixes:candidate.prefixes,actionRowTag:row.tagName,actionRowRole:row.getAttribute('role'),actionRowStructure:{childCount:signature.childCount,svgCount:signature.svgCount,buttonCount:signature.buttonCount,directPattern:signature.directPattern},confirmedParentLevel:valid[selected].parentLevel,teachingEvidence:{anchorTag:candidate.a.tagName,anchorReason:candidate.id.reason,anchorHrefPattern:candidate.a.getAttribute('href')||'',absoluteMatchCount:absoluteExact.length,relativeMatchCount:relativeExact.length,sameNode:true,confirmedRowMatched:true,confirmedParentMatched:true}};console.info('[RPA ActionRowLocatorV2 teaching verified]',JSON.stringify(locator));return{ok:true,locator,verification:{anchorMatches:anchors.length,absoluteMatchCount:absoluteExact.length,relativeMatchCount:relativeExact.length,sameNode:true,rowMatched:true,parentMatched:true,absoluteXPath,relativeXPath:candidate.relativeXPath}}}return{ok:false,reason:anchors.length?'DUAL_XPATH_DID_NOT_VERIFY_CONFIRMED_ACTION_ROW':'PRIMARY_POST_IDENTITY_ANCHOR_NOT_FOUND'}};
    window.__rpaPdcParentProbe={select:i=>{selected=Math.max(0,Math.min(valid.length-1,i));confirmed=false;return selected},confirm:i=>{selected=Math.max(0,Math.min(valid.length-1,i));confirmed=true;return selected},locator,dispose:()=>{cancelAnimationFrame(raf);overlay.remove();delete window.__rpaPdcParentProbe}};paint();
    const candidates=valid.map(({node,...x},index)=>({...x,index}));return{status:candidates.length?'FOUND':'AMBIGUOUS',currentUrl:location.href,postId:target.id,platform:target.platform,actionRow:{tag:row.tagName,rect:box(row)},actionRowHtml:row.outerHTML,actionRowSignature:signature,urlCandidates:urlMatches(document),levels,candidates,selectedIndex:candidates.length?0:null,stopReason,boundaryLevel,expectedParentLevel:expected,calibrationMode,diagnostics:expected!==null&&calibrationMode==='FULL_PROGRESSIVE'?['Exact and ±1 calibration levels were invalid; fell back to full progressive candidates.']:[]};
  })()`;
}

export function buildPostDetailParentSelectJs(
  index: number,
  confirm: boolean,
): string {
  const i = Math.max(0, Math.floor(index));
  return `(()=>{const p=window.__rpaPdcParentProbe;if(!p)return{ok:false,reason:'NO_ACTIVE_PARENT_PROBE'};const selectedIndex=p.${confirm ? "confirm" : "select"}(${i});const result=${confirm ? "p.locator()" : "null"};return result&&!result.ok?{ok:false,reason:result.reason,selectedIndex,confirmed:false}:{ok:true,selectedIndex,confirmed:${confirm},actionRowLocator:result?.locator,verification:result?.verification}})()`;
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
    const r=parent.getBoundingClientRect();console.info('[RPA ActionRowLocatorV2 resolve matched]',JSON.stringify(meta));window.__rpaPdcSavedParent=parent;return{status:'PARENT_MATCHED',innerHTML:parent.innerHTML,rect:{x:r.x,y:r.y,width:r.width,height:r.height},diagnosticMeta:meta,diagnostics:[]};
  })()`;
}

export function buildHighlightSavedParentNodeJs(path: number[]): string {
  const safePath = JSON.stringify(
    path.map((value) => Math.max(0, Math.floor(value))),
  );
  return `(()=>{const parent=window.__rpaPdcSavedParent;if(!parent?.isConnected)return{ok:false,reason:'PARENT_NOT_RESOLVED'};let node=parent;for(const index of ${safePath}){node=node?.children?.[index];if(!node)return{ok:false,reason:'NODE_PATH_NOT_FOUND'}}if(node!==parent&&!parent.contains(node))return{ok:false,reason:'NODE_OUTSIDE_PARENT'};let state=window.__rpaPdcExplorerHighlight;if(!state){const overlay=document.createElement('div');overlay.dataset.rpaPdcDebug='explorer-node';overlay.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:3px solid #22c55e;border-radius:4px;box-sizing:border-box;background:rgba(34,197,94,.06)';document.documentElement.appendChild(overlay);state={overlay,node:null,raf:0};window.__rpaPdcExplorerHighlight=state;const paint=()=>{const current=state.node;if(!current?.isConnected||!parent.contains(current)){overlay.style.display='none'}else{const r=current.getBoundingClientRect();Object.assign(overlay.style,{left:r.left+'px',top:r.top+'px',width:Math.max(0,r.width)+'px',height:Math.max(0,r.height)+'px',display:r.width&&r.height?'block':'none'})}state.raf=requestAnimationFrame(paint)};paint()}state.node=node;return{ok:true,tagName:node.tagName}})()`;
}

export const CLEAR_SAVED_PARENT_NODE_HIGHLIGHT_JS = `(()=>{const state=window.__rpaPdcExplorerHighlight;if(state){cancelAnimationFrame(state.raf);state.overlay?.remove?.();delete window.__rpaPdcExplorerHighlight}return{ok:true}})()`;
