# Fillip QA round 8

Head: `362cf99` (`362cf991d43c8a607bd2129162a315000d3888e3`) on PR #1.
Product code was not changed. New tests and this report are the only additions.

The author said 295 tests pass and PR #8's three tests are unchanged. Before `tests/qa/round8.test.ts`, this head is **295 passed, 0 failed**. `npx tsc -p tsconfig.json --noEmit` exits 0. With the new file the suite is **309 passed, 2 failed (311)**.

Severity: **0 blockers, 2 majors, 1 minor**.

Fillip does not pass code QA.

Cap races, the token hook, and the emailed-code window use Postgres 16.15 at `127.0.0.1`, role `fillip_qa`, database `fillip_round8`. Both `supabase/schema.sql` and `supabase/oauth_resource_binding.sql` are applied. The hook is called as `public.fillip_access_token_hook`. Sign-in cases use the Fillip process in front of a GoTrue stand-in.

## Assertion diff

Compared test files from `24b13a1` (`qa/bellion-fillip-7`) to `362cf99`. Three test files changed. No `it.skip`, `describe.skip`, `test.skip`, `xit`, or `xdescribe`.

The three PR #8 `QA-FAIL` bodies are still in `tests/qa/round7.test.ts`, and they pass on this head because the product changed:

- Two live S256 codes still expect `validateMcpClaims` not to throw.
- `outcome("both-fail")` still requires the free-plan sentence and a missing row when the call throws.
- Five wrong codes still require 429 after a new send and after a changed `X-Forwarded-For`.

Other edits are contract updates, not loosened checks:

- `tests/qa/round7.test.ts` adds a 15-way SQL bump and points the HTTP stand-in at `fillip_bump_code_counter`, `fillip_clear_email_wrong`, and `fillip_reset_ip_verify`. The README residual expects now require "A new send does not clear that lock." and "however many rows there are".
- `tests/code-auth.test.ts` requires the email lock to survive a new send, and the wrong-code body to be `That code is wrong or expired.` Another email still receives tokens.
- `tests/oauth-resource-hook.test.ts` still withholds the audience when one row names a different resource. A new test binds a claims `authorization_id` and withholds an unknown id.

## Findings

| Severity | What happens | Expected | Actual | Test |
| --- | --- | --- | --- | --- |
| Major | Socket IP is over the 10-verify cap | A client-supplied address header stays on that cap | `X-Real-IP` and `x-vercel-forwarded-for` each get a fresh budget (HTTP 400) | `QA-FAIL: a client X-Real-IP or x-vercel-forwarded-for cannot mint a new verify budget` |
| Major | `FILLIP_LOCKOUT_SECRET` is unset and `NODE_ENV` or `VERCEL_ENV` is `production` | The process exits at startup and names that variable | The process prints `Fillip listening` and hashes with the fallback chain | `QA-FAIL: production startup refuses when FILLIP_LOCKOUT_SECRET is missing` |
| Minor | An allowed code send from one IP | The IP verify cap stays spent | That send sets `verify_count` back to 0. Measured ceiling is 600 provider verifies an hour per IP | `an allowed send resets that IP verify count; rotating emails then reaches 600 provider tries an hour` |

### Major: client address headers mint a new verify budget

Spoofed `X-Forwarded-For` does not. After ten wrong verifies with no address header, an eleventh request carrying `X-Forwarded-For: 203.0.113.99` stays 429. `lockoutAddressKey` never reads that header.

It does read the first hop of `x-vercel-forwarded-for`, then `x-real-ip`, then the socket. Those two headers are taken from the request as the client sent them. `trust proxy` is not consulted. Nothing checks `VERCEL` or `VERCEL_ENV` before trusting them.

Repro, against the Fillip process:

1. `POST /auth/code/verify` ten times with a wrong code and no address header. Each is 400.
2. Repeat with `X-Forwarded-For: 203.0.113.99`. Status stays 429.
3. Repeat with `X-Real-IP: 198.51.100.77`. Status is 400 and GoTrue is called.
4. Repeat with `x-vercel-forwarded-for: 198.51.100.88`. Status is 400 and GoTrue is called.

A client can rotate either header and keep a fresh set of 10 verifies. The 600-per-hour figure below applies only when the IP key stays put.

Use `x-vercel-forwarded-for` only when `VERCEL` or `VERCEL_ENV` is set, because that is when the platform writes it. Otherwise key the socket address. Do not let a client-supplied `X-Real-IP` outrank the socket unless a trusted proxy replaces that header.

IPv6 is keyed on the first four hextets. `2001:db8:aa:10::1`, `2001:db8:aa:10:ffff::abcd`, and `2001:db8:aa:10::9%eth0` share one budget. `2001:db8:aa:11::1` does not. `::ffff:203.0.113.10` becomes `203.0.113.10`.

### Major: production boots with no lockout secret

