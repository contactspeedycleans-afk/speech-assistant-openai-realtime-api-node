# Selective Octopus write drain

Phone/SMS transport and read-only lookups remain available. This gate covers external create (including draft customer creation), finalization, assignment, cancel, reschedule, and notes browser writes. Genie notes that return `localOnly`/`alreadyComplete` finish without touching Octopus. Existing source-authority gates still apply independently.

Persist `OCTOPUS_WRITES_PAUSED=true` for restart safety. Only absent/blank or literal `false` allows new writes; misspellings fail closed. No resume route or automatic replay of held work exists.

The authenticated routes use only the existing server `LISA_ACTION_SECRET` through `x-lisa-secret`:
- GET `/internal/octopus-writes`: process-local counts, instance ID, oldest active start, notes queued/running/held/review/unknown counts, queued bookings and staged drafts. No customer payloads or secrets.
- POST same path with JSON `{ "action": "drain" }`: stop admitting new external writes immediately; existing operations finish under their existing timeout rules. Draining itself never kills a process or child.

Safe order after this code is installed: drain every live replica; wait for `safeToCutover=true` on each same instance and resolve any unknowns; then persist the pause setting before a restart/deploy and verify `restartSafe=true`. A load-balanced response from one instance does not prove every replica is drained. Initial installation into an old version without this endpoint needs a separately verified quiet window; deploying alone is not proof of a safe drain. Never clear uncertain state by restarting. No automatic environment changes are performed by these routes.

`drained` means admission is stopped and no currently tracked external operation remains. `safeToCutover` additionally requires no process-local uncertain result, no running notes worker (across replicas), and no durable uncertain notes job. Failed/time-out/unparseable remote results latch this instance closed. Operator reconciliation is required; the API cannot prove whether an unverified remote save occurred. Booking uncertainty is process-local, so preserve status/log evidence and do not restart an unresolved instance.

Notes record `external_started_at` before dispatch. A crash, timeout, lost completion acknowledgement, or old interrupted running job is held for review and never automatically reissued. Jobs blocked before dispatch become `held`; they require explicit review rather than replay when the environment changes. New local-only Genie notes continue even while external writes are held. Unchanged legacy staff-review notification behavior is preserved; this change does not send a new customer notification.

Tests: `node --test tests/*.test.js`. Three additional real PostgreSQL-engine queue tests run when `PGLITE_TEST_MODULE` points to an installed `@electric-sql/pglite` ES module; they otherwise explicitly skip. The reviewed run used that fixture and passed all 33 tests with zero skips. No deployment, live drain, environment update, or external call is part of this change.

Warm booking/finalization HTTP responses may return at the BOK marker, but their active lease remains until the browser child closes, including the existing post-result confirmation step. A failed or forced child close is uncertain even if the BOK was returned. `scope=speech_process_only` and `globalCutoverReady=false` explicitly prevent interpreting this endpoint as global cutover permission.

Creation requests also retain a parent completion lease through their existing cache and success-webhook follow-ups. That lease is admitted before dispatch and finishes normally during drain; it does not reacquire admission after a successful save.
