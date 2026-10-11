# Fillip QA round 3

Head: `68dd9ed` (`68dd9edce788cbd3a326840014ab79829fef871a`) on PR #1.
Branch under test was checked out as `qa/bellion-fillip-3`. Product code was not changed.

The author said 180 tests pass and none were weakened. On this machine the suite at `68dd9ed`, before these new tests, is **179 passed, 1 failed (180)**. With `tests/qa/round3.test.ts` the suite is **194 passed, 7 failed (201)**.

Severity: **0 blockers, 5 majors, 2 minors**.

## Assertion diff

Compared every test file from `7403a14` (`qa/bellion-fillip-2`) to `68dd9ed`.

- `tests/qa/round2.test.ts` is unchanged. Its `QA-FAIL` names that now pass were not edited into passing assertions. The product changed. The one that still fails is the same authenticated-delete assertion, with the same `42501 permission denied for table deliveries`.
- No `it.skip`, `describe.skip`, `test.skip`, `xit`, or `xdescribe` under `tests/`.
- `tests/qa/mail-billing-auth.test.ts` and `tests/http.test.ts` moved the global-email numbers from public `GET /health` to `GET /internal/status` with the cron bearer. The matchers are the same (59/59 against 60/1800, empty count 0, provider backoff `stopped` / `reason: provider`). Public `/health` gained a tighter check: `{ok, service, version}` and no `globalEmails`.
- `tests/crud.test.ts`, `tests/time.test.ts`, and `tests/oauth-signin.test.ts` add coverage. They do not delete an earlier `expect`.

No assertion was weakened, skipped, or deleted.

## Findings

| Severity | What happens | Expected | Actual | Test |
| --- | --- | --- | --- | --- |
| Major | Two hosted creates at 9 of 10 open reminders | At most 10 active | 11 active | `QA-FAIL: two hosted creates cannot pass the free open-reminder cap of 10` |
| Major | Two hosted workers both deliver | Counter equals the two pings | Two emails sent, `emails_sent_in_period` is 0 | `QA-FAIL: two hosted workers that both send keep one counter increment per ping` |
| Major | Two workers renew one stale claim lease | One `send` | Both return `send` | `QA-FAIL: two workers renewing one stale claim lease send that occurrence once` |
| Major | Process dies after the attempt mark and before the provider accepts | Ping stays due and is still sent | Status becomes `fired`, sender is not called | `QA-FAIL: a crash after the attempt mark and before the provider accepts does not skip that ping` |
| Major | Edit the repeat with a phrase, leave the end date alone | End date remains | `every Monday at 9:00 AM`, March 31 is gone | `QA-FAIL: editing a repeat phrase keeps the end date already on that reminder` |
| Minor | Edit the repeat of a paused reminder | Stays paused, or the reply says it resumed | Status `active`, note `Repeat is now every day at 9:00 AM.` | `QA-FAIL: editing the repeat of a paused reminder does not resume it quietly` |
| Minor | Authenticated session deletes its own delivery rows | That user's rows go, the other user's stay | `permission denied for table deliveries` (`42501`) | `QA-FAIL: an authenticated session deletes its own delivery rows and leaves the other user's` |

### Major: hosted open cap

`MemoryFillipStore.createReminder` checks the open cap inside its write lock. `SupabaseFillipStore.createReminder` ignores the cap and POSTs. `createOrRefuse` only refuses when the store throws `OpenCapError`, which the hosted store never does. The round-2 test uses the memory store, so it stays green.

Repro: free plan, 9 active reminders, then two parallel `setReminder` calls. Both `countActive` reads see 9. Both inserts land. Active count is 11.

### Major: concurrent sends wipe the ping counter

`reserveSend` compare-and-swaps `emails_sent_in_period`. After a successful send, `noteSent` writes an absolute count taken from the contact loaded before the race. A worker that reserved and then lost the claim calls `releaseSend`, which decrements whatever it reads. The successful path keeps its reservation (`keep=true`), so the losing release is what erases the count.

Repro: pro plan, counter 0, two due reminders, two `SupabaseFillipStore` workers whose first profile reads both see 0. Both jobs run together. Two distinct idempotency keys are submitted. The profile counter is 0, not 2. A later run is not charged for those pings, so the monthly cap does not hold once cron runs overlap.

