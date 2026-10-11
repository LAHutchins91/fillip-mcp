# Fillip QA round 4

Head: `01eec0e` (`01eec0e6ed1ad92e7f7e99a4d0a2a16ed5f09c7b`) on PR #1.
Product code was not changed. New tests and this report are the only additions.

The author said 209 tests pass, with rounds 3 and 4 merged. On a database that still had the previous grants, the suite at this head was **208 passed, 1 failed (209)**. The failure was the old deliveries delete test: that database had `DELETE` without `SELECT`. Applying `supabase/schema.sql` from this commit grants both, and that test passes. The suite at this head, before the new file, is **209 passed, 0 failed**. With `tests/qa/round4.test.ts` the suite is **225 passed, 6 failed (231)**.

Severity: **0 blockers, 4 majors, 1 minor**.

Concurrency cases in the new file use Postgres 16 at `127.0.0.1` with role `fillip_qa` and a database loaded from `supabase/schema.sql`. They are not the in-memory `hostedDb` double. Each race uses 12 workers.

## Assertion diff

Compared test files from `c228d6b` (`qa/bellion-fillip-3`) to `01eec0e`.

- `tests/qa/round2.test.ts` and `tests/qa/round3.test.ts` are unchanged. `QA-FAIL` names that now pass were not edited. The product now meets those assertions.
- No `it.skip`, `describe.skip`, `test.skip`, `xit`, or `xdescribe` under `tests/`.
- `tests/crud.test.ts` adds the paused next-send note and the spring-gap `accept_shifted_time` case.
- `tests/delete-owner.test.ts` tightens the policy matcher to `(select auth.uid())`, which matches the schema.
- `tests/http.test.ts` adds `delete_reminder` to the catalog, requires the 401 body `Authentication required.`, and adds PKCE and consent checks. `invalid_token` is required only when a token was presented.
- `tests/oauth-resource-hook.test.ts` and `tests/schema-reapply.test.ts` are new. They do not replace an earlier expect.

No assertion was weakened, skipped, or deleted.

## Findings

| Severity | What happens | Expected | Actual | Test |
| --- | --- | --- | --- | --- |
| Major | Attempt mark is older than the 2-minute lease and the provider never accepted | A delayed or failed notice, or a list status that is not a successful send | One-time reminder becomes `fired`, zero emails, note is null. A daily series moves to the next day and stays `active` with no note | `QA-FAIL: after the two-minute lease a never-accepted ping is dropped without a failed or delayed notice` and `QA-FAIL: a repeating occurrence past the lease is skipped with no failed notice` |
| Major | Resume while 10 reminders are already open | Stay at 10, and the caller is refused | 12 parallel `UPDATE status = 'active'` calls leave 22 open. The app resume returns `Resumed. Next ping is Monday, October 12, 2026 at 9:00 AM.` and leaves 11 open | `QA-FAIL: resuming paused reminders walks past the open cap because the trigger is insert-only` and `QA-FAIL: the app resume path also turns a paused reminder back on when the account is already at 10` |
| Major | Post-insert cap pass when `created_at` ties | Delete the new row and return an error | Deletes an older row (tie broken by id) and returns the new reminder | `QA-FAIL: the post-insert cap pass can delete an older row when timestamps match and still report success` |
| Major | 12 parallel creates when 9 are already open | The losers throw | 11 calls return a view with `status: "active"` and the cap sentence as `note`, for ids that were not stored | `QA-FAIL: a caller that loses the open cap is told the reminder was not saved` |
| Minor | Daily cap under parallel workers | At most the daily limit | `reserveSend` reads `countSentSince` and then calls `fillip_reserve_ping`, which locks only the monthly counter | Code review of `SupabaseFillipStore.reserveSend`. Not executed as a 12-worker send |

### Major: a stale attempt is a silent drop

Inside the lease, `provider_id === "attempt"` is retried with the same idempotency key, and `retryingAttempt` keeps the reminder due. That part holds: a fresh attempt is sent once. `QA-FAIL: a crash after the attempt mark and before the provider accepts does not skip that ping` now passes, and the new fresh-attempt test passes.

After 2 minutes (`STALE_MS` and `CLAIM_LEASE_MS`), `claimDelivery` returns `already-sent` without calling the provider. `retryingAttempt` stays false, so `advanceIfSent` marks a one-time reminder `fired` or steps a series forward. `list_reminders` shows that status. The note is null. Twelve parallel jobs on one stale attempt sent 0 emails.

