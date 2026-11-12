/**
 * Pure BrowserCore context-menu spec (no Electron import, unit-testable).
 * Main process maps these ids to webContents/clipboard actions.
 * Link URL is always taken from Electron context-menu params.linkURL —
 * never inferred from mouse position.
 */
export type BrowserContextMenuActionId =
  | "copy-link"
  | "copy"
  | "cut"
  | "paste"
  | "select-all"
  | "back"
  | "forward"
  | "reload";

export type BrowserContextMenuItem =
  | { type: "action"; id: BrowserContextMenuActionId; label: string; enabled: boolean }
  | { type: "separator" };

export interface BrowserContextMenuInput {
  linkURL?: string;
  selectionText?: string;
  isEditable?: boolean;
  editFlags?: { canCopy?: boolean; canCut?: boolean; canPaste?: boolean; canSelectAll?: boolean };
}

/** Only absolute HTTP(S) links are offered for "Copy link address". */
export function isCopyableLinkUrl(url: string | undefined | null): url is string {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function buildBrowserContextMenuSpec(
  params: BrowserContextMenuInput,
  nav: { canGoBack: boolean; canGoForward: boolean },
): BrowserContextMenuItem[] {
  const groups: BrowserContextMenuItem[][] = [];
  const flags = params.editFlags ?? {};

  if (isCopyableLinkUrl(params.linkURL)) {
    groups.push([{ type: "action", id: "copy-link", label: "Copy link address", enabled: true }]);
  }

  const edit: BrowserContextMenuItem[] = [];
  if (params.isEditable) {
    edit.push({ type: "action", id: "cut", label: "Cut", enabled: Boolean(flags.canCut) });
    edit.push({ type: "action", id: "copy", label: "Copy", enabled: Boolean(flags.canCopy) });
    edit.push({ type: "action", id: "paste", label: "Paste", enabled: Boolean(flags.canPaste) });
    edit.push({ type: "action", id: "select-all", label: "Select all", enabled: flags.canSelectAll !== false });
  } else if ((params.selectionText ?? "").trim()) {
    edit.push({ type: "action", id: "copy", label: "Copy", enabled: flags.canCopy !== false });
  }
  if (edit.length) groups.push(edit);

  groups.push([
    { type: "action", id: "back", label: "Back", enabled: nav.canGoBack },
    { type: "action", id: "forward", label: "Forward", enabled: nav.canGoForward },
    { type: "action", id: "reload", label: "Reload", enabled: true },
  ]);

  const out: BrowserContextMenuItem[] = [];
  groups.forEach((g, i) => {
    if (i > 0) out.push({ type: "separator" });
    out.push(...g);
  });
  return out;
}
