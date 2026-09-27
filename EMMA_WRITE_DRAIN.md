# Selective booking pause for the existing Emma deployment

This patch is based on the deployed `emma-devopment` branch. It preserves its
phone/SMS transport, outbound answer callbacks, caller context and read-only
Octopus/billing lookup. It does not migrate that older caller context to Genie.
When booking writes are paused, callers receive an office handoff instead.

Set `OCTOPUS_WRITES_PAUSED=true` on the Emma service for restart-safe retirement
of its external booking writers. Empty/`false` preserves current behavior;
unexpected nonempty values fail closed. An explicit source mode other than
`mirror` also closes admission. No runtime resume action is provided.

Authenticated `GET /internal/octopus-writes` reports process-local state.
Authenticated `POST /internal/octopus-writes` with `{ "action": "drain" }`
stops new admissions without ending phone calls or interrupting admitted writes.
Use `x-lisa-secret` with `LISA_ACTION_SECRET`, or the existing
`SMS_WEBHOOK_SECRET` when the former is absent. The request limit is 512 bytes.
Never place the secret in a URL or print it in deployment logs.

The scope includes direct Playwright creation and its completion receipts,
voice/SMS/API cancellation and rescheduling subprocesses, and delegated fast
creation through its eventual response even when the caller has already received
the processing result. A child result marker does not release the active count;
the process must close. A timeout rejects the caller but retains the child lease
until close. Throws, nonzero exits, missing results and returned unverified
results latch admission paused and increment `uncertain`; they are not retried.

For an installed process, inspect `paused`, `active`, `uncertain`, `restartSafe`
and `instanceId` for every replica. `drained` only means paused with no counted
active operations; `safeToCutover` additionally requires no uncertain result.
`globalCutoverReady` is always false because other services and remote workers
need independent evidence. Persist the environment pause before a restart.
Initial rollout still requires checking current calls/writes: an old process
cannot report a gate it did not previously run.

The same branch also builds the booking-sync and customer-tracker services. Their
entrypoints remain unchanged: Octopus reads/local tracking continue; the tracker
test-dispatch route can still create legacy queue intent. Keep the separate
watcher dispatch gate paused, and do not replay such intent automatically.

Validation: `node --test test/emma-write-control.test.js test/fastBookingAction.test.js test/openAiSessionBuilder.test.js tests/lsa-booking-link.test.js`.
