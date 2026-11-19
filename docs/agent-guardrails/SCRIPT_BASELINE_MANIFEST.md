# Script Creator Baseline Manifest

**Captured:** 2026-11-19  
**Freeze companion:** [`SCRIPT_CREATOR_FREEZE.md`](./SCRIPT_CREATOR_FREEZE.md)  
**Content class:** Committed source inventory + observed test results (no credentials)

## 1. Git baseline

| Field | Verified value |
|-------|----------------|
| Toplevel | `D:\work-app\new\rpa-social-automation-v2` |
| Remote `origin` | `https://github.com/trung8356621/rpa-social-automation-v2.git` |
| Branch | `feature/collector-c1-ui-prototype` |
| HEAD | `3484efd5bf2bfac838935d6ffd2e419321be0834` |
| Subject | `Fix script sync v2` |
| Dirty state | **Clean** — no unstaged, staged, or untracked files at capture |
| `git diff --stat` | empty |
| `git diff --name-status` | empty |
| `git diff --cached --name-status` | empty |

### Recent commits (context only)

```
3484efd Fix script sync v2
d20f49a Fix script sync v1
da631da Fix script ok v1
5e06758 Fix script false v2
2c6f92f Fix script false v1
0b3952b script + tag auto sync v7
… (Collector / post-detail commits earlier on same branch)
```

### Uncommitted changes classification

None at freeze capture. If the tree becomes dirty later, classify each path as:

1. Script Creator / Publishing / Sync  
2. Shared BrowserCore / Runtime / Session  
3. Collector  
4. Unrelated / Unknown  

Mixed-responsibility files → treat as shared / protected until reviewed.

## 2. Accepted Script milestones

| Milestone (PO) | In-repo string verified 2026-11-19 |
|----------------|-------------------------------------|
| `mayhopphat.login` v1 | Yes — tests (`action-tag-url`, `start-url-and-blocked-recovery`, etc.) |
| `mayhopphat.create_post` v1 | **No** — string absent from committed source/tests/docs |
| `facebook.group.post` v2 | Yes — tests + release fixtures (`facebook.group.post` / placeholders) |

Release digests / remote SEO-OPS version numbers for the three milestones were **not** re-read from production or local `creator.sqlite` in this pass (would risk exposing local data / requires live app). Do not invent digests.

## 3. SQLite persistence (Script)

**Store path (runtime):** `<Electron userData>/creator.sqlite` (see `src/main/main.ts` Store construction).  
**Schema owner:** `src/main/storage.ts`

| Table | Role |
|-------|------|
| `settings` | Includes Script keys such as `currentFlow`, `testLab`, `scenarioOrganization`, `browserSessions`, `activeBrowserSessionId`, `zoom`, `activeScriptsByTag`, `seoOps*` |
| `flows` | Scenario / Script flow payloads |
| `steps` | Immutable step versions `(id, version)` |
| `overrides` | Step overrides |
| `runs` | Run payloads |
| `action_tags` | Action tag catalog + linkage metadata |

**Agents must not** migrate, truncate, or replace these tables for Collector work.

## 4. Protected file inventory

Classifications:

- `FROZEN_SCRIPT` — Script Creator / Test Lab / Publish-Sync path  
- `FROZEN_SHARED` — kernel shared by entire app; frozen for Collector agents  
- `SHARED_REVIEW_REQUIRED` — dual-use; PO review before edit  
- `COLLECTOR_OWNED` — safe Collector surface (if no frozen edits forced)  
- `UNKNOWN` — verify before edit  

Evidence root: imports from `src/main/main.ts`, `src/renderer/main.tsx`, `src/renderer/app-shell.tsx`, `src/preload/index.cts`, `src/shared/contracts.ts`.

### 4.1 FROZEN_SHARED

