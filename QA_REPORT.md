# Fillip QA round 11

Head: `19c625b` (`19c625b643abc29c1b4a94125981928fa8009eed`) on `cursor/fillip-reminders-55db`.
Product code was not changed. The round-10 tests, the round-11 tests, and this report are the only additions.

The author said 326 tests pass. On Postgres 16.15, with `supabase/schema.sql` applied, that tree is **326 passed, 0 failed**. `npx tsc -p tsconfig.json --noEmit` exits 0. With `tests/qa/round10.test.ts` and `tests/qa/round11.test.ts` the suite is **349 passed, 1 failed (350)**. The failure is the unchanged round-10 QA-FAIL.

Severity: **0 blockers, 1 major, 0 minors**.

Fillip does not pass code QA.

## Assertion diff

Compared test files from `dda2ed4` to `19c625b`. Three test files changed: `tests/remove-restore.test.ts`, `tests/http.test.ts`, and `tests/schema-reapply.test.ts`. No `it.skip`, `describe.skip`, or `test.skip`. No test file was deleted.

Not weakened:

- The new remove/restore cases add the five prior statuses, `Already restored.`, another user's id, and a job that sends only for an active restore. They do not replace an older expect with a looser one.
- `tests/http.test.ts` adds the purge-before-provider case. The provider-missing response is still 503 `Email provider is not configured.` and Resend is still not called.
- `tests/schema-reapply.test.ts` now also requires `cancelled` and `completed` in `reminders_resume_status_check`.
- The round-10 QA-FAIL bodies are unchanged. The status and cap QA-FAILs now pass. The in-flight send QA-FAIL still fails the same way (`sent` is 1).
- Two round-10 QA-PASS strings were retargeted because this commit replaced them. The restore tool sentence now names the exact prior status, the open cap, and no send for a cancelled or completed reminder. The README sentence now says `fillip_purge_removed` runs before the email provider check and still deletes removed reminders older than 30 days. The immediate account-deletion sentence is unchanged.

## Major

A claim that has already returned `send` still emails the reminder after it is removed.

Repro: a due reminder, `claimDelivery` returns `send`, the row is set to `removed` before the provider call, and `runDueJob` sends 1 email. `src/lib/deliver.ts` reads the row only to build the message (`getReminder` at line 675) and calls `sender.send` at line 678 without checking that the row is still active. A later claim is withheld, and `fillip_claim_sendable` is false for a removed row. This commit moved the purge to the start of `runDueJob` and added `purged` to the report. It did not change the send path.

## What was checked

Restore returns each prior status:

- Active: a daily series removed after five missed days comes back as the next future time, one row, not a burst. A job at the restore instant sends 0. A job at that next time sends exactly 1. A past one-time stays removed and keeps its `removedAt` and `fireAt`. At 10 open reminders the active restore throws the free-plan cap error and does not write. On Postgres, an update back to `active` at that cap rolls back.
- Paused: stays paused, keeps the old `fireAt` and `holdUntil`, skips the cap, stays off the calendar, and is not emailed when the fillers send.
- Cancelled, completed, and fired: same id, same `fireAt`, same `completedAt`, note `Restored. It will not send.` Cancelled and completed stay off the default list. Fired stays on that list, which is the existing rule for a fired row. None of the three is on the calendar. A job at a due time emails only the 10 open fillers. On Postgres the check constraint accepts `fired`, `completed`, and `cancelled`, those updates succeed while 10 rows are active, the open count stays 10, and `fillip_claim_sendable` is false for each.

A second restore, including one a minute later and one that was never removed, returns `Already restored.` and does not change status, `fireAt`, or `updatedAt`. Another user's id and an unknown id throw `Reminder not found` and leave the row removed. A cancelled or fired row removed for 30 days plus 1ms throws `That reminder can no longer be restored.` and is not written. A cancelled row removed for exactly 30 days comes back cancelled. A null `resumeStatus` is refused and stays removed.

Purge runs before the provider check. `runDueJob` deletes a row removed more than 30 days ago before it throws on a blank sender, and before `sender.send` on a normal run. A row removed at exactly 30 days is kept. The expired row is not emailed. `GET /internal/deliver` with a bad bearer is 401 and does not call the purge. A missing `CRON_SECRET` is 503 `Delivery is not configured.` and does not call the purge. When the purge call throws, the response is still 503 `Email provider is not configured.` and the error text is not in the body.

Copy walk of `README.md`, `src`, `public`, `glama.json`, `server.json`, and `supabase/README-oauth.md` found no `$` prices, `USD`, `dollars`, `SMS`, Slack notification, push notification, WhatsApp, or iMessage. Privacy still says the 30-day keep is followed by deletion, and that export, delete, and account deletion remove rows immediately. No test file is skipped. The earlier Postgres claim, purge, cap, RLS, sign-out, lockout, and PKCE cases passed on this head.
