# Admin Studio V3 implementation

Specification read 2026-10-21: [01 — RPA Admin Studio — Scenario, Variation, Widget & Workflow](https://docs.google.com/document/d/155ql8Kgn8HofVjVH0u0-bsDBNZnPDS35CJYWFO86jFE/edit).
The attached full implementation brief takes precedence where more specific.

## Phase 0: source audit and compatibility decisions

- `src/main/storage.ts`: SQLite `flows` stores JSON Flow; `steps` stores stable ID/version payloads; Flow.steps pins each version. Overrides reference a specific Base version. Preserve these tables and the existing legacy migrations unchanged.
- `src/shared/flow-model.ts`: Variables are text/file/files/integer/number, keyed by stable variable ID; Default Pattern values belong to Flow. `resolvePayload` resolves inputs. V3 maps its form keys to these IDs on a cloned Flow; it never writes Scenario defaults.
- `src/main/runtime.ts`, `shared/playback.ts`, `main/main.ts`: Play All and Test Lab share Runtime.test and sequential playback. Snapshot support extends the same Runtime lookup boundary; it is not an action interpreter.
- `browser-sessions.ts`/`browser-core.ts`: Default `persist:creator-default` and per-ID persistent partitions own cookies. Session binding and HTTP(S) start URL remain local execution arguments; neither belongs in packages. Network Mode remains local.
- `test-lab.ts`: configurations/last result in the `testLab` setting. `test-run-evidence.ts`: UUID-owned case/run directories, final.png and metadata.json, latest plus one previous run retained. V3 copies explicitly reviewed previews into a separate protected store before retention can remove a run.
- Existing `npm run build` builds the application, not distributable Scenario packages. No V2 package importer or Runner exists in `new/src`. `old/` and the untracked nested `rpa-social-automation-v2/` are not implementation targets.
- Scenario inputs can be inferred from declared Variables and action variable IDs. V2 does not declare business outputs or DOM extraction. V3 Scenario outputs are explicit text fields `status`, `message`, `runId`, `scenarioId`; composition outputs map these or input/literal values. ACTION_SENT is not proof of business success.
- Minimal V2 additions: optional recording config/result properties, V3 page/IPC/state types and an optional in-memory Runtime snapshot. V3 authoring, builds, imports and protected previews live under `.local/creator/admin-v3`; no V2 schema migration or data rewrite.

## Contracts (schemaVersion 1)

See `src/shared/admin-v3.ts`. Stable IDs and explicit version pins identify all dependencies. Scenario snapshots include ordered Base Step versions, Variables and zoom, without Default Pattern, Overrides, groups, sessions or machine paths. V1 packages bundle executable snapshots and Workflow Widget releases; external dependencies are rejected.

Form fields reuse V2 value types, with label/default/required/visibility/description and bounds/length/pattern validation. Hidden inputs require explicit defaults. Sensitive inputs must be supplied locally and cannot have packaged defaults. Mappings select an input key, an earlier node's typed output key, or a typed literal; no eval, expression language or implicit fallback.

Directory package layout: manifest.json, form.json, graph.json, inputs.json, outputs.json, permissions.json, scenarios/, assets/, and dependencies/ for bundled Widgets. Manifest records every content file's SHA-256, runtime minimum, capabilities and dependencies. Content digest and release ID derive from the canonical manifest without its checksum/releaseId. ZIP uses stored entries; importer accepts this bounded format and rejects traversal, duplicates, symlinks, unsupported compression and undeclared bytes.

Lifecycle: draft → validated → tested → built → published → deprecated. Testing binds to a digest of the authored executable content. Editing invalidates validation/testing. Build/export revalidates; publishing requires successful local execution evidence for the exact content and explicit media review. Published bytes are write-once; deprecation changes registry metadata only. New versions/revisions create separate records. No server endpoint is assumed.

## Validation status

No Electron, project build, test, fixture or typecheck has been run: the user explicitly requires permission before those commands. Static inspection is not acceptance. Phase implementation details, commits, limitations and manual acceptance checklist will be maintained below.

## Implementation by phase

| Phase | Code implemented | Commit |
| --- | --- | --- |
| 0 | Source audit, V3 TypeScript contracts, compatibility/storage decisions | `2800909` |
| 1 | Optional silent Browser recording, finalization on run exit, retained screenshots, protected reviewed-preview copies | `1231dac` |
| 2 | Variation CRUD, workspace tabs/drafts, editable fields, form preview, pinned Step selection, typed mappings and V2 Runtime execution | `fb7180a` |
| 3 | Widget Registry, bundled snapshots/assets, package validation, content manifest/digest/release ID, ZIP export | `48e2c96` |
| 4 | Bounded ZIP import, checksum/schema/capability validation, reusable package execution adapter | `25831a6` |
| 5 | Linear Start/Widget/End canvas, automatic connections/reordering, typed ports and output mapping, bundled Workflow build/execution | `33035a8` |
| 6 | Builds & Releases, failed-build diagnostics, local publish/deprecate, stable product revisions, SEO-OPS boundary, final static-review fixes | PHASE_6_COMMIT |

Later phases include integration and static-review corrections to earlier phases; a phase commit is an implementation milestone, not a claim that its code has passed execution checks. No new branch or merge was performed. The pre-existing untracked `rpa-social-automation-v2/` remains untouched.

## New files and schemas

| Files | Purpose |
| --- | --- |
| `src/shared/admin-v3.ts` | Schema-version marker, snapshots, form/ports/mappings, definitions, manifests, previews, run/build/release results and IPC contracts |
| `src/shared/admin-v3-validation.ts` | Typed form/graph/dependency validation and structured issues |
| `src/main/admin-v3-store.ts` | Canonical JSON/digests; independent V3 authoring, run/build/import/release registry files |
| `src/main/admin-v3.ts` | Variation/Widget authoring, Scenario snapshot preparation and composition through shared runtime |
| `src/main/browser-recording.ts`, `src/renderer/browser-recording.ts` | Browser CDP frame capture and silent WebM encoding; no desktop/audio capture |
| `src/main/preview-assets.ts` | Explicit review and checksum-protected copies outside Test Run retention |
| `src/main/package-zip.ts` | Bounded, uncompressed ZIP32 encoding/decoding with CRC/path/duplicate/attribute checks |
| `src/main/studio-packages.ts` | Widget packages, strict package reader, atomic directory materialization, lifecycle/export/import |
| `src/main/runner-package.ts` | Reusable package execution adapter; local capabilities and Runtime callback supplied by caller |
| `src/main/studio-workflows.ts` | Pinned Widget resolution, Workflow validation, execution and bundling |
| `src/renderer/admin-studio.tsx` | V3 lists/editors, field configuration/form preview, linear canvas, local test/import/release UI |
| `src/shared/seo-ops-publish.ts`, `docs/V3-SEO-OPS.md` | Transport/receipt boundary and open integration decisions; no server implementation |
| `tests/admin-v3.test.ts` | Added, **not executed**: transport tampering, manifest/version checks, forms/types, mapping order, local capability refusal and two bundled Widgets |

Existing contracts, preload, main IPC, navigation/tabs, Test Lab, Runtime and shell CSP have additive integration changes. The only Runtime lookup change is an optional batch-owned Step snapshot and using the batch Flow ID in result metadata. Existing callers omit snapshot Steps and retain their original Store lookup path. The action executor, OCR/image matching, QUICK_TAG, uploads, Variables resolver, Network Mode and session partition model are reused.

On-disk V3 state lives under `admin-v3/{definitions,releases,runs,builds,imports,previews,bundles}` inside existing local user data. New files are created only when the application uses these features; this implementation work has not launched the app or opened/migrated the user's SQLite database. Draft/registry replacement is atomic. Immutable registry entries use atomic no-replacement hard links; filesystems lacking hard-link support fail explicitly. Bundle materialization uses an owned staging directory and atomic rename. Crash-orphan staging directories are not silently removed at startup.

`inputs.json` describes externally accepted inputs: internal hidden defaults are excluded, and a field with a default is optional at the component port. `form.json` retains presentation/required/default rules. Sensitive inputs are exposed for local entry, never given packaged defaults, and cannot be satisfied by embedded literals. Scenario business outputs remain limited to the explicitly documented runtime output ports. Published revision drafts retain `packageId`, receive a new authoring ID and an incremented patch version, and never replace old bytes.

## Limits and adapter-only scope

- **Execution and compilation are unverified.** Static review and `git diff --check` cannot establish type correctness, media encoding behavior, UI usability or runtime acceptance. No PASS/Production Ready claim is made.
- Runner is an import/execution harness plus reusable `readBundle`/`runBundle` boundary. There is no separate full Runner application, installer, distribution system or clean-machine acceptance evidence.
- SEO-OPS is a transport/receipt interface and integration document only. Local Publish makes no network request and is not server acceptance. Digest integrity is not publisher authentication; signing/trust remains a future integration decision.
- Workflow V1 is deliberately linear. Adding/removing/reordering nodes creates its connections; failures stop at End. Condition editing, branching, parallel execution and arbitrary graph editing are not implemented.
- Recording requires the Electron/Chromium WebM encoder and a responsive shell renderer. It is silent, padded to 1280×720, sampled to approximately 12 frames/second, and capped at 256 MiB. Start/finalization failures are recorded independently of screenshots; a crash cannot guarantee a finalized WebM. Media preview currently uses local data URLs, so long recordings need memory/latency acceptance testing. No automatic upload occurs.
- Preview selection covers the current completed Last Result for each Case; V2 retains its existing latest-plus-previous evidence policy. Selected copies survive that cleanup. Review is a human confirmation; automatic redaction, OCR secret classification and video editing are not implemented.
- All package JSON is allowlisted/validated. Known credential metadata, credential URLs, session partitions and absolute machine paths are refused; arbitrary private text or sensitive pixels cannot be reliably recognized automatically. The admin must review selected media, visual target crops, defaults and metadata before publishing.
- Legacy inline text/file actions must use mapped Scenario Variables to be packaged. No automatic V2 rewrite is performed. File paths are supplied locally at run time. Hidden secret providers are not implemented; sensitive values must be entered locally. Patterns use a bounded anchored subset, without groups/braces/backreferences and with at most one quantifier.
- ZIP import supports this application's single-disk STORE ZIP32 format only, with at most 3,000 entries and 384 MiB content. External DEFLATE/ZIP64/encrypted archives are rejected explicitly. Export refuses replacing an existing selected file; choose a fresh filename.
- V3 preserves existing viewport/zoom checks. Legacy targets with a viewport incompatible with the current V2 Browser remain blocked; images are not rescaled to force execution. Editing source Variables/assets can invalidate test evidence and block publication until retested/rebuilt.
- ACTION_SENT remains ACTION_SENT and is not business success. The build test gate proves a saved composition ran without a blocking/error outcome; business correctness still requires manual review. Dynamic output validation can only happen after its producing node executes.
- Registry deletion of releases is intentionally unavailable. Definitions with releases and Scenarios referenced by V3 definitions are retained conservatively; deprecation changes metadata only. This prevents removal of pinned dependencies.

## Manual acceptance checklist — once execution is authorized

Record actual outcomes, screenshots and logs without credentials. Use a backed-up copy of the existing user data for regression acceptance and a separate clean local data directory/machine for Runner compatibility.

1. First authorize and run project typecheck, unit tests (including the added V3 tests), and application build. Resolve failures before interactive acceptance. None of these commands has been run by the implementation agent.
2. Open the application manually. Verify Scenarios, Browser Sessions, Test Lab, Variations, Widget Registry, Workflows, Builds & Releases and Settings at expanded/collapsed sidebar widths. Confirm original Creator geometry, tabs and editor drafts.
3. Reopen existing Scenarios, groups, Variables/Default Patterns, Base versions and Overrides. Exercise Play All, Test Case values, QUICK_TAG, OCR/image targets and file upload. Confirm no original defaults, steps or assets were rewritten by V3 authoring/execution.
4. Verify existing cookies/logins and Domain Tags survive session switching/restart; confirm Network Mode/settings are unchanged. Test with two explicitly selected local sessions rather than exporting an Admin session.
5. Run a Test Case with recording off, then on. Observe only Browser content/no audio. Verify final screenshot and playable WebM on normal completion, BLOCKED and ERROR paths. Test unsupported encoder, CDP detach, shell reload and recording-size failure behavior; failures must remain visible.
6. Review a particular run's screenshot/video, explicitly confirm a protected copy, and select it in a definition. Run additional Cases to trigger history pruning, then delete the original Case; the selected preview must still open and build. Reject unreviewed/missing/modified preview bytes.
7. Create, rename, duplicate, reopen and explicitly delete a draft Variation. Open multiple Variation tabs; change fields and mappings independently. Exercise Save/Discard/Cancel on tab close and application close/reload. Existing Creator/Test Case drafts must also remain intact.
8. Compose two saved Scenarios. Select saved Step versions, reorder modules, map exposed/hidden/default inputs and upstream runtime outputs, and define outputs. Confirm the Runner Form Preview matches the actual local input fields.
9. Validate missing Scenario/version/assets, unsupported action, unknown input, wrong type, omitted required values, unsafe defaults, invalid patterns, forward/cyclic mapping, missing capabilities and incompatible viewport. Each must stop with a structured diagnostic; no silent fallback.
10. Run the saved Variation with a selected Session and HTTP(S) start URL. Verify exact inputs reach the exact pinned steps; verify the original Scenario defaults remain unchanged. Check both runtime verification and ACTION_SENT requiring business review.
11. Create a Widget from the Variation, validate/test/build, then export ZIP. Inspect contents: manifest/form/graph/contracts/permissions, bundled snapshots/targets and only explicitly reviewed preview media. Confirm there are no cookies, sessions, credentials, source defaults or build-machine paths.
12. Modify a mapped input contract, pinned version, source asset or selected preview after testing. Build/publish must refuse stale evidence. Confirm failed build diagnostics remain in Builds & Releases.
13. Import the ZIP on a clean Runner environment with no Admin Scenarios. Use a different local session and local file inputs. Verify manifest/digest/capabilities and execute through the shared Runtime. Record the structured result and actual business observation.
14. Tamper with a file/manifest/checksum, remove an asset/dependency, alter a version, use an unsupported runtime/capability, or submit traversal/duplicate/unsupported ZIP entries. Import must refuse them without creating a usable package.
15. Build two Widgets and compose them in a Workflow. Map first-Widget typed outputs to second-Widget inputs, verify required/default/hidden port behavior, reorder nodes and exercise stop-on-failure. Save/reopen, test/build/export/import and run on the clean environment.
16. Publish locally; verify saved package bytes/digest/release ID remain unchanged through export and deprecation. Direct edit must be refused. Create a revision and verify a new version/release ID with the same stable product ID; the old release stays exportable.
17. Attempt deletion of a released definition, a referenced Scenario or a Widget release used by a Workflow. V1 must retain those dependencies. Confirm deprecation does not mutate already bundled Workflow bytes.
18. Confirm Local Publish never contacts a server. Review `V3-SEO-OPS.md` with the SEO-OPS owner before implementing a real transport; validate receipt matching and rejection handling when that contract is supplied.