| Path | Notes |
|------|-------|
| `src/shared/contracts.ts` | Command / State / CreatorApi; Script + Collector |
| `src/preload/index.cts` | Sole preload bridge |
| `src/main/main.ts` | IPC command dispatch; Script + Collector |
| `src/renderer/main.tsx` | Hosts Creator + Collector pages |
| `src/shared/geometry.ts` | Viewport / coordinate constants |
| `src/shared/network-mode.ts` | Network mode for runtime + settings |

### 4.2 FROZEN_SCRIPT — Creator UI / steps / playback

| Path |
|------|
| `src/renderer/step-list.tsx` |
| `src/renderer/target-modal.tsx` |
| `src/renderer/flow-controls.tsx` |
| `src/renderer/draft.ts` |
| `src/renderer/workspace-tabs.tsx` |
| `src/renderer/playback.ts` |
| `src/renderer/app-shell.tsx` |
| `src/renderer/network-settings.tsx` |
| `src/renderer/completion-sound.ts` |
| `src/renderer/completion-sound-settings.tsx` |
| `src/renderer/action-tag-combobox.tsx` |
| `src/renderer/action-tags-refresh.ts` |
| `src/renderer/file-validation.tsx` |
| `src/renderer/script-health-panel.tsx` |
| `src/renderer/style.css` |
| `src/shared/playback.ts` |
| `src/shared/play-all-preflight.ts` |
| `src/shared/flow-model.ts` |
| `src/shared/flow-step-numbers.ts` |
| `src/shared/script-health.ts` |
| `src/shared/click-type-settle.ts` |
| `src/shared/error-navigation.ts` |
| `src/main/creator-overlays.ts` |
| `src/main/pointer-trace.ts` |
| `src/main/click-marker.ts` |
| `src/main/fixture.ts` |
| `src/main/fixture-ui.ts` |

### 4.3 FROZEN_SCRIPT — Test Lab / video demo / recording

| Path |
|------|
| `src/renderer/test-lab.tsx` |
| `src/renderer/browser-recording.ts` |
| `src/main/test-lab.ts` |
| `src/main/test-lab-start-nav.ts` |
| `src/main/test-run-evidence.ts` |
| `src/main/scenario-groups.ts` |
| `src/main/browser-recording.ts` |
| `src/main/script-demo-store.ts` |
| `src/shared/test-lab-view.ts` |
| `src/shared/test-lab-rerun-prep.ts` |
| `src/shared/video-demo.ts` |
| `src/shared/video-demo-policy.ts` |
| `src/shared/attach-demo-sync.ts` |

### 4.4 FROZEN_SCRIPT — Release / SEO-OPS sync

| Path |
|------|
| `src/renderer/seo-ops-panel.tsx` |
| `src/main/seo-ops-sync.ts` |
| `src/main/seo-ops-token-store.ts` |
| `src/main/seo-ops-backup-scheduler.ts` |
| `src/main/admin-backup.ts` |
| `src/main/package-zip.ts` |
| `src/shared/script-release.ts` |
| `src/shared/script-release-state.ts` |
| `src/shared/script-materialize.ts` |
| `src/shared/script-execution-canon.ts` |
| `src/shared/script-digest.ts` |
| `src/shared/script-sync.ts` |
| `src/shared/script-version.ts` |
| `src/shared/sync-status.ts` |
| `src/shared/sync-ipc.ts` |
| `src/shared/seo-ops-auth.ts` |
| `src/shared/seo-ops-http.ts` |
| `src/shared/seo-ops-metadata-gate.ts` |
| `src/shared/seo-ops-publish.ts` |
| `src/shared/action-tags.ts` |
| `src/shared/action-tag-url.ts` |
| `src/shared/start-url.ts` |

### 4.5 FROZEN_SCRIPT — Runtime / OCR / visual (Script execution)

