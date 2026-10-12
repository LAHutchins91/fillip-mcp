# Fillip post-launch QA

Head: `d4ba5ee` (`d4ba5ee002645f9c8ff0dcd272ec34361320744a`) on `cursor/fillip-reminders-55db`.
Product code was not changed. `tests/qa/postlaunch.test.ts` and this report are the only additions.

Production is `https://fillip-mcp.vercel.app`. Its public OAuth resource is `https://fillip-mcp.vercel.app/mcp`. `supabase/schema.sql` did not change in this diff.

The author said 360 tests pass. On Postgres 16.15, with the schema applied, that tree is **360 passed, 0 failed**, twice in a row (54.84s, then 54.15s). `npx tsc -p tsconfig.json --noEmit` exits 0. With the post-launch tests the suite is **374 passed, 4 failed (378)**.

Severity: **0 blockers, 1 major, 3 minors**.

Do not ship this.

## Assertion diff

Compared with the merged round-12 tree (`5b765e2`). No `it.skip`, `describe.skip`, or `test.skip`. No test file was deleted. Schema files are unchanged.

Not weakened:

- Repeating reminders that the older tests needed in the `completed` status now pass `end_series: true`. Without that flag, complete no longer ends the series, so those setups would not be testing a completed row.
- Cap messages now require the site address. The free and trial sentences still have to include the upgrade note. A Pro cap still does not.
- The round-10 in-flight QA-FAIL still expects `report.sent` to be 0.

## Major

Completing the same occurrence twice skips the next one.

Repro: a daily 9am reminder, complete at 10:00 UTC on that day. The next time is the following day at 9am. Complete again at that same 10:00 UTC. The stored time jumps another day, to two days out. Twelve completes that all read the row before any of them writes land on one next time, so the race itself is fine. A second call after the first has saved is not idempotent.

## Minors

A weekly, monthly, or every-N complete says "Done for today." A Tuesday series comes back `Done for today. Next: Tue Oct 20 at 9:00 AM.` The date is the right next Tuesday. "Today" is not. Use one sentence for every repeat: `Done. Next reminder: Tue Oct 20 at 9:00 AM.`

An in-flight email is rewritten to the next occurrence. Repro: the daily reminder is claimed for Sunday, October 11 at 9:00 AM, then complete runs before the provider call. One email goes out, and the next day still sends once, so the next occurrence is not lost. The email that already went out says `Due Monday, October 12, 2026 at 9:00 AM.` The user hears about Monday early, and again on Monday.

A daily 1:30am reminder completed during the fall-back hour is scheduled for the second 1:30 that same morning, not the next day. Repro: the occurrence is Sunday, November 1, 2026 at the first 1:30am Eastern (`2026-11-01T05:30:00.000Z`). Complete one minute later. The next time is `2026-11-01T06:30:00.000Z`, the repeated hour. The note still says 1:30 AM, so it looks like the next morning. The delivery job uses the same next-time function, so a send in that hour already did this. The new complete path copies it.

## What passed

One complete moves a single step for daily, weekly, weekdays, the first Monday, the last Friday, the 31st (January 31 to February 28, then March 31), every 3 days, and every 2 weeks. Daily 9am stays 9:00 local across the spring-forward and fall-back nights. A 2:30am series says 3:30 AM on the missing hour and is back to 2:30 the next day.

"Until Oct 13" keeps October 13 and does not create October 14. A series "for 2 times" ends on the second complete. `end_series` and cancel do not move the time.

Complete between the claim and the provider sends that occurrence once and leaves the next day in place. Complete after the provider has accepted does not skip an extra day. `end_series` before the provider sends nothing, marks the delivery skipped, lets a sibling reminder use the freed daily ping, and does not send later. `end_series` after the provider accepts sends that one ping and nothing after it. Finishing the last counted occurrence before the provider also releases the held ping.

A paused series stays paused, keeps its hold, and moves one step. A removed reminder is refused and stays removed. Cancel does not advance. Completing a cancelled series does not make it active and does not move the time.

Remove, then restore, brings back the next time complete just scheduled. If that time has already passed, restore picks the next future 9am rather than the occurrence that was just finished.

On Postgres, an account already at 10 open reminders can still advance an active series. Ending that series frees the slot, and a new reminder can then be saved. An 11th active insert is refused while the count is 10.

With `APP_BASE_URL` set to `https://fillip-mcp.vercel.app`, the free and trial cap sentence is `Upgrade to Pro at https://fillip-mcp.vercel.app/. The trial is 14 days, then Pro.` It is plain text, it is the home page, and it has no dollar amount. A Pro cap does not include the address. A trailing slash on the setting does not double.