Repro, one-time: delivery row `provider_id = "attempt"`, `started_at` three minutes ago, reminder still due. Run the job. Sender length is 0. List status is `fired`.

Repro, series: same mark on `every day at 9am`. Sender length is 0. `fireAt` moves to the next day. List status stays `active` and the note is empty.

This is silent. The user does not get a delayed or failed notice.

**Email retry after the lease is safe for 24 hours.** The key is `fillip/<reminder id>/<fireAt>`. Resend treats that key as idempotent for 24 hours: a retry returns the original response and does not send a second copy. Fillip should keep retrying email with that same key until the key expires, and only then show a failed or skipped row. Treating a stale attempt as already-sent is what drops the ping.

**Telegram double-send window: 2 minutes, and not longer.** `sendMessage` does not honor the idempotency key (`src/lib/telegram.ts`). While `provider_id` is still `"attempt"` and `started_at` is inside the lease, a second claim returns `send`, so Telegram can deliver a second copy. A claim 3 minutes after the mark returns `already-sent`, so there is no second Telegram send and also no retry. The window is the open interval from Telegram's accept until the message id replaces `"attempt"`, capped by the 2-minute lease.

### Major: resume walks past the open cap

`fillip_enforce_open_cap` is a `BEFORE INSERT` trigger. It locks `pg_advisory_xact_lock(hashtext(owner))` and `SELECT ... FROM profiles FOR UPDATE`, counts active rows, and raises. It does not delete. Inserts of a non-active row return immediately.

Repro, SQL: 10 active rows and 12 paused rows. Twelve connections `UPDATE` the paused rows to `active`. Every update returns a row. Active count is 22. No error.

Repro, app: free plan, 10 active, pause one, create one, resume the paused one. The reply is `Resumed. Next ping is Monday, October 12, 2026 at 9:00 AM.` Active count is 11. `snoozeOrReschedule` does not consult the cap on resume.

Parallel inserts themselves hold. See verdict (b).

### Major: the post-insert pass can delete an older row

`SupabaseFillipStore.reconcileOpenCap` runs after a successful insert. It sorts active rows by `created_at`, then `id`, keeps the first `cap`, and deletes the rest. It throws `OpenCapError` only when the row just inserted is not in the keep set.

Repro: 10 older rows and the new row share one `created_at`. The new id sorts first. The pass deletes the older id that sorts last, and `createReminder` returns the new reminder. The caller is not told that an older reminder was removed.

The insert trigger stops a pure insert race from reaching this pass. A resume between the insert commit and this list can still make the list longer than the cap, which is when this sort runs.

### Major: a lost create is returned as a saved reminder

`createOrRefuse` catches `OpenCapError` and, when the active count is already at the cap, returns `view(...)` with `status: "active"` and the cap sentence as `note`. The tool wrapper sets `isError` only for thrown errors.

Repro: free plan, 9 active reminders, 12 `setReminder` calls that all read the count before any insert. One reminder is stored. The other 11 resolve with views whose ids are not in the store. Each view is `status: "active"` and the note is `The free plan allows 10 open reminders. Upgrade to Pro for a higher allowance. The trial is 14 days, then Pro.`

A database raise from the trigger is not an `OpenCapError`. That path still throws, and `publicError` returns 429 with the raise text because it contains `The free plan`. The false success is the `OpenCapError` path used by the memory and file stores and by the post-insert pass.

### Minor: the daily cap is still a read, then the monthly lock

`fillip_reserve_ping` locks the profile row and stops at the monthly count. That part holds under 12 workers (below). `reserveSend` still calls `countSentSince` and the global counts before the RPC. Those reads are not in the locked update. On a plan where the daily limit binds first (Pro is 100 a day and 1000 a month), workers that all see 99 sent can all pass the RPC and all send.

## Verdicts

### (a) Crash recovery

Yes. After the 2-minute lease the ping is dropped silently. List shows `fired` for a one-time reminder, or the next occurrence for a series, with no failed or delayed note, and the provider is not called.

Retrying email with the same `fillip/<id>/<fireAt>` key for up to 24 hours is the safe fix. Resend will not send a second copy.

The Telegram double-send window is 2 minutes: a second claim while the mark is still `attempt` and still inside the lease returns `send`, and Telegram will not dedupe. After the lease, Telegram is not called again.

### (b) Open cap

The trigger does not delete. It raises before the insert, so the new row is never written and older rows stay.

Proven on Postgres with 12 workers:

