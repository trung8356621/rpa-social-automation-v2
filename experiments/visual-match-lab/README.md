# Visual Match Lab — Live DOM

The lab uses an Electron `WebContentsView` beside the React diagnostics UI. By default it opens the same persistent partition used by the Creator default browser session (`persist:creator-default`). It does not use Playwright.

From the repository root, start Vite and Electron together:

```powershell
npm run lab
```

`Static Image` is the default and renders the retained Stage A–E component. `Live Browser` reveals the persistent Electron browser beside the diagnostics UI.

For a named Creator session, pass its exact partition and optional start URL:

```powershell
npm run lab -- --partition=persist:rpa-session-<session-uuid> --url=https://www.facebook.com/
```

Workflow: capture the current viewport, choose an icon crop, detect candidates, click a candidate in the screenshot/table, then inspect or highlight its live DOM element. Scroll always captures a new frame and invalidates previous coordinates. `Test Click` requires confirmation for every action; Like/Share requires typing `CONFIRM PUBLIC ACTION`. Prefer menu/open/neutral targets for verification.

The JSON report keeps visual score, identified element, clickable ancestor, post/comment context, and before/after capture IDs separate. A visual-only candidate remains `VISUAL_ONLY` and is not a pass.