A single worker still holds the line. One ping left on both channels sends at most one and stays at or under 30.

### Major: stale claim lease is not exclusive

A ticket younger than 2 minutes stays `in-progress`. That part holds. Renewing a ticket older than 2 minutes is a plain PATCH of `started_at`, not a compare-and-swap. The delivery update is `status=neq.sent`, which is still true after the other worker has set `sending`.

Repro: one `sending` row and its claim ticket, both 5 minutes old. Two `claimDelivery` calls that both read the ticket before either updates it. Both outcomes are `send`. Both workers will call the provider. The privacy page says delivery records keep a ping from being emailed twice. This path does not.

A ticket 30 seconds old stays `in-progress`. A row that already has a real provider id (`re_accepted`) is not submitted again.

### Major: attempt mark skips the ping

`markAttempt` writes `provider_id` `"attempt"` before `sender.send`. `claimDelivery` treats any `provider_id` as `already-sent`. The job then advances the reminder. A one-time reminder becomes `fired`.

Repro: due reminder, delivery row `status=sending`, `provider_id=attempt`, `started_at` now. Run the due job. Sent count is 0 and status is `fired`.

This is the window after the new mark and before the provider returns, including a kill during the HTTP call. A kill after the provider has stored an id does not submit again, and the email and Telegram keys differ (`fillip/<id>/<fireAt>` and `fillip/<id>/<fireAt>/telegram`). A retry of the same email occurrence reuses the email key.

### Major: a phrase edit drops the end date

`daily`, `weekdays`, and `weekly` copy the existing end onto the new rule. Any other repeat string is parsed with `resolveWhen` and replaces the recurrence, ends included. The tool text tells the model to pass phrases such as `every 2 weeks` and `first Monday of every month`.

Repro: `every weekday at 9am until March 31, 2027`, then reschedule with repeat `every Monday 9am` and no end argument. Same reminder id. Repeats reads `every Monday at 9:00 AM`. March 31 is gone, so the series no longer stops.

### Minor: a repeat edit quietly resumes a pause

`snoozeOrReschedule` with action `reschedule` sets `status` to `active` and clears `holdUntil` whenever a repeat or end is present. The note only describes the new repeat.

Repro: pause `every weekday at 9am`, then reschedule with repeat `daily`. Status is `active`. Note is `Repeat is now every day at 9:00 AM.`

### Minor: authenticated delivery delete

Unchanged from round 2. `GRANT DELETE` on `public.deliveries` without `SELECT`, and no `SELECT` policy, so `SET ROLE authenticated` raises `42501`. Fail-closed: no cross-user delete. The service-role account delete removes that owner's deliveries, including a digest row with a null reminder id, and leaves the other owner.

## Re-verification

Round-1 blockers, both still fixed: the trial counter does not reset on the UTC month boundary, and an empty hosted count (`416`) is 0.

Round-1 and round-2 items, checked again with new cases where the old fix was narrow:

| Earlier finding | This round |
| --- | --- |
| Hosted workers racing past the monthly cap | Old case still holds (29 of 30 does not become 2 sends). New case does not: two successful sends leave the counter at 0. |
| Reclaim stuck forever after a crash between ticket and status | A lease under 2 minutes stays in progress and can be renewed later. Two renewals of a stale ticket both send. |
| Kill after the provider accepts | A stored provider id is not submitted again. The new attempt mark, written before accept, drops the ping and marks it fired. |
| every-N dying 400 steps out, and one failure aborting the sweep | Fixed. An every-2-days series from 2024-01-01 still has a next fire. 2:30am across 2027-03-14 is 3:30am ET (`2027-03-14T07:30:00.000Z`), not an hour early. One thrown advance does not stop the other reminder. |
| Upgrade not releasing a free-cap hold | Fixed. A monthly hold sends after upgrade. A hold until tomorrow, a 15-minute backoff, and a hold while the global guard is 0/0 do not send. |
| Two creates passing the open cap of 10 | Memory store still refuses. Hosted parallel creates land at 11. |
| Last Friday of every month, calendar newline, digest stop copy | Still green on the unchanged round-2 tests. |
| Authenticated delivery delete | Still `42501`. |
| Empty global guard stays 0/0 | Still fail-closed, and that state is on `/internal/status`, not public `/health`. Not re-filed. |
| DST spring gap and fall overlap | 2027-03-14 2:30am ET is corrected to 3:30 with a "does not exist" note. 2026-11-01 1:30am ET is named ambiguous and is one of the two real instants (`05:30Z` or `06:30Z`). |
| Stop link, Stripe ordering, trial total, local midnight, shared 600/15000 design | Existing tests still green. Not re-broken by this head. |

