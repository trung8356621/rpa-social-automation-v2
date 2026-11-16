import React from "react";

export interface BrowserWorkspaceProps {
  className?: string;
  children: React.ReactNode;
}

export function BrowserWorkspace({ className = "", children }: BrowserWorkspaceProps) {
  return (
    <div className={`rpa-browser-workspace${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

export interface BrowserScrollAreaProps {
  sidebarCollapsed?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function BrowserScrollArea({
  sidebarCollapsed = false,
  className = "",
  children,
}: BrowserScrollAreaProps) {
  return (
    <div
      className={`rpa-browser-scroll${sidebarCollapsed ? " is-sidebar-collapsed" : ""}${className ? ` ${className}` : ""}`}
    >
      {children}
    </div>
  );
}

export interface BrowserHostProps extends React.HTMLAttributes<HTMLDivElement> {
  hostRef?: React.Ref<HTMLDivElement>;
}

export const BrowserHost = React.forwardRef<HTMLDivElement, BrowserHostProps>(
  function BrowserHost({ hostRef, className = "", children, ...rest }, forwardedRef) {
    const ref = hostRef ?? forwardedRef;
    return (
      <div
        ref={ref}
        className={`rpa-browser-host${className ? ` ${className}` : ""}`}
        data-browser-core-host=""
        {...rest}
      >
        {children}
      </div>
    );
  },
);

export interface SidebarDrawerProps {
  title?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  className?: string;
  children: React.ReactNode;
}

export function SidebarDrawer({
  title = "Panel",
  collapsed,
  onToggleCollapse,
  className = "",
  children,
}: SidebarDrawerProps) {
  return (
    <div
      className={`rpa-browser-sidebar${collapsed ? " is-collapsed" : " is-open"}${className ? ` ${className}` : ""}`}
      data-browser-sidebar-drawer={collapsed ? "collapsed" : "expanded"}
    >
      {collapsed ? (
        <button
          type="button"
          className="rpa-browser-sidebar-tab"
          onClick={onToggleCollapse}
          aria-label={`Expand ${title}`}
          title={`Expand ${title}`}
        >
          <span>◀</span>
          <span className="rpa-browser-sidebar-tab-label">{title}</span>
        </button>
      ) : (
        <>
          <div className="rpa-browser-sidebar-header">
            <span className="rpa-browser-sidebar-title">{title}</span>
            <button
              type="button"
              className="rpa-browser-sidebar-toggle"
              onClick={onToggleCollapse}
              aria-label={`Collapse ${title}`}
              title={`Collapse ${title}`}
            >
              ▶
            </button>
          </div>
          <div className="rpa-browser-sidebar-body">{children}</div>
        </>
      )}
    </div>
  );
}
