# SEO-OPS Script Registry — RPA Admin contract

Status: **UI + UNIT VERIFIED** (local). E2E / production integration / RPA Client **NOT RUN**.

Electron UI:

- Settings → SEO-OPS login (endpoint + email/password + session restore via safeStorage).
- Scenarios → Sync SEO-OPS (all / per-scenario) + status badges.
- Local create/edit/test Script không yêu cầu login; chỉ sync yêu cầu phiên `admin`|`owner`.

## Auth (RPA Admin user)

Base: `/api/v1/social-automation/rpa-admin`

| Method | Path | Auth |
|---|---|---|
| POST | `/login` | email + password (SEO-OPS User) |
| GET | `/session` | Bearer opaque token |
| POST | `/logout` | Bearer opaque token |

Rules:

- Allowed roles: `admin`, `owner`. `staff` → `role_staff_forbidden`.
- Server derives `user_id` from credentials/token. Client `user_id` is ignored.
- Token stored hashed (SHA-256) server-side; never log plaintext password/token.
- Distinct from Runner `service_api_credentials` scopes.

## Script sync

| Method | Path | Purpose |
|---|---|---|
| GET | `/scripts` | Remote Script catalog |
| POST | `/scripts/sync/plan` | Bidirectional plan (`local_scripts` body) |
| POST | `/scripts/publish` | Push Script release (immutable) |
| POST | `/scripts/pull` | Pull release JSON for local import |

Plan outcomes: `push_to_remote`, `pull_to_local`, `skip` (same digest), `conflicts` (divergent edits — no silent overwrite).

Import must materialize Script flow/steps/assets. Missing asset digests → `incomplete` / not `ready_to_execute`.

Never sync cookies, browser profiles, or website credentials.

## Widget invalidation

When a new Script version changes **execution digest** (steps/variables/assets — not video/metadata only):

- Dependent Widgets are disabled with `reason=script_updated`.
- Workflows referencing disabled Widgets cannot create new dispatch.
- Historical jobs unchanged; no auto re-enable.

## Runner vs Admin

- Runner uses Service API scopes under `/api/v1/services/{service}/social-automation/runner/...`.
- Admin browser enrollment must set `agent_kind=admin` and does **not** count as Runner online.
