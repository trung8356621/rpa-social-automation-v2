import { FacebookPermalinkAdapter, buildFacebookPermalinkExtractorJs } from "../shared/permalink-adapter.js";
import type {
  PostDetailExtractAboveInput,
  PostDetailHtmlExtractionResult,
  PostDetailParsedJson,
} from "../shared/post-detail-collector/types.js";

const emptyParsed = (): PostDetailParsedJson => ({
  post_id: null, post_url: null, author_name: null, author_url: null, post_time: null,
  content: null, images: [], links: [], reaction_count: null, comment_count: null, share_count: null,
});

export function buildPostDetailExtractAboveJs(input: PostDetailExtractAboveInput): string {
  const safeInput = JSON.stringify(input).replace(/</g, "\\u003c");
  return `(() => {
    const input = ${safeInput};
    const extractPost = ${buildFacebookPermalinkExtractorJs()};
    const diagnostics = [];
    const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const attrs = el => el instanceof Element ? Array.from(el.attributes).reduce((o,a) => { if (/^(?:role|aria-|href|title|data-)/i.test(a.name)) o[a.name] = a.value.slice(0,300); return o; }, {}) : {};
    const describe = el => el instanceof Element ? { tag: el.tagName, role: el.getAttribute('role'), attrs: attrs(el), text: clean(el.getAttribute('aria-label') || el.textContent).slice(0,160) } : null;
    const currentIdentity = extractPost(location.href, location.href);
    const expectedIdentity = extractPost(input.expectedUrl, location.href);
    if (!currentIdentity || !expectedIdentity || currentIdentity.postId !== expectedIdentity.postId) {
      return { status:'URL_MISMATCH', diagnostics:['Expected and live URLs do not identify the same post.'], boundary:{ currentUrl:location.href, currentIdentity, expectedIdentity } };
    }
    const viewport = { width:innerWidth, height:innerHeight, deviceScaleFactor:devicePixelRatio, zoom:outerWidth ? innerWidth/outerWidth : null, scrollX, scrollY };
    const sx = innerWidth / input.screenshot.width, sy = innerHeight / input.screenshot.height;
    const expectedWords = { LIKE:/like|thích|bày tỏ/i, COMMENT:/comment|bình luận/i, SHARE:/share|chia sẻ/i };
    const hits = input.anchors.map(anchor => {
      const point = { x:(anchor.bbox.x + anchor.bbox.width/2)*sx, y:(anchor.bbox.y + anchor.bbox.height/2)*sy };
      const stack = document.elementsFromPoint(point.x, point.y);
      const matcher = expectedWords[anchor.type];
      const match = stack.find(el => matcher.test(clean(el.getAttribute('aria-label') || '') + ' ' + clean(el.textContent))) || null;
      return { type:anchor.type, screenshotBbox:anchor.bbox, cssPoint:point, match, stack:stack.slice(0,8).map(describe) };
    });
    if (hits.length < 3 || hits.some(h => !h.match)) {
      return { status:'STALE_VISUAL_ANCHOR', diagnostics:['Live DOM no longer matches all three visual anchors.'], boundary:{ currentUrl:location.href, viewport, hits:hits.map(h=>({...h,match:describe(h.match)})) } };
    }
    const chains = hits.map(h => { const out=[]; let n=h.match; while(n && n instanceof Element){out.push(n);n=n.parentElement;} return out; });
    const common = chains[0].filter(el => chains.slice(1).every(c => c.includes(el)));
    const row = common.find(el => { const r=el.getBoundingClientRect(); return r.height >= 20 && r.height <= 180 && r.width >= 140; }) || common[0];
    if (!row) return { status:'AMBIGUOUS', diagnostics:['No common DOM action-row ancestor.'], boundary:{ viewport } };
    const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({ a, id:extractPost(a.href, location.href) })).filter(x => x.id && x.id.postId === currentIdentity.postId && x.a.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
    links.sort((a,b) => Math.abs(row.getBoundingClientRect().top-a.a.getBoundingClientRect().top)-Math.abs(row.getBoundingClientRect().top-b.a.getBoundingClientRect().top));
    const identityLink = links[0] && links[0].a;
    if (!identityLink) return { status:'NOT_FOUND', diagnostics:['No same-post permalink/time anchor found above Action Row.'], boundary:{ viewport, row:describe(row) } };
    let lca = identityLink; while(lca && !lca.contains(row)) lca=lca.parentElement;
    if (!lca) return { status:'AMBIGUOUS', diagnostics:['Post identity and Action Row have no safe common ancestor.'], boundary:{ viewport } };
    let topNode=identityLink; while(topNode.parentElement && topNode.parentElement !== lca) topNode=topNode.parentElement;
    let rowNode=row; while(rowNode.parentElement && rowNode.parentElement !== lca) rowNode=rowNode.parentElement;
    if (topNode === rowNode) {
      const children=Array.from(topNode.children), identityChild=children.find(c=>c.contains(identityLink)), rowChild=children.find(c=>c.contains(row));
      if (identityChild && rowChild) { topNode=identityChild; rowNode=rowChild; }
    }
    const range=document.createRange();
    try { range.setStartBefore(topNode); range.setEndBefore(rowNode); } catch { return { status:'AMBIGUOUS', diagnostics:['DOM Range boundary could not be created.'], boundary:{ viewport } }; }
    const fragment=range.cloneContents(); const box=document.createElement('article'); box.setAttribute('data-post-id',currentIdentity.postId); box.setAttribute('data-post-url',currentIdentity.canonicalUrl); box.append(fragment);
    if (!clean(box.textContent)) return { status:'AMBIGUOUS', diagnostics:['Extracted range is empty.'], boundary:{ viewport } };
    const boundaryLinks=Array.from(box.querySelectorAll('a[href]'));
    const author=boundaryLinks.find(a => !extractPost(a.href, location.href) && clean(a.textContent)) || null;
    const imageUrls=Array.from(box.querySelectorAll('img')).map(i=>i.currentSrc||i.src).filter(Boolean);
    const allUrls=boundaryLinks.map(a=>a.href).filter(Boolean);
    const rowText=clean(row.getAttribute('aria-label')+' '+row.textContent);
    const count = word => { const m=rowText.match(new RegExp('(\\\\d[\\\\d.,]*)\\\\s*(?:'+word+')|(?:'+word+')\\\\s*(\\\\d[\\\\d.,]*)','i')); const v=m && (m[1]||m[2]); return v ? Number(v.replace(/[^0-9]/g,'')) : null; };
    const parsed={ post_id:currentIdentity.postId, post_url:currentIdentity.canonicalUrl, author_name:author?clean(author.textContent):null, author_url:author?author.href:null, post_time:clean(identityLink.getAttribute('aria-label')||identityLink.getAttribute('title')||identityLink.textContent)||null, content:clean(box.textContent)||null, images:Array.from(new Set(imageUrls)), links:Array.from(new Set(allUrls)), reaction_count:count('like|thích|reaction|cảm xúc'), comment_count:count('comment|bình luận'), share_count:count('share|chia sẻ') };
    const meta=document.createElement('script'); meta.type='application/json'; meta.id='post-detail-parsed-json'; meta.textContent=JSON.stringify(parsed).replace(/</g,'\\\\u003c'); box.append(meta);
    const chain=[]; let n=row; while(n && chain.length<10){chain.push(describe(n));n=n.parentElement;}
    return { status:'FOUND', diagnostics, rawHtml:lca.outerHTML, extractedHtml:box.outerHTML, textPreview:clean(box.textContent), parsed, boundary:{ currentUrl:location.href, postId:currentIdentity.postId, frameId:input.frameId, frameIndex:input.frameIndex, screenshot:input.screenshot, viewport, hits:hits.map(h=>({type:h.type,screenshotBbox:h.screenshotBbox,cssPoint:h.cssPoint,match:describe(h.match),stack:h.stack})), row:describe(row), identity:describe(identityLink), ancestorChain:chain } };
  })()`;
}

export function normalizeExtractionResult(runId: string, value: Partial<PostDetailHtmlExtractionResult>): PostDetailHtmlExtractionResult {
  return {
    ok: value.status === "FOUND", status: value.status || "NOT_FOUND", runId,
    rawHtml: value.rawHtml || "", extractedHtml: value.extractedHtml || "", textPreview: value.textPreview || "",
    parsed: value.parsed || emptyParsed(), boundary: value.boundary || {}, diagnostics: value.diagnostics || [],
  };
}

/** Rebuild parsed JSON from the immutable HTML snapshot without BrowserCore or network access. */
export function parsePostDetailHtmlSnapshot(html: string): PostDetailParsedJson {
  const match = /<script[^>]+id=["']post-detail-parsed-json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return emptyParsed();
  try {
    return { ...emptyParsed(), ...(JSON.parse(match[1]) as Partial<PostDetailParsedJson>) };
  } catch {
    return emptyParsed();
  }
}

export function validateExpectedPostUrl(url: string): boolean {
  return Boolean(new FacebookPermalinkAdapter().extractPostIdentity(url));
}
