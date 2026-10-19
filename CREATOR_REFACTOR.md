# Creator UI refactor

## Audit and scope

Work is confined to `new` on `feature/creator-ui-refactor`. Initial Git state contained only the untracked `rpa-social-automation-v2/` directory; it is excluded from this change. No changes to `old`, production session files, target images, OCR engine, image matching algorithm, or Facebook content.

Files changed by responsibility:

- `src/shared/contracts.ts`, `flow-model.ts`: variable definitions, Default Pattern values, groups, slug validation, execution-order validation and runtime resolution.
- `src/shared/geometry.ts`, `src/main/creator-overlays.ts`, `main.ts`, renderer CSS: fixed 1024 × 560 DIP browser; editor overlays the Step List below 1696 DIP, uses its own column above that width; horizontal workspace scrolling for narrower windows. Zoom is unchanged. Debug remains the same native view with its existing bottom anchor and expanded/collapsed heights.
- `src/main/storage.ts`: transactional legacy migration, variable updates, immutable version preservation and group organization.
- `src/main/runtime.ts`: resolve the entire test plan against the current Default Pattern before any action.
- `src/renderer/main.tsx`, `flow-controls.tsx`, `step-list.tsx`: select-to-test, explicit Edit/close, group containers and Variables popover. The popover temporarily hides native browser/Debug surfaces so its inputs are clickable; it does not reload the page or session.
- Unit and browser fixtures: changed expectations for fixed viewport and referenced variables; added migration, grouping, pattern, modal continuity, scrolling and OCR-clear regressions.

## Storage and migration

Each Flow has separate `variables` declarations and `defaultPattern.values`, keyed by stable variable ID. The editable key is a label; renaming it does not break references. Groups have stable IDs and persisted slugs. `Flow.steps` is the complete canonical execution order including standalone steps; group `stepIds` must be a contiguous ordered subset. Changing a group name does not regenerate its slug.

On opening the database, a single SQLite transaction converts inline text/files on all versions and override segments belonging to every Flow. Generated `legacy_N` keys are unique within their Flow. Payloads retain Step IDs, versions, timestamps, target assets, ROI, matching configuration and override bindings. Current Flow selection is preserved. Existing steps remain standalone. Reopening is idempotent. A newer unsupported schema or an ambiguous inline/reference value is refused. A conversion failure rolls back every payload change and closes the database with an explicit migration error. No database/session is deleted. Legacy inline API inputs remain accepted and are normalized before persistence.

Default Pattern edits update the Flow only; they do not create Step versions. Variable deletion/type changes are blocked if any saved version or override still refers to that variable, including historical versions. Runtime reports missing references, missing values and incompatible types before executing the test plan. File existence/content is checked by the existing upload pipeline before its visual click.

Targets previously captured at 672 DIP retain their original viewport metadata. They are blocked at the new standard viewport with recapture guidance. Their coordinates are never silently scaled; recapture and save a new version to use them at 1024 DIP. Existing 1024-DIP targets continue to run.

No Condition Engine, condition fields, IF/ELSE, Runner UI, additional Pattern selector, or external synchronization was added.

## Validation

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:browser`. Browser reports are under `artifacts/browser-*.json`. Fixtures use isolated `.local/test-*` profiles. Creator overlay routing uses physical Windows mouse input because synthetic `sendInputEvent` does not reliably exercise native overlay hit testing. The `creator-native` phase additionally records pointer traces.

Unit coverage includes Vietnamese slug normalization/uniqueness, complete group execution order, preservation of steps/overrides, Text/File/Files resolution, pattern edits without versions, missing/type-invalid values, migration reopening and transaction rollback. Browser fixtures cover fixed viewport/fullscreen ROI, selection without execution, real typing/upload in local fixtures, OCR X preserving ROI, popover values, modal retention and narrow workspace scrolling.

Local fixtures are not evidence of Facebook acceptance. The first fixture retains three reported limitations/manual checks: capture focus preservation, hidden-window capture, and physical Ctrl+Shift+T acceptance. These are not counted as passing checks.

## Recorded results

- `npm run typecheck`: passed.
- `npm test`: 32 tests passed.
- `npm run build`: passed.
- `npm run test:browser`: exit 0; 99 checks passed across eight phases, with the three limitations/manual checks above explicitly retained.
- `node scripts/browser-test.mjs creator-native`: 10 checks passed using physical Windows mouse input and pointer tracing.
- Facebook itself was not tested; no post was published. Production database/session files and the pre-existing untracked nested repository were left untouched.

## Manual Facebook acceptance (no publishing)

1. Open the existing Facebook session and a composer/modal. Note the URL, login state and draft content.
2. Select saved steps: Test & Debug should open without sending an action. Edit and close the editor, then use + Step and Sai/Redesign. The same live modal and draft must remain.
3. At the normal window size and fullscreen, capture the same visible target and test a safe click. Confirm 1024 × 560 DIP and unchanged Flow zoom. Resize horizontally below 1344 DIP and use the workspace arrows/scrollbar; the browser viewport must remain fixed.
4. In Variables, create Text and File/Files declarations and Default Pattern values. Select their references in TYPE/UPLOAD editors. Save and test only draft text/local photos. Change a default value and confirm the Step version stays unchanged. Remove a required default value and confirm testing is blocked. Attempt to delete a used declaration and confirm a clear error.
5. Create a Vietnamese-named group, rename it without changing its slug, collapse/expand it, move steps in/out and reorder groups. Reopen the Flow and confirm execution order, Step versions and overrides.
6. Read/confirm OCR, click its small X, and confirm that the ROI image is retained. Read OCR again.
7. For legacy 672-DIP targets, recapture at 1024 DIP and save a new version; verify that the old version and its assets remain available.
8. Stop at draft/thumbnail preview and review results. Do not publish a Facebook post.
