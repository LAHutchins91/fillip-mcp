# Fillip QA round 9

Head: `02e7373` (`02e73734f9cedf57e0ca90e077cd578717fa7df8`) on `cursor/fillip-reminders-55db`.
Product code was not changed. New tests and this report are the only additions.

The author said 311 tests pass, PR #9's tests are unchanged, and there is no SQL change. Before `tests/qa/round9.test.ts`, this head is **311 passed, 0 failed**. `npx tsc -p tsconfig.json --noEmit` exits 0. With the new file the suite is **318 passed, 0 failed**. Postgres is 16.15. `supabase/schema.sql` and `supabase/oauth_resource_binding.sql` are unchanged from `qa/bellion-fillip-8`.

Severity: **0 blockers, 0 majors, 0 minors**.

Fillip passes code QA.

## Assertion diff

Compared test files from `1d6a344` (`qa/bellion-fillip-8`) to `02e7373`. Three test files changed. No `it.skip`, `describe.skip`, `test.skip`, `xit`, or `xdescribe`. No SQL file changed.

Not weakened:

- The three round-7 `QA-FAIL` bodies are still there. Between the `X-Forwarded-For` check and the email-lock check, the stand-in drops IP rows. The IP key is now the socket, so those first ten verifies would otherwise spend the same bucket the email lock uses. The email-lock expects are the same, and that test passes.
- The two round-8 `QA-FAIL` bodies are still there and now pass. The address-key unit expect for `X-Real-IP` is the socket address. The IPv6 HTTP case sets `VERCEL=1` so it still keys the platform header. The send case now requires the verify cap to stay spent. The production boot control uses a 32-character secret, which is what a valid secret is.
- `tests/code-auth.test.ts` expects the socket when `VERCEL` is unset, including when `x-vercel-forwarded-for` and `X-Real-IP` are present. With `VERCEL=1` it still expects the platform header. A 31-character secret is rejected and a 32-character secret is accepted.

## What was checked

With `VERCEL=1`, ten wrong verifies that vary `X-Real-IP` and `X-Forwarded-For` but keep `x-vercel-forwarded-for: 198.51.100.8` share one budget. The eleventh, with a new `X-Real-IP` and `X-Forwarded-For` and the same platform address, is 429. A different first hop (`203.0.113.50`) is a new budget. The second hop is not the key. An IPv4 address with a port, an IPv4-mapped address, and an IPv6 /64 including a zone id follow that header. When the platform header is absent, different `X-Real-IP` and `X-Forwarded-For` values still share the socket.

With `VERCEL` unset or empty, the socket is the key. `X-Real-IP`, `X-Forwarded-For`, and `x-vercel-forwarded-for` do not move it. After ten wrong verifies, each of those headers is 429.

`src/code-auth.ts` does not read `x-real-ip` or `x-forwarded-for`, and it does not call `resetIpVerify` or `fillip_reset_ip_verify`.

Production startup (`NODE_ENV=production`, and `VERCEL_ENV=production` with `NODE_ENV=development`) exits 1 when `FILLIP_LOCKOUT_SECRET` is missing, 31 characters, or only whitespace. The process does not listen. The message names `FILLIP_LOCKOUT_SECRET` and does not include the secret. Unsubscribe, cron, service-role, and anon values are set in those runs and are not used. A 32-character secret, including one with surrounding whitespace, boots. `VERCEL_ENV=preview` does not refuse. `codeSubjectHash` throws in production instead of hashing with another secret. The only `||` chain that still ends at `fillip-pkce` is `pkceSecret()` in `src/plugin-auth.ts`, which signs the authorize cookie. It is not the lockout pepper, and this diff does not change it.

An allowed send does not reset the IP verify count. After the cap is spent, a send to `attacker-owned@example.com` still returns `If that email can sign in, a code is on its way.` The next verify, including a correct code on a new email, stays 429 and is not sent to GoTrue. The stand-in records no `fillip_reset_ip_verify` call. That holds both for the platform header and for the socket.

Plain PKCE is still `invalid_request`. Copy walk of `README.md`, `src`, `public`, `glama.json`, `server.json`, and `supabase/README-oauth.md` found no `$` prices, `USD`, `dollars`, `SMS`, Slack notification, push notification, WhatsApp, or iMessage. The full suite, including the earlier Postgres hook, cap, and lockout cases, passed.
