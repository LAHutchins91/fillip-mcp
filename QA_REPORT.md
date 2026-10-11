# Fillip QA round 5

Head: `8231447` (`82314471e278453607b9755ba6c7c4e4796f6252`) on PR #1.
Product code was not changed. New tests and this report are the only additions.

The author said 234 tests pass, the six round-4 failures pass unweakened, and the build is clean. Before `tests/qa/round5.test.ts`, this head is **234 passed, 0 failed**. `npx tsc -p tsconfig.json --noEmit` exits 0. With the new file the suite is **247 passed, 2 failed (249)**.

Severity: **0 blockers, 2 majors, 0 minors**.

Cap races and the daily counter use Postgres 16 at `127.0.0.1`, role `fillip_qa`, database `fillip_round5`, loaded from `supabase/schema.sql`. Each race uses its own sessions (12, or 16 for the empty-account mix). Delivery races use one shared delivery row and a separate store per worker. Each save waits on a real Postgres round trip before the write is visible. That is the same window hosted workers have between the claim read and the later update. `beginSend` stays in memory on each store, which is how separate Node processes behave.

## Assertion diff

Compared test files from `0cb8712` (`qa/bellion-fillip-4`) to `8231447`.

- `tests/qa/round3.test.ts` and `tests/qa/round4.test.ts` have an empty diff. The six round-4 `QA-FAIL` tests were not edited, and all six pass on this head.
- No `it.skip`, `describe.skip`, `test.skip`, `xit`, or `xdescribe` under `tests/`.
- `tests/qa/round2.test.ts` adds `expect(rejected).toHaveLength(1)` on the two-way create race. That is stricter. The kill-after-accept test used to expect 0 later sends. It now expects 1 send with the same idempotency key. That replaces the old "do not call the sender" check with the 24-hour retry. It is not a loosened bound: the new expect is length 1 and the keys must match. The test name still says the occurrence is not submitted again.
- `tests/oauth-resource-hook.test.ts` changes the fixture method string to `oauth_provider/authorization_code`, stores `approved_at`, and adds a case: an unexpired authorization for a different resource leaves the audience as `authenticated`; an expired other resource, or a null resource, still binds the exact one. No previous expect was removed.
- `tests/schema-reapply.test.ts` adds the 5-argument `fillip_reserve_ping` case (first call 1, second call -1, then the 3-argument call returns 2).
- `tests/oauth-pkce-consent.test.ts` is new. `tests/http.test.ts` is unchanged.

No round-3 or round-4 assertion was weakened, skipped, or deleted.

## Suspect: the post-insert pass

**Major.** The pass was not removed. `SupabaseFillipStore.dropInsertedIfOverCap` still runs after a successful insert. If the active list comes back longer than `open.cap`, it deletes only `saved.id` and does not throw. `createReminder` then `return saved`. `createOrRefuse` turns that into a reminder view. The tool wrapper does not set `isError`.

A caller can get a success for a row that was just deleted. `set_reminder` returned `isError: undefined` and this body:

`status: "active"`, `what: "should not stick"`, `state: "active"`, `note: "Fillip will email the verified address on this account."`

The sibling test uses the same double: `setReminder` resolves with that id, `getReminder` of the id is null, and the older id in the same list is still stored. The delete filter was only the inserted id.

The pass does not have to be the thing that enforces the cap. The `BEFORE INSERT OR UPDATE` trigger already does that when the profile cap and `open.cap` match. After the mixed Postgres races, every id a successful insert or resume returned was still `active`, and the open count was exactly the cap (10 free, 100 trialing). In that situation the list the pass reads is not longer than the cap, so the delete branch does not run. The function still returns the row whenever the branch does run. A hosted read that is longer than the cap — a lagging count, a missing trigger, or an app cap below the trigger cap — is enough. The fix is to delete that pass, or to throw the cap error instead of returning the row.

It cannot delete a row a concurrent call already returned under a different id. The `DELETE` is `id=eq.<this call's id>`.

## Findings

| Severity | What happens | Expected | Actual | Test |
| --- | --- | --- | --- | --- |
| Major | Post-insert list is longer than the cap | Throw the cap error, or do not delete | Deletes the inserted id and the tool returns that row as `status: "active"` | `QA-FAIL: a hosted read over the cap deletes the inserted row and still returns it as saved` |
| Major | Telegram attempt is past the 2-minute lease, 12 workers | List shows not delivered, and exactly one notice email | List shows `delayed` and "not delivered". Telegram is not called. The notice email is sent 12 times | `QA-FAIL: telegram past the lease lists not delivered and sends exactly one email notice under parallel workers` |

