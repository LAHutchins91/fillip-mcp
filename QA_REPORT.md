# Fillip QA round 7

Head: `e24b51b` (`e24b51bcb219a5ba11f10fdc76452b6ffe9a13e8`) on PR #1.
Product code was not changed. New tests and this report are the only additions.

The author said 279 tests pass and PR #7's test is unchanged. Before `tests/qa/round7.test.ts`, this head is **279 passed, 0 failed**. `tests/qa/round6.test.ts` has an empty diff from `ccf1563`. `npx tsc -p tsconfig.json --noEmit` exits 0. With the new file the suite is **289 passed, 3 failed (292)**.

Severity: **0 blockers, 3 majors, 0 minors**.

Fillip does not pass code QA.

Cap races and the token hook use Postgres 16 at `127.0.0.1`, role `fillip_qa`, database `fillip_round7`. Both `supabase/schema.sql` and `supabase/oauth_resource_binding.sql` are applied. The hook is called as `public.fillip_access_token_hook`. Sign-in cases use the Fillip process in front of a GoTrue stand-in.

## Assertion diff

Compared test files from `ccf1563` (`qa/bellion-fillip-6`) to `e24b51b`. Nine test files changed. `tests/qa/round6.test.ts` did not. No `it.skip`, `describe.skip`, `test.skip`, `xit`, or `xdescribe`.

Not weakened:

- The round-6 keep-or-throw test is byte-for-byte the same. On this head it passes: a DELETE that leaves the row does not throw, and the row stays `active`. If a throw does happen, the test still requires the row to be gone.
- `tests/qa/round5.test.ts` adds cases. A DELETE that returns its id throws the free-plan sentence and is not repeated. A service-role retry that removes the row throws. A retry that leaves the row returns it with the over-cap note. The old "still returns it as saved" test still expects `isError` and passes, because an empty DELETE plus a re-read that finds the row gone is an error.
- `tests/qa/round4.test.ts` changes the tied-timestamp expect from `The free plan allows 10 open reminders` to `You're over the free plan's 10 open reminders`. That double's DELETE returns `[]` and the following GET still lists the new id, so `createReminder` throws `OpenCapKeptError`. The DELETE is still only the inserted id. The tool path turns that error into a saved view. This matches the new design. It also expects `fillip_code_attempts` to be unreadable by `authenticated`.
- `tests/qa/round3.test.ts`, `tests/oauth-signin.test.ts`, and `tests/http.test.ts` replace `signInWithOtp` / `verifyOtp` with `POST /auth/code/send` and `POST /auth/code/verify`. The identical-response check for an unknown email is still there. `tools/list` with a bad bearer is a new 401 `invalid_token` expect. `delete_reminder` must set `destructiveHint` and must not say permanently, erases, or cannot be undone.
- `tests/schema-reapply.test.ts` adds the attempt table: RLS on, no SELECT for `authenticated`, `subject_hash` present, no `email` or `code` column.
- `tests/code-auth.test.ts` and the new `tests/crud.test.ts` cases are additions. The author lockout test expects a new send to clear the counter. That is the behavior below, not a hidden skip.

## Findings

| Severity | What happens | Expected | Actual | Test |
| --- | --- | --- | --- | --- |
| Major | Two live S256 codes share a user, client, and scope | The token still gets the `/mcp` audience | `aud` stays `authenticated`. `/mcp` answers 401 `invalid_token` | `QA-FAIL: two live S256 codes for one reconnect still receive the audience` |
| Major | Over-cap DELETE and the re-read both throw after the row was removed | Do not return that row as saved | `setReminder` returns `status: "active"` and a later read is empty | `QA-FAIL: a failed re-read after a delete does not claim a removed row was saved` |
| Major | Five wrong emailed codes | The lock survives a new send and a changed IP header | A new send clears it. `X-Forwarded-For` moves the per-IP verify cap | `QA-FAIL: five wrong codes stay locked after a new send and after a changed IP header` |

### Major: two agreeing S256 codes are a 401

`fillip_access_token_hook` counts approved, unexpired `auth.oauth_authorizations` rows for the same client, user, and scope with a non-null `authorization_code`. The audience is added only when that count is exactly 1, every row's resource equals `mcp_resource`, and every `code_challenge_method` is `s256`. The hook payload has no authorization id. `auth.sessions`, as this hook is allowed to read it, has no authorization id either.

Two rows that both use S256 and both name `https://fillip.example/mcp` produce `aud` of `authenticated` only. `validateMcpClaims` then throws `Reconnect Fillip`. `POST /mcp` turns that into 401 with `error="invalid_token"`.

That is a normal second code, not only an attacker. A double-click on Connect, two tabs, or a reconnect while the earlier code is still approved and unexpired creates two issued codes for the same client, user, and scope. Supabase can skip the consent page when a session cookie and an existing grant are already present, so both clicks can be issued without a second approval. The author's test covers one evil resource beside one real resource. That disagreement should still be refused. Two legitimate rows should not.

