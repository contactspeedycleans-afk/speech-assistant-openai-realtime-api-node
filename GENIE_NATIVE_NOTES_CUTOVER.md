# Genie native notes cutover

The notes worker lives on the `lisa-fast-booking` branch of
`speech-assistant-openai-realtime-api-node`, in `lib/booking-note-queue.js` and
`lib/genie-booking-notes.js`. The Python Lisa repository only enqueues final call
notes; it is not the browser notes editor.

## Completion contract

The worker calls Genie's notes endpoint with `operation: apply`. An explicit
`alreadyComplete: true` or `localOnly: true` is terminal. The worker records local
success, does not open Octopus, and does not send an Octopus completion receipt.
This takes precedence over any stale `waiting` flag or external booking IDs.
Legacy mirror responses still use the verified numeric Octopus ID and BOK pair,
preserve the staff-note baseline, edit once, and send a completion receipt.

## Required cutover barrier

Genie holds its shared ownership lock during `apply`, but releases it when that
request returns. The external browser edit happens after that return. The notes
worker's advisory lock is in a separate database and cannot serialize Genie's
business-mode change. A second HTTP preflight alone would still have this race.

Before native activation:

1. Quiesce all notes worker replicas so none can begin a new external edit.
2. Wait for in-flight browser edits to finish and reconcile their receipts;
   verify zero running edits, including interrupted/stale `running` work.
3. Review unresolved legacy Octopus-only note jobs. They have no Genie job ID and
   cannot safely be converted by guessing a booking identity.
4. Switch the business to native under Genie's exclusive ownership lock.
5. Resume the updated notes worker for Genie-identified outbox items. Its `apply`
   response rechecks native mode under the server lock and finishes locally.

For unattended future mode flips, the architecture needs a server-managed
delivery lease or server-held delivery boundary spanning the actual external
write. This patch does not claim that client-side response handling provides it.

No deployment, mode switch, queue mutation, or customer message is part of this
change. Tests use injected responses and editor functions; no network writes.

## Remaining Octopus dependencies (read-only audit)

Inspected Lisa `main` at `5f2f0b4` and the notes service's `lisa-fast-booking`
branch at `09817dc`. These are source findings, not proof of running deployment
configuration. Do not cancel Octopus or stop a shared phone service based only on
the notes guard.

| Dependency | Source evidence | Required replacement / verification |
| --- | --- | --- |
| Automatic job-request rounds | Lisa `octopus-notification-watcher.js`, `dispatchNextBooking` (~5277), `runDispatchCheck` (~7035): every minute, sends requests through the Octopus available-fieldworker UI/API in widening 30/45/60/75-mile rounds, up to 100 recipients. No Genie ownership check found in this watcher. | Quiesce Octopus dispatch, migrate its intended scheduling/radius rules to Genie, and prove native offers plus acceptance work for active cleaners. Native manual requests alone do not replace its timer. |
| Assignment and progress events | Same watcher `upsertDispatchState` (~756), `sweepOctopusUnassignedBookings` (~2479), assignment webhook (~405): scrapes accepted/confirmed cleaner and en-route/start/finish notifications into legacy tracking and Make. | Cleaners must use Genie; native events must feed staff views and any remaining Sheet notifications. Drain old events and stop stale external assignment reconciliation. |
| Cleaner readiness and open-job lookup | Lisa `cleaner_job_lookup.py` reads `public.technicians.approved_for_jobs` and `booking_dispatch_state`; `cleaner_onboarding.py:404` has a separate explicit approval helper for that legacy table. | Point Lisa's cleaner context and available-job lookup at Genie worker eligibility and native jobs. Genie screening currently does not update this separate legacy approval flag. Do not infer approval from `same_day_ready`. |
| Customer appointment lookup | Lisa `bot.py` `_lookup_account_with_progress` (~5793): exact BOK can return Genie directly, but phone/name searches merge Genie results with `lookup_customer_account`; `customer_account_lookup.py` calls the live Octopus lookup. | In native mode return authoritative Genie results without querying or merging old Octopus appointments. Verify canceled/rescheduled visits and no-match behavior. |
| Address resolution and legacy booking/change fallback | Lisa `lookup_booking_address` (~4896), booking recovery/fallback (~5451), and watcher `/lisa/booking-action` route: still have live Octopus browser paths. | Verify a native address path and prevent native-mode create/cancel/reschedule fallbacks from using Octopus. Keep phone handling running while these dependencies are replaced. |
| Legacy notes already queued | Notes queue `lib/booking-note-queue.js`: items without `bookingSystem: genie_crm` call the Octopus editor directly. | Reconcile/drain these before cancellation; no guessing a Genie job from an old numeric ID. |

Genie's native worker responses and workflows can operate without Octopus, but
existing cleaner logins, photos/time submission, masked contact, and staff
notifications still need an end-to-end cutover verification. None of the above
watcher, voice, intake, or scheduling behaviors were changed by this patch.
