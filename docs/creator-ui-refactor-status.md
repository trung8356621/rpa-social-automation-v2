# Creator UX refactor: overlay gate (2026-10-19)

Branch: `feature/creator-ui-refactor`, based on `ae262df` (main was fetched and already current). No merge into main. The pre-existing untracked `rpa-social-automation-v2/` directory is untouched.

## Current status

Step 1 is INCOMPLETE. Step 2 has NOT started. Normal startup still uses the existing Creator UI and POC runtime. Native overlay views are constructed only for the explicit `overlay` fixture phase. No action, target resolver, storage/version/Override, session, upload or clipboard implementation has changed.

The initial geometry-only proof passed but was insufficient: Electron input injection bypasses native OS hit-testing, and BrowserWindow.capturePage omits sibling WebContentsViews. The strengthened proof now requires OS clicks into each panel and the uncovered browser, stable bounds/zoom/navigation/focus while toggling, and a nonempty desktop compositor screenshot. Never treat the initial geometry-only pass as approval to proceed.

In this execution session Windows SetCursorPos and GetCursorPos return false, and desktopCapturer returns an empty thumbnail. The strengthened test exits nonzero and writes an incomplete report. This establishes an environment limitation; it does not establish that the overlay works or that it is defective. No valid screenshot of a new UI is available.

## Resume overlay verification

Use an unlocked interactive Windows desktop with this repository checked out on the feature branch. Close any other test instance. The test moves the OS pointer briefly; leave input idle while it runs.

```powershell
Set-Location D:\workspace-2026\rpa\new
npm run build
node scripts/browser-test.mjs overlay
```

Review `artifacts/browser-overlay.json`, `artifacts/failure-overlay.txt` on failure, and `artifacts/overlay-proof.png` only after a fresh successful run. The latter is a desktop screenshot and may include other visible windows; inspect before sharing. These artifacts remain local and ignored by Git.

Before moving to Step 2, finish the native panel proof with real collapse controls, confirm collapse does not unnecessarily steal browser focus, verify pointer routing throughout uncovered browser regions, and repeat at flow zooms 100/90/80%, normal/fullscreen/restore. The current prototype has placeholder panel content, not the refactored Step Editor or Test & Debug controls.

## Facebook Group manual acceptance after the UI refactor

This checklist is for the later completed UI, not a claim of Facebook verification now.

1. Start with `npm start`, sign in manually, open the test Group URL. Verify the live URL/copy URL, flow zoom and local session after restart.
2. Create a flow. Crop the visible create-post target, confirm OCR explicitly where applicable, save CLICK_TARGET, test, observe the actual click, then mark correct/incorrect.
3. With the composer open, crop the input target and test CLICK_AND_TYPE with Vietnamese accents, emoji and line breaks; test keyboard and clipboard methods. Confirm draft text and caret behavior. Do not click Publish.
4. Crop the Photo/Video target, choose local image(s), save UPLOAD_FILE and test. Confirm every real thumbnail has loaded before marking correct. Confirm no automatic Publish occurs.
5. Switch steps, test saved payloads, reject a result and Redesign. Confirm a new Base version retains the old one, version pinning works and an Override remains separate from Base.
6. Exercise TYPE_ONLY from browser focus via Ctrl+Shift+T, SCROLL, WAIT_VERIFY, cancel/escape ROI capture and reopen it. Confirm no editor focus causes unintended typing.
7. Open/collapse both panels before and after capture/test, and fullscreen/restore. Compare browser viewport 1024 x 560 DIP, zoom, page state, target coordinates and uncovered pointer interaction throughout.
8. Record the commit hash, flow zoom, actions tested and observed results. Facebook acceptance requires the user's actual confirmation.

## Validation in this session

- Typecheck and build passed; 24/24 unit tests passed.
- Existing Electron phases: first 27 passed / 2 pending, second 3, ux 16, ocr 8, typing 13, upload 8, address 14 passed (89 passing checks total). The first phase is partial, including hidden-view screenshot timeout; Facebook remains untested.
- Strengthened overlay phase: incomplete/nonzero because SetCursorPos failed on the input desktop. No UI refactor acceptance is implied.