| Path |
|------|
| `src/main/runtime.ts` |
| `src/main/target-resolver.ts` |
| `src/main/ocr.ts` |
| `src/main/ocr-candidates.ts` |
| `src/main/ocr-context.ts` |
| `src/main/ocr-match-scroll.ts` |
| `src/main/quick-tag.ts` |
| `src/main/upload-files.ts` |
| `src/main/file-chooser.ts` |
| `src/main/clipboard-guard.ts` |
| `src/main/preview-assets.ts` |
| `src/shared/ocr-target-draft.ts` |
| `src/shared/click-anchor.ts` |
| `src/shared/match-to.ts` |
| `src/shared/visual-environment.ts` |

### 4.6 FROZEN_SCRIPT — Browser sessions / Admin studio packaging

| Path |
|------|
| `src/renderer/browser-sessions.tsx` |
| `src/main/browser-sessions.ts` |
| `src/renderer/admin-studio.tsx` |
| `src/main/admin-v3.ts` |
| `src/main/admin-v3-store.ts` |
| `src/main/studio-workflows.ts` |
| `src/main/studio-packages.ts` |
| `src/main/runner-package.ts` |
| `src/shared/admin-v3.ts` |
| `src/shared/admin-v3-validation.ts` |
| `src/main/main-error-log.ts` |
| `src/renderer/web-dev-stub.ts` |
| `src/renderer/web-dev-bootstrap.ts` |

### 4.7 SHARED_REVIEW_REQUIRED

| Path | Why |
|------|-----|
| `src/main/storage.ts` | Owns all Script SQLite tables; Collector persists via Commands through main |
| `src/main/browser-core.ts` | Script Runtime + Collector capture / visual lab |
| `src/shared/collector-browser-host.ts` | Creator overlays + Collector browser host |
| `src/renderer/ui-popover.tsx` | Creator UI + Collector pages |
| `src/renderer/ui-zoom.ts` | Admin zoom shortcuts + Collector capture |
| `src/shared/browser-context-menu.ts` | Used by BrowserCore (Script + Collector) |
| `src/main/visual.ts` | Script target-resolver + Collector matchers |
| `src/main/end-visual-matcher.ts` | Collector IPC; shares `visual.ts` |
| `src/main/begin-layout-matcher.ts` | Collector IPC; shares `visual.ts` |
| `src/main/begin-block-matcher.ts` | Collector IPC; shares `visual.ts` |
| `src/shared/boundary-probe.ts` | Collector + contracts surface |
| `src/shared/permalink-rules.ts` | Collector + contracts |
| `src/shared/permalink-adapter.ts` | Collector + contracts |
| `src/shared/permalink-diagnostic.ts` | Collector + contracts |
| `src/shared/visual-match-lab-storage.ts` | Lab / post-detail / contracts |
| `src/renderer/components/BrowserWorkspace.tsx` | Shared BrowserCore host chrome |

### 4.8 COLLECTOR_OWNED (safe edit surface)

| Tree / path |
|-------------|
| `src/renderer/collectors/**` |
| `src/renderer/feed-item-collector/**` |
| `src/renderer/post-detail-collector/**` |
| `src/renderer/experiments/visual-match-lab/**` |
| `src/shared/collectors/**` |
| `src/shared/post-detail-collector/**` |
| `src/main/post-detail-storage.ts` |
| `src/main/post-detail-html-extractor.ts` |
| `src/main/post-detail-parent-probe.ts` |
| `src/main/post-detail-scan-lock.ts` |
| `src/main/engagement-auto-scroll.ts` |
| `src/main/engagement-capture-geometry.ts` |
| `src/main/engagement-slot-ocr.ts` |
| `src/main/collector-scroll-capture.ts` |
| `src/main/visual-match-lab.ts` |
| `src/main/visual-match-lab-storage.ts` |
| Matching `tests/collector-*.test.ts`, `tests/post-detail-*.test.ts`, `tests/feed-item-*.test.ts`, `tests/engagement-*.test.ts`, `tests/visual-match-lab-*.test.ts` |

**Constraint:** Collector edits must not require silent changes to FROZEN_* or unapproved SHARED_REVIEW_REQUIRED files. Prefer adapters inside COLLECTOR_OWNED trees. Extending `Command` in `contracts.ts` or branches in `main.ts` requires SHARED / FROZEN_SHARED impact review.

