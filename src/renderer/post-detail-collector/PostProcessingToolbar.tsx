import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

export interface PostProcessingToolbarAction {
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  tone?: "primary" | "secondary" | "warn";
  title?: string;
}

export interface PostProcessingToolbarConfig {
  statusLabel: string;
  statusTone: "live" | "frozen" | "warn";
  statusTitle?: string;
  primaryAction: PostProcessingToolbarAction;
  directActions: PostProcessingToolbarAction[];
  moreActions?: PostProcessingToolbarAction[];
  badge?: { label: string; title?: string };
}

interface ToolbarStore {
  getSnapshot: () => PostProcessingToolbarConfig | null;
  setConfig: (config: PostProcessingToolbarConfig | null) => void;
  subscribe: (listener: () => void) => () => void;
}

function sameActions(a: PostProcessingToolbarAction[] | undefined, b: PostProcessingToolbarAction[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.label !== y.label ||
      x.disabled !== y.disabled ||
      x.active !== y.active ||
      x.tone !== y.tone ||
      x.title !== y.title
    ) {
      return false;
    }
  }
  return true;
}

function sameToolbarConfig(a: PostProcessingToolbarConfig | null, b: PostProcessingToolbarConfig | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.statusLabel === b.statusLabel &&
    a.statusTone === b.statusTone &&
    a.statusTitle === b.statusTitle &&
    a.badge?.label === b.badge?.label &&
    a.badge?.title === b.badge?.title &&
    sameActions([a.primaryAction], [b.primaryAction]) &&
    sameActions(a.directActions, b.directActions) &&
    sameActions(a.moreActions, b.moreActions)
  );
}

function createToolbarStore(): ToolbarStore {
  let current: PostProcessingToolbarConfig | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    setConfig: (config) => {
      const changed = !sameToolbarConfig(current, config);
      current = config;
      if (changed) {
        for (const listener of listeners) listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const PostProcessingToolbarContext = createContext<ToolbarStore | null>(null);

export function PostProcessingToolbarProvider({ children }: { children: React.ReactNode }) {
  const store = useMemo(() => createToolbarStore(), []);
  return (
    <PostProcessingToolbarContext.Provider value={store}>
      {children}
    </PostProcessingToolbarContext.Provider>
  );
}

/**
 * Registers the active substep's toolbar actions/status with the shared
 * PostProcessingToolbar without causing PostDetailCollectorPage or BrowserHost to remount.
 */
export function usePostProcessingToolbar(config: PostProcessingToolbarConfig | null) {
  const store = useContext(PostProcessingToolbarContext);
  useEffect(() => {
    if (!store) return;
    store.setConfig(config);
  });
  useEffect(() => {
    if (!store) return;
    return () => store.setConfig(null);
  }, [store]);
}

function actionClassName(action: PostProcessingToolbarAction): string {
  const toneClass =
    action.tone === "primary"
      ? "pdc-btn-primary"
      : action.tone === "warn"
        ? "pdc-btn-warn"
        : "pdc-btn-secondary";
  return `pdc-btn ${toneClass} pdc-btn-compact ${action.active ? "active" : ""}`.trim();
}

export interface PostProcessingToolbarProps {
  processingSubstep: 1 | 2 | 3;
  step2Ready: boolean;
  onSelectSubstep: (substep: 1 | 2 | 3) => void;
}

export function PostProcessingToolbar({
  processingSubstep,
  step2Ready,
  onSelectSubstep,
}: PostProcessingToolbarProps) {
  const store = useContext(PostProcessingToolbarContext);
  const config = useSyncExternalStore(
    store ? store.subscribe : () => () => {},
    store ? store.getSnapshot : () => null,
    () => null,
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMoreOpen(false);
  }, [processingSubstep]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  const moreActions = config?.moreActions?.filter(Boolean) ?? [];

  return (
    <div className="pdc-unified-toolbar" role="toolbar" aria-label="Post Processing Navigation and Actions">
      <nav className="pdc-unified-substeps" aria-label="Post processing substeps">
        <button
          type="button"
          className={`pdc-unified-tab ${processingSubstep === 1 ? "active" : ""}`}
          onClick={() => onSelectSubstep(1)}
        >
          1 Capture
        </button>
        <button
          type="button"
          className={`pdc-unified-tab ${processingSubstep === 2 ? "active" : ""}`}
          disabled={!step2Ready}
          onClick={() => onSelectSubstep(2)}
        >
          2 Visual Region
        </button>
        <button
          type="button"
          className={`pdc-unified-tab ${processingSubstep === 3 ? "active" : ""}`}
          title="Parent HTML semantic review"
          onClick={() => onSelectSubstep(3)}
        >
          3 Extracted Data
        </button>
      </nav>

      {config && (
        <>
          <span className="pdc-unified-divider" aria-hidden />
          <div className="pdc-unified-actions">
            <span
              className={`pdc-mode pdc-unified-status ${config.statusTone}`}
              role="status"
              title={config.statusTitle}
            >
              {config.statusLabel}
            </span>

            {config.badge && (
              <span className="pdc-input-lock-badge" title={config.badge.title}>
                {config.badge.label}
              </span>
            )}

            <button
              type="button"
              className={actionClassName(config.primaryAction)}
              disabled={config.primaryAction.disabled}
              title={config.primaryAction.title}
              onClick={config.primaryAction.onClick}
            >
              {config.primaryAction.label}
            </button>

            {config.directActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className={actionClassName(action)}
                disabled={action.disabled}
                title={action.title}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}

            {moreActions.length > 0 && (
              <div className="pdc-unified-more" ref={moreRef}>
                <button
                  type="button"
                  className={`pdc-btn pdc-btn-secondary pdc-btn-compact ${moreOpen ? "active" : ""}`}
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((v) => !v)}
                >
                  More ▾
                </button>
                {moreOpen && (
                  <div className="pdc-unified-more-menu" role="menu">
                    {moreActions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        role="menuitem"
                        className={`pdc-unified-more-item ${action.active ? "active" : ""}`}
                        disabled={action.disabled}
                        title={action.title}
                        onClick={() => {
                          setMoreOpen(false);
                          action.onClick();
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