One S256 grant is bound. A second user with their own grant is bound. A grant whose resource is null is not bound.

Proposed rule: add the audience when every unexpired approved code for that client, user, and scope agrees: resource string-equals `mcp_resource` and `code_challenge_method` is `s256`. The count may be greater than 1. Withhold the audience when any of those rows has a different resource, a null resource, or a method other than `s256`. If a later Supabase session column or hook claim carries the authorization id, match that id and ignore the other rows.

A grant with no resource gets no audience. Confirmed. The risk: a client that omits `resource` can never call `/mcp`, even with S256, and Fillip cannot tell that client from a grant that named the wrong resource. The README states this residual. It is not a separate defect.

### Major: a thrown re-read says a removed reminder was saved

The three steady paths match the design.

- DELETE `Prefer: return=representation` returns the id. The call throws `The free plan allows 10 open reminders`. The row is gone. The older row stays.
- DELETE returns `[]` and the re-read still finds the row. `setReminder` returns `status: "active"` and the note `You're over the free plan's 10 open reminders. Upgrade to Pro for a higher allowance. The trial is 14 days, then Pro.` The older row stays.
- DELETE returns `[]` and the re-read finds nothing. The call throws. The row is gone.

`rowStillStored` returns true when the re-read throws, and when the body is the empty-representation marker. `refuseIfReadOverCap` then throws `OpenCapKeptError`. `createOrRefuse` turns that into a saved view. A DELETE that removes the row and then throws, followed by a re-read that throws, still returns that view. A later `getReminder` is null. The log line is `open_cap_delete_failed` and does not include the reminder text.

Repro:

1. The post-insert active list is longer than 10.
2. DELETE of the new id removes it and the HTTP call throws.
3. The follow-up GET of that id throws.
4. Call `setReminder`.

The result is a reminder view with `status: "active"` and the over-cap note. The row is not stored.

### Major: the five-wrong lock does not stick

After five wrong codes the email answers 429 `Too many wrong codes. Request a new one.` A verify from a different `X-Forwarded-For` stays 429. That part holds. `POST /auth/code/send` then sets `wrong_count` back to 0, and the next correct code returns session tokens. The stand-in saw the verify. `supabase/README-oauth.md` says a new send resets the count, so the README matches the code. The lock the user was promised does not.

`app.set("trust proxy", 1)` and `requestIp` uses `req.ip`. Ten wrong verifies from `203.0.113.10` are refused on that address. The eleventh, `203.0.113.99`, is accepted and the code `123456` returns tokens. The per-IP cap of 10 verifies and 5 sends in five minutes moves with the header. Together with the reset, a new header and a new send start the five guesses over.

Existing and unknown emails both get 200 and `If that email can sign in, a code is on its way.` The unknown address is the GoTrue `otp_disabled` body. It is not repeated to the browser.

## What passed

Repeat edit: `snooze_or_reschedule` with `repeat: weekly` keeps the same id, leaves one row, and does not write a cancelled row or an "older copy". A rejected create (14 March 2027 2:30am America/New_York, a past time, and unreadable text) throws before any reminder POST. No cancelled row is written.

`delete_reminder` title is `Delete reminder`, the description is `Removes a reminder the user asked to delete.`, `destructiveHint` is true, and the tool JSON does not say permanently, erases, cannot be undone, destroy, or wipe.

`tools/list` with no bearer is 200. `tools/list` with `Bearer not-a-jwt` is 401, `WWW-Authenticate` contains `error="invalid_token"`, and the body is `Authentication required.`

Sign out everywhere, with that user's bearer and `X-Fillip-Request: 1`, deletes only that user's grant (`token-a:client-a`) and posts `/auth/v1/logout?scope=global` with that bearer. The other user's grant is untouched. Those are the calls Fillip makes. GoTrue is what turns global logout into revoked sessions and refresh tokens.

README residuals that were checked against the code: identical send text, `otp_disabled` on public `/otp` with `create_user=false`, refresh-token reuse and `refresh_token_already_used`, S256 required for the audience, a null resource gets no audience, two issued codes that share a scope are not bound, and sign-out uses `POST /auth/v1/logout?scope=global`. They match this build. The two-code sentence is accurate and is the first major. Copy in README, src, public, glama.json, server.json, and `supabase/README-oauth.md` has no `$`+digit, USD, dollars, SMS, Slack notification, push notification, WhatsApp, or iMessage.

Twelve real inserts at nine open leave exactly ten. The original nine remain. One S256 grant receives the audience. Plain PKCE is still `invalid_request` on Fillip's own authorize check.

## Regression

The 279 re-ran every earlier suite, including the unchanged round-6 file, and all passed. The extra cases above cover the open cap, the token hook, in-place edits, rejected creates, delete wording, `tools/list`, emailed codes, sign-out, and copy.