### 4.9 UNKNOWN

| Path | Note |
|------|------|
| `src/main/seo-ops-auto-sync.ts` | Not imported from `main.ts` at freeze time; verify before use/edit |
| `src/main/*-self-test.ts`, `src/main/self-test.ts` | QA harnesses; treat carefully |
| `experiments/visual-match-lab/electron/**` | Outside `src/`; not on Script release path |

## 5. Key file SHA-256 (committed working tree = HEAD, clean)

Computed read-only at freeze capture:

| SHA-256 | Path |
|---------|------|
| `5B092964F31E0CBFCCB88E2E2D0DA18DD4AD4733F3885DD17BCC5E9498525509` | `src/main/main.ts` |
| `3B6B46AF91DC0947137AFBF9F7B020F3EDD382AED24DA2FF353F5B1A87B0204B` | `src/main/storage.ts` |
| `595F2702DDD39FA1CC60F96D8ABB61861E09A0A7D66208A812528260489BC6C4` | `src/main/browser-core.ts` |
| `DDADDC8A10F499AE403C770B637E727CF2EBDD7FC530B75792E821682817D793` | `src/main/runtime.ts` |
| `36DBF9A7539EDEDAA3990EB1C24BF48ABBC187767E83475B364BB5D72BDC793A` | `src/main/seo-ops-sync.ts` |
| `9E9C443482B47CA2BB2B1693B3AAB0374E84CDCF0F3648217FAB1D9A9736808D` | `src/main/test-lab.ts` |
| `8F89BE8A537A75DBF7A8993B64165A43B5BC6D4F327B4A8851AF404E6B172EA0` | `src/main/browser-sessions.ts` |
| `FD87C9F039BF6E11AA4B68C7A56C8FA0BA95B9E10F06409AF3E3A7FE06C260E9` | `src/shared/contracts.ts` |
| `71AE1BFBF00C75A2CEFA0F9328027B8F5014092B80C3E684BCD731AE3B7C143F` | `src/shared/script-release.ts` |
| `CDA3C0CD4AB2A5EFE9F4BCF8851F20E50ADCF2377B7E8CF132F112F2F0AFB47E` | `src/shared/playback.ts` |
| `FEBB23045F2C6A79AB162C7EC408A4DE8EC8952ABD1AEE9D42CBFB9FD89A79A4` | `src/preload/index.cts` |
| `77F975CAF1D3BABF2D4C6C8F8660C9C513373A8771D6EB786D4E5A1CEB7AE82E` | `src/renderer/main.tsx` |
| `5039131D08FD5D5929722BBBE81CA067ABED205A841206B5BA4CAA17400A9B36` | `src/renderer/app-shell.tsx` |
| `ADBDE5D1D7C25019FBBFC1AEAB8EE33DEC88146A2109795E2F38D2CB4528A0D5` | `src/renderer/test-lab.tsx` |
| `5C8F426864DE2B14BF5C8859545EB1DAAB518C91B92AF2DA835B9B756D9482AD` | `package.json` |

## 6. Baseline tests

### npm scripts

| Script | Command | Notes |
|--------|---------|-------|
| `test` | `tsx --test tests/*.test.ts` | Top-level tests only |
| `test:browser` | build + `scripts/browser-test.mjs` | Real Electron — `REQUIRES_PO_MANUAL_ACCEPTANCE` / skip for agents |
| `typecheck` | `tsc` dual project | Non-destructive; not run in this freeze pass |

### Coverage map (relevant Script suites)

