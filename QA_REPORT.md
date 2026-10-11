# Fillip QA round 6

Head: `09f5abd` (`09f5abdcf7ee24aa54c1889c7a3c28bfedb2c943`) on PR #1.
Product code was not changed. New tests and this report are the only additions.

The author said 251 tests pass. Before `tests/qa/round6.test.ts`, this head is **251 passed, 0 failed**. `npx tsc -p tsconfig.json --noEmit` exits 0. With the new file the suite is **262 passed, 1 failed (263)**.

Severity: **0 blockers, 1 major, 0 minors**.

Fillip does not pass code QA. The round-5 success-view and duplicate-notice majors are fixed. One over-cap invariant is not: a cap error can be returned for a row that was kept.

Cap, daily, and notice-claim races use Postgres 16 at `127.0.0.1`, role `fillip_qa`, database `fillip_round6`, loaded from `supabase/schema.sql`. Each insert race uses its own session (12 clients). The notice claim uses a pool of 16 and 14 parallel `claimNotice` calls. The hosted over-cap cases use a double that answers the same PostgREST paths `refuseIfReadOverCap` calls.

## Assertion diff

Compared test files from `cd55d42` (`qa/bellion-fillip-5`) to `09f5abd`. Seven test files changed (`+268/−37`). No `it.skip`, `describe.skip`, `test.skip`, `xit`, or `xdescribe`.

Accepted, and checked on this head:

- `tests/qa/round4.test.ts` renames the tied-timestamp case and expects the free-plan cap error, including the upgrade sentence, with `deleted` equal to `[freshId]`. Older ids stay out of `deleted`. That matches the new design. The test passes inside the 251.
- `tests/qa/round5.test.ts` renames the sibling and expects the same throw, `deleted` length 1 equal to this call's id, the older id still stored, and `getReminder` of the new id null. That passes inside the 251. The round-5 Telegram `QA-FAIL` was not edited, and it passes on this head.
- `tests/qa/round3.test.ts` changes the trigger-less hosted double from "active ≤ 10" to "9 or 10 active, the original 9 remain, at least one rejection, and every fulfilled id is still stored." That range is accepted for the double. Real Postgres does not use the range: twelve parallel inserts at nine open leave exactly ten (one success, eleven raise the free-plan sentence, all nine older rows remain).
- `tests/schema-reapply.test.ts` and the round-4 reserve calls pass `null::integer, null::timestamptz` because the 3-argument `fillip_reserve_ping` was dropped. The reapply test now expects that identity to be gone, and a second daily call at the cap still returns `-1`. That is tighter, and it matches the schema. Calling the old 3-argument form throws. A newer `day_start` resets `emails_sent_today` to 1.

Judged, not filed:

- Consent HTML order changed in `tests/qa/round4.test.ts`, `tests/http.test.ts`, and `tests/oauth-pkce-consent.test.ts`. The old expect was: unhide consent before any `redirect_url` assignment, and do not contain `if(details.data.redirect_url){location.assign(...)}`. The new expect requires `if(details.data&&details.data.redirect_url){location.assign(details.data.redirect_url);return}` before the PKCE proof fetch, before the client read, and before `el('consent').hidden=false`. `supabase/README-oauth.md` states that when the details already include `redirect_url` the page assigns it immediately and does not approve again, because a second approve burns the single-use code. When `redirect_url` is absent, Connect is still shown. Fillip's own `GET /oauth/authorize` still rejects `plain` and a missing S256 challenge. This replaces the round-4 "consent before any redirect" check. It is a documented contract change, not a silent weaken of an unchanged path.
- `tests/oauth-signin.test.ts` adds a vm check that sign-in uses `signInWithOtp` with `shouldCreateUser: true` and `verifyOtp` of type `email`. Nothing previous was removed.

## Round-5 majors, checked again

| Round 5 finding | On 09f5abd |
| --- | --- |
| A hosted read over the cap deletes the inserted row and still returns it as saved | Fixed for the success-view half. The tool is `isError`, the body has no `"status":"active"`, `deleted` is `[own id]`, the older id stays active, and a later read of the new id is empty. A list inside the cap returns the new row and deletes nothing. The kept-row half below is the remaining major. |
| Telegram past the lease emails the miss once per worker | Fixed. Fourteen workers that do not share a process send one notice. A later job sends 0. Telegram `sendMessage` is not called. |

## Findings

| Severity | What happens | Expected | Actual | Test |
| --- | --- | --- | --- | --- |
| Major | The over-cap DELETE is acknowledged and the new row is still stored | Do not return the cap error for a row that was kept | Throws the free-plan error and `getReminder` still returns that row as `active` | `QA-FAIL: a cap error is not returned when the delete leaves that row in place` |