`pepper()` returns `FILLIP_LOCKOUT_SECRET` when it is non-empty. Otherwise it uses `FILLIP_UNSUBSCRIBE_SECRET`, then `CRON_SECRET`, then `SUPABASE_SERVICE_ROLE_KEY`, then `SUPABASE_ANON_KEY`, then the literal `fillip-pkce`. `src/server.ts` listens whenever `NODE_ENV` is not `test`. It does not read `FILLIP_LOCKOUT_SECRET`.

Repro:

1. `NODE_ENV=production`, `FILLIP_LOCKOUT_SECRET` empty, start `src/server.ts`. Stdout is `Fillip listening on 0`. The process does not mention `FILLIP_LOCKOUT_SECRET`.
2. `NODE_ENV=development`, `VERCEL_ENV=production`, same empty secret. Same listen line.
3. The same production start with `FILLIP_LOCKOUT_SECRET` set does listen, so the process can boot when the secret is present.

The anon key is shipped to browsers. The last fallback is a string in the source. Either one is a public HMAC key for `fillip_code_attempts.subject_hash`.

Fail startup when `FILLIP_LOCKOUT_SECRET` is missing and either `NODE_ENV` or `VERCEL_ENV` is `production`. Do not listen, and do not fall through to the anon key or `fillip-pkce`.

### Minor: an allowed send resets the IP verify cap

The email lock holds. Five wrong codes in 15 minutes return 429 `Too many wrong codes. Request a new one.` A later send still returns `If that email can sign in, a code is on its way.` The next correct code stays 429 and is not sent to GoTrue. On Postgres, a bump 14 minutes after `window_started_at` stays in the window (count 6). A bump at 15 minutes starts a new window (count 1). An IP send does not change `wrong_count`. Twenty parallel HTTP verifies of one email let exactly five through to GoTrue (four HTTP 400s, sixteen 429s). Twenty parallel SQL bumps return the dense sequence 1 through 20, and exactly five of those values are at most 5.

The IP verify cap does not hold across a send. `sendCode` calls `resetIpVerify` after every allowed send that is not a provider rate limit. Measured on one address:

- Ten wrong verifies, each a different email, are HTTP 400. The eleventh email is 429. Rotating the target email does not reset the IP counter.
- One send to `attacker-owned@example.com` returns 200. The next ten verifies, again on new emails, are HTTP 400. The eleventh is 429.
- Five sends in the five-minute window return 200. The sixth returns 429.

That is 5 sends × 10 verifies per 5-minute window, which is **600 provider verify attempts per hour per IP**. One email stays at 5 wrong codes per 15 minutes, which is **20 per hour per email**. A send to a mailbox the attacker owns is enough to zero the IP counter. The header major above removes this ceiling for any client who can set `X-Real-IP` or `x-vercel-forwarded-for`.

## Round 7 majors on this head

Four agreeing S256 rows for one user, client, and scope receive `aud` `["authenticated", "https://fillip.example/mcp"]`, and `validateMcpClaims` accepts that token. An expired row, a pending row, and a row with a null `authorization_code` are ignored, including when those rows name another resource or use `plain`. One live disagreeing row withholds the audience: a different resource, a null resource, or `plain`. Claims `authorization_id` and `authorizationId` bind that row even when a sibling disagrees. An unknown authorization id withholds the audience. A grant with no resource, and another client's grant, still get no audience.

Over-cap combinations, each checked so a saved view is only returned when the row is still there and a free-plan refusal is only returned when the row is gone:

- DELETE returns the id, and the row is gone: free-plan error.
- DELETE returns `[]` and the row remains: the over-cap note, status `active`.
- DELETE returns `[]` and the row is gone: free-plan error.
- DELETE throws and the read still finds the row: the over-cap note.
- DELETE throws and the read finds the row gone: free-plan error.
- Both reads throw, or both reads are the empty-representation marker: `Fillip couldn't confirm whether this reminder was saved. Please list your reminders.` That is a thrown error, not a saved view, whether the row remains or was removed.
- The first read throws and the retry finds the row: the over-cap note. The retry finds it gone: free-plan error.
- User-mode delete throws, the service-role read finds the row, and the service-role delete returns the id: free-plan error and the row is gone.
- Both service-role reads throw: the couldn't-confirm error, the row remains, and the service-role delete is not called.

`open_cap_delete_failed` does not include the reminder text. Twelve real inserts at nine open still leave exactly ten (the round 7 Postgres test, still passing).

## What else passed

`tools/list` with no bearer is 200. `Bearer not-a-jwt` is 401 and the body contains `Authentication required.` Plain PKCE is still `invalid_request` on Fillip's authorize check. S256 is accepted.

Copy walk of `README.md`, `src`, `public`, `glama.json`, `server.json`, and `supabase/README-oauth.md` found no `$` prices, `USD`, `dollars`, `SMS`, Slack notification, push notification, WhatsApp, or iMessage. The README and the OAuth note both say a new send does not clear the email lock, and the OAuth note says every agreeing row receives the audience.
