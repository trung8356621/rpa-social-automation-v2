# SEO-OPS Script Registry — RPA Creator V2 notes

Status: **local export utilities only**. Not wired to UI. Not publishing to production.

## Architecture boundary

| Layer | Owner |
|---|---|
| Create/test Script (Flow + Step versions + ROI) | RPA Creator V2 |
| Widget Form Builder, Workflow, Manual/AI modes | SEO-OPS |
| Execute Script with prepared inputs | RPA Runner |

## Data path (laptop clone layout)

Compiled main resolves:

`{repo}/.local/creator/` → `creator.sqlite`, `targets/`, `captures/`, `runs/`, `chromium/`

Copied transfer data currently lived at `D:\work-app\new\.local\creator\` and was **copied** (not moved) into the repo `.local/creator/`.

## Contract gap vs Social Automation server (`dd8a6de`)

Server Package Registry today:

- `kind`: `widget` | `workflow` only
- Publish: `POST .../social-automation/packages/publish`
- Scope: `social-automation:package:publish`

RPA v2 export produces provisional `kind: "script"` with:

- `script_id` (flow id)
- ordered step versions + payloads (secrets stripped)
- ROI asset filenames
- embedded input hints (text/files)

**Server must add Script Registry (or accept `kind=script`) before live publish.**  
Do not force Scripts into Widget/Workflow packages.

## Reused from legacy laptop RPA (adapted)

| Legacy file | v2 module | Verdict |
|---|---|---|
| `canonicalJson.js` | `src/shared/seoOps/canonicalJson.ts` | Reusable |
| `packageDigest.js` | `src/shared/seoOps/contentDigest.ts` | Reusable |
| `secretStrip.js` | `src/shared/seoOps/secretStrip.ts` | Reusable |
| `packagePublishClient.js` | `src/shared/seoOps/publishClient.ts` | Adapted |
| `publishState.js` | `src/shared/seoOps/publishState.ts` | Adapted (flow meta) |
| `packageExport.js` (scenario→widget/workflow) | — | **Obsolete** for v2 |
| `index.js` | `src/shared/seoOps/index.ts` | Rewritten |

## Not exported

Cookies, Chromium session, credentials, absolute upload paths, Test Lab `runs` payloads.