### Major: the tool returns a reminder that was deleted

Repro:

1. Hosted `POST /rest/v1/reminders` returns the inserted row.
2. The pre-insert active count stays under 10, so `gate` allows the create.
3. The post-insert `GET` of active ids returns more than 10 ids and includes the new id.
4. Call `set_reminder`.

`dropInsertedIfOverCap` issues `DELETE` for that id only. The tool result is a normal reminder view, not `isError`. A following read of the id is empty. The older id is untouched.

### Major: parallel workers each email the Telegram miss

Repro:

1. One due Telegram reminder. Its delivery row has `provider_id = "attempt"` and `started_at` three minutes before the job.
2. Twelve stores share that reminder, that delivery row, and the contact. Each store has its own in-flight set. `saveDelivery` waits on a Postgres round trip before the not-delivered write is visible, so every worker still sees `attempt` when it claims.
3. Run the twelve jobs together.

`list_reminders` shows `status: "delayed"` and a note containing "not delivered". `sendMessage` is not called. All 12 email sends use `fillip/<id>/<fireAt>/not-delivered`. The notice does not insert a delivery row before sending, and `beginSend` does not cross processes, so the second worker is not told the first one already sent. Resend would be the only collapse, and only if those 12 calls hit it while the key is still inside 24 hours. The app itself sends 12.

## Round 4, checked again

| Round 4 finding | On 8231447 |
| --- | --- |
| Silent drop after the lease | Fixed for the cases below. The two old `QA-FAIL` tests pass unchanged. |
| Resume walks past the open cap | Fixed. The trigger is `BEFORE INSERT OR UPDATE` and only counts a row that is newly becoming active. |
| Post-insert pass deletes an older row on a timestamp tie | Fixed. The old `QA-FAIL` passes. The pass now deletes only the inserted id, and that return is the new major above. |
| Loser of the open cap is told the reminder was saved | Fixed. `createOrRefuse` no longer catches `OpenCapError`. Both the memory `OpenCapError` path and a P0001 / plain "The free plan allows 10 open reminders." error are tool errors (`isError: true`, no `status: "active"`). |
| Daily cap is a read, then a monthly lock | Fixed inside the 5-argument `fillip_reserve_ping`. Twelve sessions at 99 of 100 daily: one positive return, eleven `-1`, `emails_sent_today` is 100, and the monthly counter moves by 1. |

One-time email, attempt three minutes old (inside 24 hours): one send, key `fillip/<id>/<fireAt>`, the reminder is still `active` at the moment of send, then `fired`. A later job sends 0. An attempt older than 24 hours sends 0 and the delivery error matches "not delivered".

Twelve workers on that same one-time retry each call send with that one key (12 calls on this run). A job after the provider id is stored sends 0. That matches the README: Resend treats a repeat of `fillip/<id>/<fireAt>` as the same send. It is not filed. The single-worker path already sends once, and nothing is sent again after the accept is stored.

Repeating email past the lease: the user is told on the list. `status` is `delayed` and the note is `This ping was not delivered. It was delayed and could not be sent.` The series moves to the next fire time. No ping is sent and no notice email is sent. The miss is only on the list.

Resume at 10 open is a tool error and the paused row stays paused. Editing `what` on an already-active row at the cap does not raise.

## Regression

The author suite on this head, which includes the round-3 file and the round-4 file unchanged, is 234 passed, 0 failed. That covers the round-3 and round-4 passes: phrase edits keep `until`, paused stays paused, S256-only, consent before redirect, audience binding, grants, the spring-gap and fall-back clocks, `delete_reminder`, per-call logs, copy, and `tools/list` public with the other MCP methods returning 401. The new consent file and the new audience case passed in that suite.

## Not exercised here

GoTrue one-time codes, a live Resend send, a live Telegram `sendMessage`, Stripe webhooks, and a hosted PostgREST instance. The cap and daily races ran on Postgres with `schema.sql`. The post-insert major used a hosted double that returns a long active list after the insert. The notice major used the product delivery loop with the row shared across 12 stores.
