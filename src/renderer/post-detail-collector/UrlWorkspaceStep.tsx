import React, { useMemo, useState } from "react";
import { mergeUrlWorkspace } from "./url-workspace";
import type { PostDetailUrlItem } from "./types";

export function UrlWorkspaceStep({ text, items, selectedId, onChange, onSelect }: {
  text: string;
  items: PostDetailUrlItem[];
  selectedId: string | null;
  onChange: (text: string, items: PostDetailUrlItem[]) => void;
  onSelect: (item: PostDetailUrlItem) => void;
}) {
  const [draft, setDraft] = useState(text);
  const parsed = useMemo(() => mergeUrlWorkspace(draft, items), [draft, items]);
  const apply = () => onChange(draft, parsed);
  const remove = (id: string) => {
    const kept = items.filter(item => item.id !== id);
    onChange(kept.map(item => item.originalUrl).join("\n"), kept);
  };
  return <div className="pdc-url-workspace">
    <section className="pdc-card">
      <h2>URL Workspace</h2>
      <p>Paste one Facebook or Threads post URL per line. Post ID is the stable identity; tracking parameters are retained only in the original URL.</p>
      <textarea rows={7} value={draft} onChange={event => setDraft(event.target.value)} placeholder="https://www.facebook.com/.../posts/..." />
      <button type="button" className="pdc-primary-button" onClick={apply}>Update URL list</button>
    </section>
    <section className="pdc-card">
      <h3>Posts ({items.length})</h3>
      <div className="pdc-url-list">
        {items.map(item => <div className={`pdc-url-row ${item.id === selectedId ? "active" : ""}`} key={item.id}>
          <button type="button" className="pdc-url-select" onClick={() => onSelect(item)}>
            <strong>{item.postId ? `Post #${item.postId}` : item.originalUrl}</strong>
            <span>{item.platform || "invalid"} · {item.status}</span>
          </button>
          <button type="button" onClick={() => remove(item.id)} aria-label={`Remove ${item.postId || item.originalUrl}`}>Remove</button>
        </div>)}
      </div>
    </section>
  </div>;
}
