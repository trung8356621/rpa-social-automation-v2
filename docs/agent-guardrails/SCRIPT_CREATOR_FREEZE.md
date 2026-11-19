# Script Creator Freeze

**Status:** FROZEN — Collector development may proceed only outside protected surfaces  
**Freeze date:** 2026-11-19  
**Role of this document:** Agent / Product Owner protection contract (not a filesystem lock)

## Accepted milestones (Product Owner)

Completed workflow:

`Script Creator → Script Steps → Play All → Test Lab → Video Demo → Auto Sync → SEO-OPS Script Registry`

Accepted published Script milestones (PO-declared; treat as completed):

| Action tag / Script key | Declared release |
|-------------------------|------------------|
| `mayhopphat.login` | v1 |
| `mayhopphat.create_post` | v1 |
| `facebook.group.post` | v2 |

**Source verification note (2026-11-19):** Repository source and tests reference `mayhopphat.login` and `facebook.group.post`. The string `mayhopphat.create_post` was **not found** in committed source/tests/docs at freeze time. Treat the milestone as PO-accepted product state (likely local SQLite / SEO-OPS registry), not as a verified in-repo fixture name.

Do not reopen previously resolved Script Creator / Publish / Sync problems without explicit Product Owner authorization.

## Git baseline (verified 2026-11-19)

| Field | Value |
|-------|--------|
| Repository | `D:\work-app\new\rpa-social-automation-v2` |
| Remote | `https://github.com/trung8356621/rpa-social-automation-v2.git` |
| Branch | `feature/collector-c1-ui-prototype` |
| HEAD | `3484efd5bf2bfac838935d6ffd2e419321be0834` |
| HEAD subject | `Fix script sync v2` |
| HEAD author date | `2026-11-19 11:05:54 +0700` |
| Working tree | **Clean** (`git status --short` empty; no staged/unstaged/untracked at freeze capture) |

**Important:** HEAD is on a Collector-named feature branch that also contains completed Script sync work. Clean working tree means committed HEAD **is** the freeze snapshot for source. Local accepted Script **data** lives outside Git (Electron `userData` / `creator.sqlite`) and must not be migrated, wiped, or overwritten by agents.

Companion inventory: [`SCRIPT_BASELINE_MANIFEST.md`](./SCRIPT_BASELINE_MANIFEST.md)

## Protected modules (functional)

These areas must remain functionally unchanged during Collector development:

1. Script Creator and Scenario / Step Editor  
2. Step versioning and saved step definitions  
3. Flow playback and Play All sequential execution  
4. Visual / OCR recognition used by Scripts  
5. Script Test Lab  
6. Test video recording and demo selection  
7. Script publishing and release management  
8. Script synchronization to SEO-OPS  
9. Release version / digest validation  
10. Existing Script database records (`flows`, `steps`, `overrides`, `runs`, `action_tags`, Script-related `settings`)  
11. Shared BrowserCore, Browser Session ownership and switching  
12. Browser navigation, viewport, screenshot coordinate mapping and zoom (Script path)

Exact file paths and classifications: see `SCRIPT_BASELINE_MANIFEST.md`.

## Forbidden modifications (agents)

Without explicit Product Owner approval in the active task:

- Do **not** modify FROZEN_SCRIPT or FROZEN_SHARED application source for Collector work.  
- Do **not** change Script SQLite schema, migrations, or wipe/reset accepted Script records.  
- Do **not** alter Script release / digest / SEO-OPS sync contracts or publish body shape.  
- Do **not** change BrowserCore session ownership, viewport/zoom/coordinate mapping behavior relied on by Scripts.  
- Do **not** control Cursor / Electron GUI via mouse-keyboard automation for this freeze task or Collector work unless PO explicitly authorizes.  
- Do **not** run `git reset` / `git clean` / `git stash` / discard / force-checkout that drops user changes.  
- Do **not** auto-commit, auto-push, deploy, or modify another repository.  
- Do **not** create extra worktrees or switch branches as part of “cleanup.”  
- Do **not** rebuild or rewrite working Script Creator functionality “while touching Collector.”

## Shared dependency policy

| Classification | Policy |
|----------------|--------|
| `FROZEN_SCRIPT` | Do not modify. Collector must use adapters / isolated modules instead. |
| `FROZEN_SHARED` | Platform kernel (`contracts`, preload, `main.ts`, `main.tsx`, geometry, network-mode). Inspect read-only. Any edit requires PO impact review + Script regression. |
| `SHARED_REVIEW_REQUIRED` | Dual-use (e.g. `storage.ts`, `browser-core.ts`, `ui-popover.tsx`, `visual.ts`). Prefer Collector-side adapters. Before edit: list Script callers, state impact, and get PO approval if behavior can affect Scripts. |
| `COLLECTOR_OWNED` | Editable for Collector development if changes do not force edits into frozen files. |
| `UNKNOWN` | Treat as protected until ownership is verified. |

**Before applying any code change:** compare the modified file list against `SCRIPT_BASELINE_MANIFEST.md`. If any path is frozen or shared-review, **stop and report** rather than silently proceeding.

Prefer:

- New Collector-only modules under `src/renderer/collectors/`, `src/renderer/feed-item-collector/`, `src/renderer/post-detail-collector/`, `src/shared/collectors/`, `src/shared/post-detail-collector/`, and Collector-specific `src/main/*` modules already classified `COLLECTOR_OWNED`.  
- Thin wrappers that call existing BrowserCore / storage APIs without changing their Script semantics.

## Exception approval procedure

1. Agent stops and names the conflicting protected path(s) and why Collector needs them.  
2. Product Owner explicitly authorizes the exception in the task (scope, files, acceptance checks).  
3. Agent documents the exception in the PR / task notes and runs Script regression subset from the baseline manifest.  
4. No silent “drive-by” edits to frozen files while implementing Collector features.

## Regression verification policy

- Prefer non-destructive unit tests under `tests/` that use `os.tmpdir()`, `:memory:`, or mocked/localhost HTTP.  
- Do **not** run tests that open production-like `userData` / accepted `creator.sqlite`, real Electron GUI automation, or live SEO-OPS publish against production credentials, unless PO marks the run `REQUIRES_PO_MANUAL_ACCEPTANCE`.  
- Do not invent missing tests or claim historical CI results are current.  
- Record what was actually run and observed (pass/fail) in the task report or update the baseline manifest when re-baselining.

## Rollback guidance

- **Never** automatically discard user working-tree changes (`reset --hard`, `clean -fd`, stash-drop, force checkout).  
- If a mistaken edit touches frozen files: stop; report the diff; ask PO whether to revert those paths only.  
- Restore from Git commit `3484efd5bf2bfac838935d6ffd2e419321be0834` only with PO confirmation and without wiping unrelated dirty files.  
- Local Script DB recovery is PO-owned (backup / SEO-OPS pull). Agents must not delete or migrate accepted Script data.

## Cursor rule

Persistent agent instruction: `.cursor/rules/script-creator-frozen.mdc` (`alwaysApply: true`).  
A Cursor rule is an **instruction**, not a technical filesystem lock. Enforce via review + `git diff` against this freeze.

## End state

**SCRIPT CREATOR FROZEN — COLLECTOR DEVELOPMENT READY** (Collector-only surfaces only).
