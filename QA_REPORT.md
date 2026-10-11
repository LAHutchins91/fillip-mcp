# Fillip QA round 12

Head: `89d9e4f` (`89d9e4f0b29034c893853eb564138aee552ad10b`) on `cursor/fillip-reminders-55db`.
Product code was not changed. The round-12 tests and this report are the only additions.

The author said 351 tests pass. On Postgres 16.15, with `supabase/schema.sql` applied, that tree is **351 passed, 0 failed**. `npx tsc -p tsconfig.json --noEmit` exits 0. With `tests/qa/round12.test.ts` the suite is **357 passed, 0 failed (357)**.

Severity: **0 blockers, 0 majors, 0 minors**.

Fillip passes code QA.

## Assertion diff

Compared test files from `70519a5` (merged round 11) to `89d9e4f`. Three test files changed: `tests/http.test.ts`, `tests/remove-restore.test.ts`, and `tests/schema-reapply.test.ts`. No `it.skip`, `describe.skip`, or `test.skip`. No test file was deleted. `supabase/schema.sql` did change: `fillip_confirm_send`, the `reminders_cancel_inflight` trigger, delivery status `cancelled`, and `fillip_runtime.last_purge_count` / `last_purge_at`.

Not weakened:

- The missing-provider response in `tests/http.test.ts` is still 503 and now also requires `purged: 4`. The purge RPC must be called exactly once, so `GET /internal/status` cannot purge again. Resend is still not called.
- `tests/remove-restore.test.ts` now requires an in-progress delivery to become `cancelled` on remove, pause, and cancel, and requires the following job to send 0.
- `tests/schema-reapply.test.ts` requires `fillip_confirm_send`, `cancelled` in `deliveries_status_check`, the cancel trigger, and a Postgres check: a removed update cancels the sending row, and a completed update leaves it sending until `fillip_confirm_send` returns false and sets `skipped`.
- The round-10 QA-FAIL body is unchanged (`expect(report.sent).toBe(0)`). On this head that test passes. The round-10 restore QA-PASS strings still require 30 days, the exact prior status, and purge before the provider check.

## What was checked

A granted `send` that is removed, paused, cancelled, or completed before the provider call sends nothing. For each of those four statuses, a both-channel reminder is claimed, the status is changed, and the job is released. Email and Telegram each contain 0 messages for that reminder. The delivery row is `skipped`. A sibling reminder under a daily cap of 1 still sends and becomes `fired`, so the reserved ping was released.

Remove, pause, and cancel mark the in-progress claim `cancelled` before the job continues. On Postgres that update and the delivery change are one transaction: rollback restores the reminder to `active` and the delivery to `sending`. Completed does not cancel the claim. `fillip_confirm_send` then returns false and the row becomes `skipped`.

Twelve parallel workers on one still-active reminder send exactly one email, the summed `sent` count is 1, and the one-time becomes `fired`. Twelve gated remove-versus-send races send 0 for the removed reminder, the claim is `cancelled` before the gate opens, and a later reminder under a daily cap of 1 still sends. Twelve Postgres races of `fillip_confirm_send` against `status = removed` never leave a delivery as `sent` and never leave a still-active reminder without its `sending` row. A deadlock (`40P01`) from the lock order is allowed; any other error is not.

`GET /internal/status` with no `CRON_SECRET` is 503 `Status is not configured.` and issues no fetch. A wrong bearer is 401 `Status authorization failed.` and issues no fetch. The right bearer returns 200 with the recorded purge count, and every request is a GET. None is a POST, PATCH, DELETE, purge, reserve, or confirm.

Copy walk of `README.md`, `src`, `public`, `glama.json`, `server.json`, and `supabase/README-oauth.md` found no `$` prices, `USD`, `dollars`, `SMS`, Slack notification, push notification, WhatsApp, or iMessage. README still says the purge runs before the email provider check, that `GET /internal/status` does not delete anything, and that account deletion removes rows immediately. The earlier Postgres restore, cap, RLS, sign-out, lockout, and PKCE cases passed on this head.
