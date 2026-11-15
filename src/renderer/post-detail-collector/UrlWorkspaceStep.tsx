import React, { useEffect, useMemo, useRef, useState } from "react";
import { collectorReportBrowserHost, collectorSetBrowserVisible, isElectronBrowserCoreAvailable } from "../collectors/browser-capture";
import { claimCollectorHostOwner, isCollectorHostOwner, releaseCollectorHostOwner } from "../collectors/collector-host-owner";
import { publishPostDetailBrowserHost } from "./publish-browser-host";
import { extractWorkspaceIdentity, mergeUrlWorkspace, stableUrlId } from "./url-workspace";
import type { Invoke, PostDetailUrlItem, PostDetailUrlStatus } from "./types";

type Filter = "ALL" | PostDetailUrlStatus;

export function UrlWorkspaceStep({ invoke, items, selectedId, onChange, onSelect }: {
  invoke: Invoke; text: string; items: PostDetailUrlItem[]; selectedId: string | null;
  onChange: (text: string, items: PostDetailUrlItem[]) => void; onSelect: (item: PostDetailUrlItem) => void;
}) {
  const [substep, setSubstep] = useState<"ADD" | "LIBRARY">(items.length ? "LIBRARY" : "ADD");
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<Filter>("ALL");
  const hostRef = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => extractWorkspaceIdentity(draft), [draft]);
  const filtered = filter === "ALL" ? items : items.filter(item => item.status === filter);

  useEffect(() => {
    if (substep !== "ADD" || !isElectronBrowserCoreAvailable()) return;
    const { ownerId } = claimCollectorHostOwner("pdc-url-workspace");
    const publish = () => { if (isCollectorHostOwner(ownerId)) publishPostDetailBrowserHost(invoke, hostRef.current); };
    publish();
    const raf = requestAnimationFrame(() => requestAnimationFrame(publish));
    const observer = new ResizeObserver(publish);
    if (hostRef.current) observer.observe(hostRef.current);
    window.addEventListener("resize", publish);
    void collectorSetBrowserVisible(invoke, true).then(publish);
    return () => {
      cancelAnimationFrame(raf); observer.disconnect(); window.removeEventListener("resize", publish);
      releaseCollectorHostOwner(ownerId, () => { void collectorReportBrowserHost(invoke, null); void collectorSetBrowserVisible(invoke, false); });
    };
  }, [invoke, substep]);

  const persist = (next: PostDetailUrlItem[]) => onChange(next.map(item => item.originalUrl).join("\n"), next);
  const addPost = () => {
    if (!parsed.valid || !parsed.postId) { setMessage(parsed.error || "A supported post URL with a stable Post ID is required."); return; }
    const existing = items.find(item => item.id === stableUrlId(draft));
    if (existing) { setMessage("Post already added"); return; }
    persist(mergeUrlWorkspace([...items.map(item => item.originalUrl), draft.trim()].join("\n"), items));
    setDraft(""); setMessage("Post added");
  };
  const remove = (id: string) => persist(items.filter(item => item.id !== id));
  const openPost = async (item: PostDetailUrlItem) => {
    setMessage(`Opening Post #${item.postId || "unknown"} in BrowserCore…`);
    await invoke({ type: "postDetailNavigate", url: item.originalUrl });
  };

  return <div className="pdc-url-workspace">
    <nav className="pdc-workspace-substeps" aria-label="URL Workspace substeps">
      <button type="button" className={substep === "ADD" ? "active" : ""} onClick={() => setSubstep("ADD")}>1.1 Add URLs</button>
      <button type="button" className={substep === "LIBRARY" ? "active" : ""} onClick={() => setSubstep("LIBRARY")}>1.2 Post Library <span>{items.length}</span></button>
    </nav>
    {substep === "ADD" && <div className="pdc-add-url-layout">
      <section className="pdc-browser-panel"><header><div><h2>Browse posts</h2><p>Use the existing BrowserCore session. Right-click a post link and choose Copy link address.</p></div></header><div ref={hostRef} className="collector-browser-host pdc-workspace-browser-host">{!isElectronBrowserCoreAvailable() && <div className="pdc-empty-state">BrowserCore is available in Electron only.</div>}</div></section>
      <section className="pdc-add-panel"><div><span className="pdc-eyebrow">COLLECT POST URLS</span><h2>Add a post</h2><p>Paste a Facebook or Threads post link. Pasting does not navigate BrowserCore.</p></div>
        <form onSubmit={event => { event.preventDefault(); addPost(); }}><label htmlFor="pdc-add-url">Post URL</label><input id="pdc-add-url" className="pdc-url-input" value={draft} onChange={event => { setDraft(event.target.value); setMessage(""); }} placeholder="Paste post URL…" />
          {draft && <div className={`pdc-url-analysis ${parsed.valid ? "valid" : "invalid"}`}><strong>{parsed.valid ? "Recognized post" : "Invalid URL"}</strong><span>Platform: {parsed.platform || "—"}</span><span>Group: {parsed.groupSlug || parsed.groupId || "—"}</span><span>Post ID: {parsed.postId || "—"}</span>{!parsed.valid && <span>{parsed.error}</span>}</div>}
          <button type="submit" className="pdc-primary-button" disabled={!parsed.valid}>Add Post</button></form>
        {message && <div className="pdc-inline-message" role="status">{message}</div>}
        <div className="pdc-collected-summary"><strong>{items.length}</strong><span>posts collected</span><button type="button" onClick={() => setSubstep("LIBRARY")}>View library</button></div>
      </section>
    </div>}
    {substep === "LIBRARY" && <section className="pdc-library"><header className="pdc-library-header"><div><span className="pdc-eyebrow">POST LIBRARY</span><h2>Your posts</h2><p>Select a card to Auto Match and open Extracted Data Review.</p></div><button type="button" className="pdc-primary-button" onClick={() => setSubstep("ADD")}>+ Add URLs</button></header>
      <div className="pdc-library-filters">{(["ALL", "PENDING", "READY", "NEEDS_ATTENTION", "FAILED"] as Filter[]).map(value => <button type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>{value === "ALL" ? "All" : value.replace("_", " ")}</button>)}</div>
      {!filtered.length ? <div className="pdc-empty-state"><h3>{items.length ? "No posts match this filter" : "No posts yet"}</h3><p>Add a Facebook or Threads URL to build your library.</p><button type="button" onClick={() => setSubstep("ADD")}>Add your first post</button></div> : <div className="pdc-post-grid">{filtered.map(item => <article className={`pdc-post-card ${item.id === selectedId ? "selected" : ""}`} key={item.id} onClick={() => onSelect(item)}>
        <header><span className={`pdc-platform ${item.platform}`}>{item.platform === "threads" ? "Threads" : "Facebook"}</span><span className={`pdc-post-status status-${item.status.toLowerCase()}`}>{item.status.replace("_", " ")}</span></header>
        <div><span className="pdc-card-label">{item.groupSlug || item.groupId || "Post"}</span><h3 title={item.postId || ""}>#{item.postId && item.postId.length > 16 ? `${item.postId.slice(0, 8)}…${item.postId.slice(-6)}` : item.postId}</h3></div>
        <div className="pdc-card-progress"><span>Parent {item.strategyId ? "strategy available" : "not matched"}</span><span>Engagement {item.engagementAnchorsVerified ? "verified" : "needs attention"}</span></div>
        <footer><button type="button" className="pdc-primary-button" onClick={event => { event.stopPropagation(); onSelect(item); }}>{item.status === "READY" ? "Review" : "Auto Match"}</button><button type="button" onClick={event => { event.stopPropagation(); void openPost(item); }}>Open Post</button><button type="button" onClick={event => { event.stopPropagation(); void navigator.clipboard.writeText(item.canonicalUrl || item.originalUrl); }}>Copy Link</button><button type="button" className="danger" onClick={event => { event.stopPropagation(); remove(item.id); }}>Remove</button></footer>
      </article>)}</div>}
    </section>}
  </div>;
}