## Pass / fail by area

| Area | Result |
| --- | --- |
| Ping reservation across workers | Fail. Sequential last-slot holds. Overlapping workers zero the counter. |
| Reclaim lease after a crash | Fail. Fresh lease holds. Stale renewal is not exclusive. |
| Kill after provider accept | Pass for a stored provider id and for per-channel keys. Fail for a crash after the attempt mark and before accept. |
| every-N far from its anchor, and error isolation | Pass. |
| Holds released on upgrade | Pass. Daily holds, short backoffs, and a closed global guard stay held. |
| Open cap of 10 under parallel creates | Fail on the hosted store. Pass on the memory store. |
| Emailed-code sign-in | Pass for what Fillip implements. Expired, invalid, and rate-limit strings map to fixed sentences. Unknown-user and already-registered strings do not say whether the email exists. Google stays hidden unless `FILLIP_AUTH_GOOGLE_ENABLED` is exactly `true` (`TRUE` and `1` stay hidden). Fillip does not store codes, so expiry, reuse, and brute-force limits were not proven against GoTrue. The consent page re-enables the button after a wrong code. |
| 401 on initialize and tools/list | Pass with the documented exception. `initialize` is 401 with `WWW-Authenticate` pointing at `oauth-protected-resource/mcp`. `tools/list` is 200 and includes `securitySchemes`. Those schemes are not in `server.json` or `glama.json`, which is why the catalog stays public. No user data is in that response. `tools/call` stays 401. |
| PKCE S256 and `iss` | Pass. Fillip's protected-resource document does not advertise `plain` or `authorization_response_iss_parameter_supported`. `supabase/README-oauth.md` says Supabase's authorization-server document still advertises `S256` and `plain`, and Fillip cannot remove `plain`. |
| `/health` and `/internal/status` | Pass. `/health` is `{ok, service, version}`. Missing `CRON_SECRET` makes `/internal/status` and `/internal/deliver` 503. A wrong bearer is 401. The right bearer is 200, and the body does not contain the secret. |
| Pause across a due time | Pass. A paused due reminder sends 0. Resume picks one future 9am, a second resume keeps that instant, the job before it sends 0, the job at it sends 1, and the following job sends 0. |
| Delete | Pass for memory and service-role deletes: that reminder's deliveries go, a null-reminder digest row survives a single delete, and the other user is untouched. Account delete removes the owner's digest row too. The authenticated SQL delete is the minor above. |
| Done reminders hidden by default | Pass. Completed and cancelled stay hidden until `include_done`. Paused still shows. |
| Inclusive end dates | Pass. `until January 1, 2027` includes January 1. `until Dec 31, 2026` includes December 31 and not January 1. `until March 14, 2027` includes March 14 at 9am and the corrected 3:30am, and not March 15. |
| Edit a repeat in place | Partial. The same id is kept, and `weekly` keeps March 31. A phrase edit drops the end (major). A paused reminder is resumed without saying so (minor). |
| DST warnings | Pass. Nonexistent 2027-03-14 2:30am ET and ambiguous 2026-11-01 1:30am ET are both named. Neither is a silent earlier hour. |
| Feed rotation | Pass. The old token renders null and `GET /calendar/<old>.ics` is 404. The new URL is 200 with `Cache-Control: private, no-store`. |
| Dollar prices and missing features | Pass for prices. No `$` plus a digit, `USD`, or `dollars` in README, public pages, tool text, the landing page, the consent page, the connect page, `glama.json`, or `server.json`. The privacy line that delivery records keep a ping from being emailed twice is the stale-lease major, not a separate price claim. |

## Not tested live

GoTrue code expiry, reuse, and attempt limits. Real Resend, real Stripe, and ChatGPT or Claude OAuth with their redirect URIs. Production PostgREST compare-and-swap (the hosted double honors `eq` filters and unique `dedupe_key` the way PostgREST does). A production `authenticated` session against the live Supabase project.