| Area | Example tests |
|------|----------------|
| Playback / Play All | `playback.test.ts`, `play-all-preflight-p0.test.ts`, `play-all-sequential-p0.test.ts`, `play-version-gate.test.ts` |
| Step versioning | `step-save-regression.test.ts`, `flow-model.test.ts`, `script-version.test.ts` |
| Visual / OCR | `auto-resolver.test.ts`, `ocr*.test.ts`, `click-anchor.test.ts` |
| Test Lab | `test-lab-view.test.ts`, `test-lab-start-nav.test.ts`, `test-lab-rerun-prep.test.ts`, `play-all-and-test-lab-p0.test.ts` |
| Video demo | `video-demo-policy.test.ts`, `attach-demo-sync.test.ts`, `demo-health-sync-decouple.test.ts`, `script-demo-link.test.ts` |
| Publish / sync / digest | `script-release*.test.ts`, `seo-ops-*.test.ts`, `sync-ipc.test.ts`, `sync-summary.test.ts`, `active-script-sync-seo-ops.test.ts` |

### Tests actually run (2026-11-19)

Command (non-destructive; temp SQLite / mocks only):

```text
npx tsx --test ^
  tests/playback.test.ts ^
  tests/play-all-preflight-p0.test.ts ^
  tests/test-lab-view.test.ts ^
  tests/test-lab-start-nav.test.ts ^
  tests/step-save-regression.test.ts ^
  tests/script-version.test.ts ^
  tests/script-release-state.test.ts ^
  tests/script-release.test.ts ^
  tests/video-demo-policy.test.ts ^
  tests/demo-health-sync-decouple.test.ts ^
  tests/attach-demo-sync.test.ts ^
  tests/seo-ops-auto-sync.test.ts ^
  tests/seo-ops-api-contract.test.ts ^
  tests/seo-ops-http.test.ts ^
  tests/sync-ipc.test.ts ^
  tests/sync-summary.test.ts ^
  tests/action-tag-url.test.ts ^
  tests/tag-scripts-placeholders.test.ts ^
  tests/play-version-gate.test.ts ^
  tests/auto-resolver.test.ts ^
  tests/start-url-and-blocked-recovery.test.ts
```

| Metric | Result |
|--------|--------|
| Tests | 127 |
| Pass | 126 |
| Fail | 1 |
| Duration | ~7.4s |

**Failure observed:**

- File: `tests/sync-summary.test.ts`  
- Case: `valid isolated v1 publishes to an empty catalog and second sync is idempotent`  
- Assertion: after publishing changed v2, a fourth `syncAll()` expected `published === 0` / `unchanged === 1`; observed `published === 1` (AssertionError `1 !== 0`).  
- Isolation: temp dir SQLite + mocked `fetch` — **did not** touch accepted userData DB.  
- Action at freeze: **documented only** — no Script source fix (out of scope).

### Not run / gaps

| Item | Status |
|------|--------|
| Full `npm test` (all top-level suites) | Not run |
| P0 sequential / Test Lab integration suites beyond subset | Not run this pass (`REQUIRES_PO_MANUAL_ACCEPTANCE` for product sign-off; temp DB still safe) |
| `ocr.test.ts` (Tesseract) | Skipped (slow; non-destructive but not executed) |
| `npm run test:browser` | Skipped — Electron GUI |
| Live SEO-OPS authenticated publish/pull | Not run — credentials / production side effects |
| Local accepted Script record integrity | Not inspected (avoid sensitive local data) |
| `mayhopphat.create_post` fixture coverage | Missing in repo |

## 7. Collector development boundary (summary)

**Safe without PO exception (typical):** files under §4.8 `COLLECTOR_OWNED`, plus new Collector-only tests/docs that do not alter frozen paths.

**Stop and escalate:** any edit to §4.1–4.7, any SQLite migration, any change to Script release digest behavior, any BrowserCore session/viewport semantics change, any IPC contract change that alters Script commands.

## 8. Protection artifacts

| Artifact | Path |
|----------|------|
| Freeze policy | `docs/agent-guardrails/SCRIPT_CREATOR_FREEZE.md` |
| This manifest | `docs/agent-guardrails/SCRIPT_BASELINE_MANIFEST.md` |
| Cursor rule | `.cursor/rules/script-creator-frozen.mdc` |
