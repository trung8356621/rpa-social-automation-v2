import React, { useMemo, useState } from "react";
import { UiPopover } from "../ui-popover";
import { filterCollectors, activeRuleVersionLabel, duplicateCollector } from "../../shared/collectors/ops";
import type { CollectorDraft, CollectorListFilters, CollectorStatus, CollectorStrategy } from "../../shared/collectors/types";

type Props = {
  collectors: CollectorDraft[];
  locked: boolean;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onTest: (id: string) => void;
  onDuplicate: (draft: CollectorDraft) => void;
  onDelete: (id: string) => void;
};

function statusLabel(status: CollectorStatus): string {
  if (status === "ready") return "Ready";
  if (status === "outdated_validation") return "Validation outdated";
  return "Draft";
}

export function CollectorList({ collectors, locked, onCreate, onOpen, onTest, onDuplicate, onDelete }: Props) {
  const [filters, setFilters] = useState<CollectorListFilters>({ query: "", strategy: "", status: "" });
  const [confirmDelete, setConfirmDelete] = useState<CollectorDraft>();
  const filtered = useMemo(() => filterCollectors(collectors, filters), [collectors, filters]);
  const invalidCount = collectors.filter((c) => !c.name.trim()).length;

  return (
    <>
      <div className="page-heading">
        <small>RPA Social Automation V2 · Prototype</small>
        <h1>Collectors</h1>
        <p>
          Interactive UI prototype (mock data + localStorage only). Not included in Script Full Backup.
          No live Facebook extraction.
        </p>
      </div>

      <div className="scenario-toolbar collector-toolbar">
        <button className="primary" disabled={locked} onClick={onCreate}>+ Collector</button>
        <input
          aria-label="Search collectors"
          placeholder="Search name, classification, platform…"
          value={filters.query}
          disabled={locked}
          onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
        />
        <select
          aria-label="Filter strategy"
          value={filters.strategy}
          disabled={locked}
          onChange={(e) => setFilters((f) => ({ ...f, strategy: e.target.value as "" | CollectorStrategy }))}
        >
          <option value="">All strategies</option>
          <option value="FEED_NETWORK_JSON">FEED_NETWORK_JSON</option>
          <option value="POST_DETAIL_VISUAL">POST_DETAIL_VISUAL</option>
        </select>
        <select
          aria-label="Filter status"
          value={filters.status}
          disabled={locked}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as "" | CollectorStatus }))}
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="ready">Ready</option>
          <option value="outdated_validation">Validation outdated</option>
        </select>
      </div>

      {invalidCount > 0 && (
        <p className="collector-banner warn" role="status">
          {invalidCount} collector(s) are missing a required name.
        </p>
      )}

      {!collectors.length && (
        <div className="empty-tags-box" role="status">
          Chưa có Collector. Bấm <b>+ Collector</b> để tạo prototype đầu tiên.
        </div>
      )}

      {!!collectors.length && !filtered.length && (
        <div className="empty-tags-box" role="status">
          Không có Collector khớp bộ lọc hiện tại.
        </div>
      )}

      {!!filtered.length && (
        <div className="collector-table" role="table" aria-label="Collectors">
          <div className="collector-table-head" role="row">
            <span>Name</span>
            <span>Strategy</span>
            <span>Status</span>
            <span>Rule version</span>
            <span>Samples</span>
            <span>Last edited</span>
            <span>Actions</span>
          </div>
          {filtered.map((item) => {
            const sampleCount = item.samples.filter((s) => s.captureItemId).length;
            const captureCount = (item.captures ?? []).length;
            return (
              <div className="collector-table-row scenario-item" role="row" key={item.id}>
                <div className="scenario-title-cell">
                  <button className="scenario-title" disabled={locked} onClick={() => onOpen(item.id)} title={item.name}>
                    {item.name || "(unnamed)"}
                  </button>
                  <small>{item.classification}</small>
                </div>
                <small className="mono">{item.strategy || "strategy unset"}</small>
                <span className={`script-badge badge-${item.status === "ready" ? "active" : "draft"}`}>
                  {statusLabel(item.status)}
                </span>
                <small className="script-version">{activeRuleVersionLabel(item)}</small>
                <small title={`${captureCount} capture(s)`}>{sampleCount}/3 · {captureCount} cap</small>
                <small>{new Date(item.updatedAt).toLocaleString()}</small>
                <div className="collector-row-actions">
                  <button disabled={locked} onClick={() => onOpen(item.id)}>Open Editor</button>
                  <button disabled={locked} onClick={() => onTest(item.id)}>Test</button>
                  <button
                    disabled={locked}
                    onClick={() => onDuplicate(duplicateCollector(item))}
                  >
                    Duplicate
                  </button>
                  <button
                    className="delete-script-btn"
                    disabled={locked}
                    aria-label={`Delete ${item.name}`}
                    onClick={() => setConfirmDelete(item)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirmDelete && (
        <UiPopover variant="modal" label="Delete Collector" className="unsaved-confirm" close={() => setConfirmDelete(undefined)}>
          <div className="popover-heading">
            <b>Delete Collector?</b>
            <button onClick={() => setConfirmDelete(undefined)}>×</button>
          </div>
          <p>
            Xóa prototype <b>{confirmDelete.name}</b>? Dữ liệu localStorage của Collector này sẽ bị gỡ.
            Script Full Backup không bị ảnh hưởng.
          </p>
          <div className="popover-footer">
            <button onClick={() => setConfirmDelete(undefined)}>Hủy</button>
            <button
              className="primary"
              onClick={() => {
                onDelete(confirmDelete.id);
                setConfirmDelete(undefined);
              }}
            >
              Delete
            </button>
          </div>
        </UiPopover>
      )}
    </>
  );
}
