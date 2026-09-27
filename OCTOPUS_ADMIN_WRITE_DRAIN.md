# Admin bridge write drain

The bridge remains available for read-only tools while direct Octopus mutations
are paused. This is a process-local control, not a claim that all services or
billing have migrated. No live settings or data were changed by this patch.

- Persist `OCTOPUS_WRITES_PAUSED=true` to start paused after deployment/restart.
  Unset or `false` preserves mirror operation; other nonempty values fail closed.
  An explicitly non-mirror `GENIE_CRM_SOURCE_MODE` also refuses external writes.
- Authenticate GET/POST `/internal/octopus-writes` with the existing
  `x-genie-secret` / `GENIE_CRM_SYNC_SECRET`. POST accepts only
  `{"action":"drain"}`. It blocks new work immediately and reports active counts;
  existing admitted work is allowed to finish. There is no resume/replay action.
- GET reports a process instance ID, active operations by kind, held startup task
  count, and uncertain failures without customer data. `drained` means this
  paused process has no tracked active writer; `globalCutoverReady` is always
  false. Inspect all replicas and reconcile uncertain failures separately.
- An exception or unverified mutation result latches further writes closed for
  this process. An assignment result's `changed:false` is not assumed safe after
  failed verification. Explicit duplicate/already-assigned rejections are known
  no-write outcomes. Uncertainty is never cleared or automatically retried here.
- Runtime drain alone reports `restartSafe:false`. Persist the pause setting
  before treating a later restart as safe. Do not use a deployment or process
  termination to interrupt active writes and call that a verified drain.

Covered paths: direct internal cleaner assignment; MCP create, cancel and
reschedule; and the configured startup customer-name edit. The startup edit
configuration is retained, held without replay, and not printed by the control.
Browser-backed operations remain active until their existing browser/child
cleanup finishes. A create delegated to Lisa also requires the separate speech
service's drain; that service may still be completing post-result work.

Health, login check, booking/client search, exact booking-view read, address
lookup, and billing inspection remain available. The generic booking-page read
is restricted to the documented `/booking/view/<numeric-id>` URL so it cannot
navigate an arbitrary admin action endpoint while writes are paused. Billing
inspection is a read and this service is not the payment processor.

The deployed branch is `octopus-admin-bridge`, with start command
`node playwright/octopus-admin-mcp.js`. This service does not run the phone server
or the notification watcher. Deploy this branch only, preserve its existing
credentials, then verify the authenticated control before coordinated cutover.

Validation: `node --test test/admin-write-control.test.js test/fast-booking-client.test.js`.
Tests exercise the actual dispatcher, assignment/startup wrappers, and HTTP
handler with local stubs. They make no external requests or customer changes.
