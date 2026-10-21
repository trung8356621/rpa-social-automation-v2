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
