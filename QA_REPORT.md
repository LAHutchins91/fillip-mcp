# Fillip QA round 10

Head: `dda2ed4` (`dda2ed4b671cc6da094d6e268b72141e1d48cbdc`) on `cursor/fillip-reminders-55db`.
Product code was not changed. New tests and this report are the only additions.

The author said 323 tests pass and PR #10 is merged. Before `tests/qa/round10.test.ts`, this head is **323 passed, 0 failed**. `npx tsc -p tsconfig.json --noEmit` exits 0. With the new file the suite is **335 passed, 3 failed (338)**. The 3 failures are the new `QA-FAIL` tests. Postgres is 16.15 with `supabase/schema.sql` applied.

Severity: **0 blockers, 2 majors, 0 minors**.

Fillip does not pass code QA.

## Assertion diff

Compared test files from `30e0bd2` (`qa/bellion-fillip-9`) to `dda2ed4`. Ten test files changed, including new `tests/remove-restore.test.ts`. No test file was deleted. No `it.skip`, `describe.skip`, `test.skip`, `xit`, or `xdescribe`.

Not weakened. The edits follow the soft-remove contract:

- A remove keeps the row and its deliveries and says it can be restored for 30 days. Round 3 still deletes that row and its deliveries after 31 days, and a digest delivery stays.
- `remove_reminder` is `destructiveHint: false` and `idempotentHint: true`. Round 4 still checks that the other user's row stays active.
- Round 7 still forbids "permanently", "erases", and "cannot be undone". Its three `QA-FAIL` bodies are still there.
- The two round-8 `QA-FAIL` bodies are still there. Their production boot now passes a 32-character `FILLIP_PKCE_SECRET` so the lockout check is what the test measures.
- Round 9's lockout source check is unchanged.
- `tests/code-auth.test.ts` adds the 401 bad bearer, the 403 MCP token, and the 502 that does not echo GoTrue.

The other 25 test files passed on this head.

## Majors

1. A claim that has already returned send still emails the reminder after it is removed. Repro: a due reminder is claimed, `claimDelivery` returns `send`, and the row is set to `removed` before the provider call. `runDueJob` sends that email. A later claim is withheld, and `fillip_claim_sendable` is false for a removed row. `src/lib/deliver.ts` reads the row to build the message and does not check that it is still active.

2. Cancel or complete, then remove, then restore brings the reminder back active. Repro: `complete_or_cancel` with cancel, then `remove_reminder`, then `restore_reminder`. The stored status is `active`, the default list shows it, and the calendar feed includes it. The same happens after complete. With 10 open reminders, restoring that cancelled or completed row throws `The free plan allows 10 open reminders. Upgrade to Pro for a higher allowance. The trial is 14 days, then Pro.` and the row stays removed. `removeReminder` stores `resumeStatus` `paused` only when the prior status was paused, and `active` otherwise. `reminders.resume_status` allows only `active` or `paused`. Restore treats every other value as active and runs the open-cap check. Paused stays paused and does not use the cap. An active reminder still restores as active and fails at the cap without changing `status` or `removed_at`.

## What held

A second claim after remove is withheld, and the due job does not send that row. `claimDelivery` calls `fillip_claim_sendable` again after the delivery insert, and a false second answer withholds the send. On Postgres the function is true only for that owner's active row. It is false for removed, paused, completed, another owner, and a missing id. After the row is updated to removed, the same call is false.

Restore returns the same id. A future one-time keeps its fire time. A daily series whose fire time is five days past restores to one next fire, sends nothing at the restore instant, and sends one email at that next fire. A paused reminder whose fire time is past stays paused and does not send. A one-time reminder that is already past throws and stays removed, with the same `removed_at` and fire time. Restore succeeds at exactly 30 days and refuses one millisecond later without writing. An active restore at 10 open reminders throws `OpenCapError` and leaves the row removed. A paused restore at that cap succeeds and the open count stays 10. The Postgres trigger rolls back an update that turns a removed row active at 10 open reminders, and a paused update succeeds.

Removed rows stay off `list_reminders` for `all`, `include_done`, and `status: removed`. The calendar feed omits them and includes an active sibling. Another user's feed does not contain them. A second remove does not move `removed_at`. User B cannot remove or restore A's reminder. As `authenticated`, B selects nothing, cannot update, deletes nothing, and cannot execute `fillip_purge_removed` or `fillip_claim_sendable`. A's row stays active.

`fillip_purge_removed` from two connections both succeed. Their counts sum to the two rows whose `removed_at` is strictly before the 30-day cutoff, including another owner's row, and those deliveries are gone. A row removed at exactly the cutoff, a newer removed row, a removed row with a null `removed_at`, an active row that has an old `removed_at`, a paused row, and a digest delivery remain. A second call deletes nothing.

`POST /auth/sign-out-everywhere` is 401 `Authentication required.` for a missing bearer, for `Bearer nope`, and for an MCP-shaped token GoTrue rejects. The body does not contain the upstream detail. A user token with `client_id`, and a user token whose `aud` is `https://fillip.example/mcp/`, are 403 and do not log out. A session token whose audience is `authenticated` returns 200 and logs out. `CODE_LOCKED` is `Too many tries. Try again in 15 minutes, or sign in with your password.` README, the privacy page, the sign-in page, and `supabase/README-oauth.md` do not say a new code clears the lock. README says a new send does not clear it.

`remove_reminder` is `destructiveHint: false`, `idempotentHint: true`, and its description says it can be restored for 30 days. `restore_reminder` says the same id comes back, paused if it was paused, with the next time recomputed when the old one has passed.

Production startup exits without listening when `FILLIP_PKCE_SECRET` is missing or 31 characters, for `NODE_ENV=production` and for `VERCEL_ENV=production`. The message names `FILLIP_PKCE_SECRET` and does not include the secret, `fillip-dev-pkce`, or the unsubscribe, cron, service-role, or anon values set in that process. A 32-character secret with surrounding whitespace listens. A missing `FILLIP_LOCKOUT_SECRET` still refuses startup when the PKCE secret is set. `pkceSecret()` does not chain those other secrets. Outside production, a missing secret uses `fillip-dev-pkce`. There is no `"fillip-pkce"` literal.

README says the delivery job deletes removed reminders older than 30 days and their deliveries, and that export, delete, and account deletion still remove those rows immediately. The privacy page says Fillip keeps a removed reminder and its delivery records for 30 days and then deletes them, and that export, delete, and account deletion remove them immediately. The copy walk of `README.md`, `src`, `public`, `glama.json`, `server.json`, and `supabase/README-oauth.md` found no `$` prices, `USD`, `dollars`, `SMS`, Slack notification, push notification, WhatsApp, or iMessage.
