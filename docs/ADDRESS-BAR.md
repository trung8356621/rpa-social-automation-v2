# Address bar fix — 2026-10-19

Only the address bar and its IPC/navigation bridge changed. BrowserCore, Action Engine, browser geometry, zoom and session handling are unchanged.

- Main-frame `did-navigate` and `did-navigate-in-page` update the URL, including History API, hashes and history traversal. Subframe events are ignored.
- The initial snapshot cannot overwrite a newer navigation event. Unsent edits remain intact after blur/navigation; a successful explicit Open resumes synchronization. Failed Open leaves the draft intact. New edits made while Open is pending are preserved.
- Copy URL reads `webContents.getURL()` in main and writes it to the Windows clipboard; it does not copy an unsent draft.

Validation: typecheck, build and 24 unit tests passed. The real Electron address fixture passed 14 checks: initial/normal/link navigation, pushState, replaceState, Back/Forward, hash, subframe filtering, dirty draft after blur, native Copy URL button/Windows clipboard, manual Open, resumed synchronization and unchanged viewport/zoom. Test clipboard contents are preserved and restored when still owned by the test. `artifacts/browser-address.json` records results locally. The real Electron UX regression phase also passed all 16 checks, including crop/click mapping through maximize/fullscreen/restore at zoom 1 and 0.9 (`artifacts/browser-ux.json`). The initial test run clicked before the new page compositor was ready; the fixture driver now waits before native mouse events.

Run after build: `node scripts/browser-test.mjs address ux`.

Facebook has not been tested by the agent. Manual checks:

1. Open Facebook, navigate to a Group using Facebook UI and check the address bar matches the Group URL.
2. Navigate within Facebook and use Alt+Left / Alt+Right while the embedded browser is focused; check the URL follows the displayed page.
3. Type a different address without pressing Open, return to Facebook and navigate: the draft must stay intact. Click Copy URL, then paste into Notepad: it must be the actual Facebook URL, not the draft.
4. Press Open on the draft; after it loads, subsequent Facebook navigation should update the field again.
5. Confirm existing login, viewport and zoom remain unchanged. No Publish action is needed.