- Nine older rows plus 12 inserts that all use the same `created_at`: 10 active rows, the original nine still present, one new row, 11 errors `The free plan allows 10 open reminders.`
- Empty account, 12 inserts, same timestamp: exactly 10 succeed and 2 raise that same error.
- Trialing account, 99 older rows, 12 inserts: 100 active, all 99 older rows remain, the rest raise `Too many reminders are still open.`

The post-insert pass does not have that property. On equal timestamps it can delete an older row and return success. Resume does not go through the trigger, so the cap does not hold for pause then resume.

A trigger raise is an error to the caller. An `OpenCapError` is not: `setReminder` returns a saved-looking view.

### (c) tools/list is public

Holds in code and over HTTP. `publicMethods` is only `tools/list`.

`POST /mcp` `tools/list` is 200 and includes `delete_reminder` with `destructiveHint: true`. `initialize`, `tools/call`, `resources/list`, `ping`, and `notifications/initialized` are 401 with `WWW-Authenticate` pointing at `oauth-protected-resource/mcp`, without `invalid_token` when no token is presented, and the body is `Authentication required.` `GET /mcp` is 401.

## Round 3, re-checked

| Round 3 item | This build |
| --- | --- |
| Hosted open cap of 10 on parallel inserts | Fixed for inserts. The trigger holds under 12 workers, including equal timestamps. Resume still bypasses it (major above). |
| Two workers wipe the monthly counter | Fixed. 12 workers × 4 calls, cap 30: exactly the counts 1 through 30, 18 nulls, stored counter 30. A further 12 calls return null and the counter stays 30. |
| Stale claim lease sends twice | Fixed. 12 workers, one stale sending row, unique `dedupe_key`: exactly one `send`. |
| Crash after the attempt mark | Fixed inside the 2-minute lease (one retry, same email key, reminder not skipped). After the lease it is the silent-drop major. |
| Phrase edit drops `until` | Fixed. Parallel edits `every 2 weeks`, `first Monday of every month`, `every Monday 9am`, and `weekly` keep March 31, 2027. |
| Paused reminder resumes on edit | Fixed. Those edits leave `status: paused`. The list note matches `paused (would next send `. |
| Authenticated delete of own deliveries | Fixed once `schema.sql` is applied. `SELECT` and `DELETE` are granted, the other user's row stays, and the old assertion passes unchanged. |

## New behavior

| Area | Result |
| --- | --- |
| S256 only | Pass. `plain`, `s256`, empty method, and a missing challenge are `invalid_request`. `S256` is accepted and forwarded. |
| Consent before redirect | Pass. The consent section is unhidden before any `redirect_url` assignment. The old auto-redirect snippet is gone. |
| Exact resource audience | Pass. The configured resource matches. A path prefix, another host, a query string, and `http` instead of `https` throw `Reconnect Fillip`. |
| Grants | Pass. `has_table_privilege` for `anon` is false for `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on every public table. `authenticated` has no `INSERT` or `UPDATE` on any public table. `reminders`, `deliveries`, and `digest_settings` have `SELECT` and `DELETE`. `profiles` has `SELECT` only. `fillip_runtime` and `fillip_support_requests` have none. `service_role` can execute `fillip_reserve_ping`. `authenticated` cannot. |
| `accept_shifted_time` | Pass for the spring gap. `March 14, 2027 at 2:30am` in `America/New_York` throws `WhenError` without the flag and saves `2027-03-14T07:30:00.000Z` with a "does not exist" note when the flag is true. `November 1, 2026 at 1:30am` saves without the flag and the note says the clock is ambiguous. That matches the tool text, which reserves the flag for a clock that does not exist. |
| `delete_reminder` | Pass. `tools/list` has `destructiveHint: true`. Deleting one user leaves the other user's reminder. |
| Paused next send | Pass. The list note contains `paused (would next send `. |
| Per-call logs | Pass. The `mcp` JSON line has the tool name and not the bearer, the account email, the reminder text, or a feed token. |
| Copy | Pass. No `$` plus a digit, `USD`, or `dollars` in the README, public pages, tool text, landing page, consent page, connect page, `glama.json`, or `server.json`. Those files do not advertise SMS, Slack, or push notifications. |

## What this run did not hit

GoTrue OTP expiry, reuse, and brute force. A live Resend or Telegram call. Stripe signature traffic. A ChatGPT or Claude OAuth browser. Production PostgREST. The daily-cap race above was read from `reserveSend` and was not driven through 12 real sends.
