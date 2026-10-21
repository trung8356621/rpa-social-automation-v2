# SEO-OPS integration boundary

`src/shared/seo-ops-publish.ts` defines an injected transport interface, with no network implementation or invented URL. Local Publish only seals the local release registry; it does not upload or imply SEO-OPS acceptance.

The caller submits a verified ZIP as bytes, the exact manifest, selected/reviewed preview metadata, and `releaseId` as the idempotency key. SEO-OPS responds with a receipt ID, the same release ID/version, accepted/rejected status, timestamp, and a rejection reason when applicable. Validate the receipt against the submitted release before storing acceptance. Acceptance must not mutate package bytes. The SHA-256 digest provides integrity, not publisher authentication; deployment must define signing/trust separately.

Before wiring a transport, agree on endpoint, authentication, authorization, content type, maximum package size, timeout/retry/idempotency policy, error codes, preview visibility policy, and receipt/status synchronization. Credentials belong in local transport configuration and must never enter a package. The interface does not grant remote control of Browser Sessions.

Admin does not schedule, assign machines, distribute proxies or control remote desktops. Runner receives a verified bundle and binds a caller-owned local Browser Session and start URL at execution time. `runBundle` is reusable by the official Runner without reading Admin Scenarios. A clean-machine execution remains a required acceptance check.

Release deletion is intentionally unavailable in V1. Both package bytes and definitions with releases are retained; deprecation changes registry metadata only. This conservatively prevents removal of dependencies used by other Workflows.