### Major: a cap error for a row that was kept

`refuseIfReadOverCap` deletes `id=eq.<saved.id>` and then always throws `OpenCapError`. It does not read the row back. PostgREST answers a DELETE that matches nothing with success (`Prefer: return=minimal` is an empty 204). The function comment says the throw exists so the caller is not told it failed while that row stays due. The throw still happens when the row stays.

A list that is already inside the cap returns without deleting. On real Postgres the `BEFORE INSERT OR UPDATE` trigger holds the same cap, so this branch does not run for a normal insert. The branch runs when the active list comes back longer than `open.cap`. If that DELETE then matches nothing, the tool error and the live reminder disagree.

Repro:

1. The pre-insert active count stays under 10, so the create is allowed and the insert returns the new row.
2. The post-insert active list is longer than 10.
3. `DELETE` for the new id is acknowledged and does not remove the row.
4. Call `setReminder` with `what: "still due"`.

The call throws `The free plan allows 10 open reminders...`. `getReminder` of the deleted id still returns `status: "active"`. The older id is not deleted. The user is told the reminder was not saved, and it remains due.

## What passed

Over-cap, when the DELETE does remove the row: `set_reminder` is `isError: true`, the text matches the free plan, there is no `"status":"active"`, `deleted` is exactly the inserted id, and the older id is still active.

Telegram not-delivered notice: 14 parallel memory workers send exactly one email, key `fillip/<id>/<fireAt>/not-delivered`. A retry job sends 0. `createResendSender` puts that key on the `Idempotency-Key` header. On Postgres, 14 parallel `claimNotice` inserts produce one row. A later claim returns false. Email and Telegram ping rows for the same occurrence still insert beside that one `not-delivered` row. The partial unique index is `(reminder_id, occurrence_at, kind) WHERE kind = 'not-delivered'`.

A missed repeating email in `America/New_York`, fire time `2026-10-11T15:30:00.000Z`, lists `delayed` and `Your 11:30 AM ping on Oct 11 couldn't be sent.` plus `NOT_DELIVERED_NOTE`. The note does not say `3:30 PM`. Zero provider sends. A one-time email three minutes past the lease is retried once on `fillip/<id>/<fireAt>` and the list says Fillip retried it, without that repeating line. A one-time attempt older than 24 hours sends 0 and lists `NOT_DELIVERED_NOTE` without that line. A repeating Telegram miss lists `NOT_DELIVERED_NOTE` and does not say `11:30 AM`.

## Regression sweep

The 251 already re-ran the earlier suites, including the rewritten cap and consent expects. No skip was added. Extra adversarial cases on this head:

| Earlier area | Case | Result |
| --- | --- | --- |
| Open cap (rounds 3–5) | 12 real inserts at 9 open | Exactly 10 active. The original 9 remain. Eleven raise the free-plan sentence. |
| Daily counter (rounds 4–5) | Call the dropped 3-argument reserve, then a new local day at a full daily counter | The 3-argument call throws. `emails_sent_today` becomes 1. |
| Notice claim (round 5) | 14 workers, then a retry, with both ping channels already stored | One claim wins. The retry loses. Both ping rows remain. |
| Over-cap read (round 5) | Delete removes the new id; a second case stays inside the cap | Error and no success view; the inside-cap row is returned and nothing is deleted. |
| Missed ping (round 5) | Repeating email, one-time inside 24h, one-time past 24h, repeating Telegram | Local time only on the repeating email. One retry key inside 24h. No second Telegram send. |
| DST (rounds 3–4) | 14 March 2027 2:30am and 1 November 2026 1:30am, America/New_York | Gap is refused and nothing is stored. The fold saves and the note says ambiguous. |
| End date and pause (rounds 2–3) | `every 2 weeks until March 31, 2027`, then pause, then `repeat: weekly` | `ends.until` is the exclusive instant `2027-04-01T00:00:00.000Z`. The row stays paused. |
| PKCE and copy (rounds 3–4) | `plain`, empty S256, and a walk of README, src, public, glama.json, server.json | `plain` and a missing challenge are `invalid_request`. S256 with a challenge is accepted on Fillip's route. No `$`+digit, USD, or dollars. No SMS, Slack notification, push notification, WhatsApp, or iMessage. |

Copy does not advertise a channel or a price that is not implemented. The README says this page does not print a price, and it says Telegram tools are absent when the bot token is unset.
