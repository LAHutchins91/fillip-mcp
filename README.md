# Fillip by Ouroboros

Fillip, reminders that fire.

Remind me to follow up on this next Tuesday at 2pm, and actually ping me. You say that inside ChatGPT, Claude, Cursor, or Grok. Fillip emails you when it is due, even if your laptop is off.

It works with any MCP client that can do Streamable HTTP and OAuth. It is not a ChatGPT-only plugin.

Sign in with your Fillip account when the assistant opens OAuth. Do not paste an access token or password into a header. A free plan does not expire. The trial is 14 days, then Pro. If you do not continue, you stay on the free plan. Checkout shows the plan terms. This page does not print a price.

More from Ouroboros: https://ouroborosapps.com

## What the assistant can do

After you approve the connection, the server exposes these tools:

- `set_reminder` — “next Tue 2pm”, “every weekday 9am”, “first Monday of every month”, or “every 2 weeks until Dec”, in your timezone. Fillip reads the time itself. A past date or a wrong year is rejected or moved forward, and the assistant is told which. Repeats can be every N days or weeks, a calendar date each month, or the nth weekday each month, and they can stop on a date or after a count. Leave `repeat` off when the words already include the schedule. A `repeat` value that disagrees is rejected, so a monthly rule or an end date is not replaced.
- `list_reminders` — includes a delayed state when a ping was held past its due time
- `snooze_or_reschedule` — move a reminder, pause it so it does not send, or resume it onto the next future occurrence
- `complete_or_cancel` — marking a follow-up done stops the nudges
- `follow_up` — without an end, it nags until you mark it done. “until Dec” or “for 6 times” stops the follow-up at that limit even if it is not marked done
- `digest_settings` — an optional once-a-day email summary
- `calendar_feed` — a private calendar subscription link, and a way to rotate it
- `delivery_settings` — only when Telegram is configured: link the bot, unlink it, or set the default channel

Creating a reminder opts you in. Fillip emails only the verified address on that account. There is no field for another recipient. Every reminder email includes a calendar file in your timezone, with a repeat rule when the reminder repeats, a 15-minute duration, a display alert at the event time, and a stop link. The daily summary does not include a calendar file. Setting another reminder turns mail back on.

If the shared mail guard or the email provider holds a reminder past its due time, the email says it was delayed and by how long. `list_reminders` shows that same delayed state. The reminder stays queued. It is not marked sent and it is not dropped.

Each plan has its own monthly ping allowance. A ping is one reminder send. Telegram counts, and a reminder delivered to both email and Telegram counts as 2. The free plan also caps how many reminders can stay open. The numbers are configuration, not printed here. When a free or trial cap is hit, the tool says so and tells you that Pro has a higher allowance. A heavier month cannot cost more than that plan pays for. After the trial, an account that does not continue stays on the free plan and keeps using reminders inside those caps.

When Telegram is configured, a reminder can go by email, Telegram, or both. Each of those is a ping, so both counts as 2. Telegram does not count toward the shared email guard. Unlinking stops that chat. If the bot token is unset, Telegram tools and the webhook are absent.

The assistant only calls these tools when you and the host allow it.

## Connect

Run the server and use its `/mcp` path. With the default local base, that is `http://localhost:3000/mcp`. A deployed host uses the same path on `APP_BASE_URL`.

Cursor, in `~/.cursor/mcp.json` or a project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "fillip": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http fillip http://localhost:3000/mcp
```

Do not pass an Authorization header. Other clients add the same URL, choose OAuth, and leave client id and secret empty. Fillip supports dynamic client registration. Full steps for ChatGPT, Claude, Gemini, Grok, and Cursor are on the server's `/connect` page.

When stdin is a terminal, Fillip serves Streamable HTTP. When stdin is not a terminal, it also speaks MCP on stdio, so a launcher such as Glama can attach stdin. Local stdio can hold a schedule on disk. Email goes out only for a signed-in hosted account with a verified address.

Registry metadata for this server is in `server.json` (`io.github.LAHutchins91/fillip`). Add the public remote URL there after the host exists.

## Run

```bash
npm ci
npm test
npm run build
npm start
```

`GET /health` reports whether Supabase, Stripe, the sender, and Telegram are configured. `POST /mcp` with `tools/list` answers without a sign-in so ChatGPT and Glama can read the tool catalog and its `securitySchemes` before a user connects. A `tools/list` request that presents a bearer token which is bad or expired returns 401 with `WWW-Authenticate` `error="invalid_token"`. `initialize` and every other method, including tool calls, return 401 with `WWW-Authenticate` pointing at the protected-resource metadata. A presented token that is bad or expired adds `error="invalid_token"`. A missing token does not, including on `tools/list`. The body says `Authentication required.` A signed-in account on the free plan, the trial, or Pro can use the tools. Caps, not a lockout, enforce the plan. Each MCP request writes one JSON log line with the user id, OAuth client id, tool or method, HTTP status, and duration. Reminder text, emails, and tokens are not logged.

```bash
docker build -t fillip-mcp .
docker run --rm -p 3000:3000 fillip-mcp
```

A container without a terminal on stdin speaks MCP on stdio and still listens on port 3000.

## Environment

Copy `.env.example` to `.env`. Fillip reads these variables and does not invent a sender address or a Stripe price.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port. Defaults to 3000. |
| `APP_BASE_URL` | Public origin, no trailing slash. Used for OAuth resource metadata, checkout return URLs, and stop links. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_ANON_KEY` | Supabase anon key for browser sign-in. |
| `FILLIP_AUTH_GOOGLE_ENABLED` | Set to `true` only after Google is enabled in Supabase. Otherwise the consent page hides "Continue with Google". |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role for the delivery job, billing profile writes, the stop link, and reminder, digest, and delivery writes. Profile changes stay on the user token through the opt-in RPCs. |
| `STRIPE_SECRET_KEY` | Stripe secret for Checkout and the billing portal. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `POST /billing/webhook`. |
| `STRIPE_PRODUCT_ID` | Fillip's own Stripe product id. Webhook events for any other product are ignored. |
| `STRIPE_PRICE_MONTHLY` | Fillip's monthly price id on that product. Not printed. |
| `STRIPE_PRICE_YEARLY` | Fillip's yearly price id on that product. Not printed. |
| `RESEND_API_KEY` | Resend token used only by the delivery job. |
| `FILLIP_FROM_EMAIL` | From address on a domain you have verified in Resend. Required. There is no default address. |
| `FILLIP_UNSUBSCRIBE_SECRET` | HMAC secret for stop links. Required before any email is sent. A GET on the link shows a confirm page. POST is what stops mail, so a link prefetcher cannot unsubscribe the account. |
| `FILLIP_UNSUBSCRIBE_SECRET_PREVIOUS` | Comma-separated secrets that should still open stop links after `FILLIP_UNSUBSCRIBE_SECRET` is rotated. Empty when there is no previous secret. |
| `FILLIP_LOCKOUT_SECRET` | HMAC key for emailed-code lockout counters. Required when `NODE_ENV` or `VERCEL_ENV` is `production`, and it must be at least 32 characters or Fillip refuses to start. There is no fallback to the unsubscribe secret, `CRON_SECRET`, the service role key, the anon key, or a built-in pepper. Outside production, a missing or short value uses the dev-only default. Rotating this secret resets the counters. |
| `FILLIP_PKCE_SECRET` | HMAC key for the authorize PKCE cookie. Required when `NODE_ENV` or `VERCEL_ENV` is `production`, and it must be at least 32 characters or Fillip refuses to start. The startup error names `FILLIP_PKCE_SECRET` and does not print the value. There is no fallback to the unsubscribe secret, `CRON_SECRET`, the service role key, or the anon key. Outside production, a missing or short value uses the dev-only default. |
| `CRON_SECRET` | Bearer token for `GET` or `POST /internal/deliver` and for `GET /internal/status`. |
| `FILLIP_DATA_DIR` | Local schedule and support-form files when Supabase is not configured. |
| `FILLIP_PUBLIC_ORIGIN` | Optional public origin when `APP_BASE_URL` is still a legacy host. |
| `FILLIP_LEGACY_ORIGIN` | Optional earlier origin. Connect copy mentions it only when this is set. |
| `OPENAI_APPS_CHALLENGE` | Optional token served at `/.well-known/openai-apps-challenge`. |
| `FILLIP_MAX_EMAILS_PER_USER_PER_DAY` | Per-account ping cap. Each reminder send counts, including Telegram, and a reminder delivered to both channels counts as 2. Defaults to 100. The day resets at local midnight in the reminder's timezone. |
| `FILLIP_MAX_SENDS_PER_RUN` | Provider calls in one sweep. Defaults to 40. |
| `FILLIP_RESEND_MIN_INTERVAL_MS` | Pause between provider calls. Defaults to 500, which stays under a common 2 requests per second. |
| `FILLIP_CAP_TRIAL_EMAILS_PER_MONTH` | Pings for the whole trial, including a trial that crosses the first of the month. Defaults to 100. The trial is 14 days, then Pro. Telegram counts, and both channels count as 2. |
| `FILLIP_CAP_PRO_EMAILS_PER_MONTH` | Pings allowed in a local month on the monthly plan. Defaults to 1,000. Telegram counts, and both channels count as 2. |
| `FILLIP_CAP_ANNUAL_EMAILS_PER_MONTH` | Pings allowed in a local month on the yearly plan. Defaults to 1,000. Telegram counts, and both channels count as 2. |
| `FILLIP_CAP_FREE_OPEN_REMINDERS` | Open reminders on the free plan. Defaults to 10. The free plan does not expire. |
| `FILLIP_CAP_FREE_EMAILS_PER_MONTH` | Pings allowed in a month on the free plan. Defaults to 30. Telegram counts, and both channels count as 2. |
| `TELEGRAM_BOT_TOKEN` | Optional. Bot token from BotFather. Empty hides Telegram: no delivery tool and the webhook answers not found. |
| `TELEGRAM_WEBHOOK_SECRET` | Shared secret Telegram sends as `X-Telegram-Bot-Api-Secret-Token`. Required before the webhook accepts an update. |
| `TELEGRAM_BOT_USERNAME` | Optional bot username, without @. If empty, Fillip reads it from Telegram when someone asks for a link. |
| `FILLIP_GLOBAL_MAX_EMAILS_PER_DAY` | Fillip's share of the shared Resend pool for one UTC day, counting every reminder, follow-up, and digest email. Telegram does not count. Resend Pro allows 50,000 emails a month and has no daily limit. 600 is Fillip's chosen daily share of that pool. Empty or invalid fails closed: Fillip sends no email and logs a warning. `GET /internal/status` with `CRON_SECRET` shows the guard stopped. |
| `FILLIP_GLOBAL_MAX_EMAILS_PER_MONTH` | Fillip's share of that pool for one UTC month. 15000 is Fillip's chosen monthly share. Resend Pro itself allows 50,000 a month and has no daily limit. Empty or invalid fails closed the same way as the daily guard. |

Pro and the trial can keep at most 100 open reminders. The free plan uses `FILLIP_CAP_FREE_OPEN_REMINDERS`. Every account can create at most 30 reminders in an hour.

## Hosting setup

Nothing in this repo creates a Vercel project, a Supabase project, a Stripe product, or a Resend domain. Do these on the accounts you host with. Fillip does not share a Stripe product with other apps.

1. Create a Supabase project. Run `supabase/schema.sql` (safe to re-run on an existing project), then `supabase/oauth_resource_binding.sql`. In Authentication → Auth Hooks, set Customize Access Token Claims to `public.fillip_access_token_hook`. Set `fillip_private.settings.mcp_resource` to `APP_BASE_URL/mcp` (see `supabase/README-oauth.md`). Add redirect URLs for `APP_BASE_URL` and `APP_BASE_URL/oauth/consent`. The consent page asks Fillip `POST /auth/code/send` and `POST /auth/code/verify`. Fillip calls Supabase with `create_user` true, because that code is how a new account is created. The send response is the same status and the same text whether or not the email already had an account: `If that email can sign in, a code is on its way.` The wait is padded so those two outcomes take a similar amount of time. Wrong codes are counted per hashed email and per hashed IP in `fillip_code_attempts`. Five wrong codes in 15 minutes lock that email for 15 minutes, and Fillip says `Too many tries. Try again in 15 minutes, or sign in with your password.` The 15-minute email window starts at the first wrong try. A new send does not clear that lock. A wrong code answers `That code is wrong or expired.` for every account. The lockout covers only Fillip's routes. When `VERCEL` is set, the per-IP key is the platform-set `x-vercel-forwarded-for` header. Otherwise it is the socket address. Fillip does not read `X-Real-IP` or `X-Forwarded-For` for that key. An IPv6 address is keyed on its /64. An allowed send does not reset the IP verify count. That count expires with its 5-minute window. `FILLIP_LOCKOUT_SECRET` is the hash key. In production it must be at least 32 characters or Fillip refuses to start. There is no fallback. Outside production, a missing or short value uses the dev-only default. A correct code returns session tokens only on that same-origin response, and the page calls `setSession`. Fillip does not write any user fields beyond the account Supabase creates for that signup. Residual: Supabase's public `/otp` endpoint with `create_user=false` still returns `otp_disabled` to anyone holding the anon key. A direct Supabase `/auth/v1/verify` with the anon key accepts a valid code and bypasses Fillip's lockout, backstopped only by Supabase's own limit. Fillip cannot close either of those. In Authentication → Providers, keep Email enabled. In Authentication → Emails, the Magic Link template used for that code must include `{{ .Token }}` so the emailed code shows. Turn on custom SMTP and point it at Resend (`smtp.resend.com`, port 465, username `resend`, password a Resend API key, sender on your verified domain). Supabase's built-in mailer is rate limited; Resend SMTP is what keeps sign-in codes arriving. Leave Google disabled unless you set `FILLIP_AUTH_GOOGLE_ENABLED=true` after enabling that provider. Password sign-in stays on the page behind "Use a password instead" for a review account. In Authentication → Sessions, set the access-token expiry to 900 seconds. Supabase accepts reuse of the immediate parent refresh token and returns the same active child, rejects older tokens, and does not revoke the chain. Sign out everywhere, on Your data and on Connected applications, revokes every OAuth grant and every session. Fillip cannot see `refresh_token_already_used`, because clients refresh at Supabase and that rejection never reaches this server. Fillip does not publish authorization-server metadata, so real clients go straight to Supabase's authorize endpoint and the `fillip_pkce` cookie check never runs. Supabase advertises both S256 and plain, and there is no dashboard switch that removes plain. The access-token hook adds the `/mcp` audience only when the authorization that issued the code stored `code_challenge_method` `s256`. A token from plain PKCE, or from a grant with no method, does not receive that audience, so it cannot call `/mcp` no matter which authorize URL minted it. The consent check stays an inert no-op when that cookie is absent. Fillip still rejects a missing challenge, a missing method, and any method other than S256 on `GET /oauth/authorize` when a client uses that route, and returns `error=invalid_request` to the redirect. A successful S256 request stores the proof in a short-lived HttpOnly cookie. The page denies a method or challenge that is actually present and is not exact S256. When the authorization details already include `redirect_url`, the page assigns that URL immediately, before it reads the client and before the PKCE check, and it does not call approve again. A second approve invalidates the single-use code. When `redirect_url` is absent, the page shows Connect. The access-token hook binds every unexpired, approved, issued authorization for that user, client, and scope when each resource string-equals `mcp_resource` and each `code_challenge_method` is `s256`, however many rows there are. A pending authorization is not an issued grant. The audience is withheld if any matching row has a different or null resource or a method other than `s256`. When the claims include an authorization id, that row is matched instead. A null resource does not receive the audience, the same residual as Stetwise. Supabase can still skip that page when a session cookie and an existing grant are both present, and a client that reuses a stored refresh token does not start a new authorization. Supabase does not send the `iss` parameter. `authorization_response_iss_parameter_supported` is an authorization-server field. Fillip does not publish authorization-server metadata and does not set that flag on protected-resource metadata. Authenticated database roles can select and delete their own reminder, digest, and delivery rows. Inserts and updates on those tables are revoked, so reminder writes go through the service role.
2. In Stripe, create Fillip's own product and two prices on it, monthly and yearly. Put those ids in `STRIPE_PRODUCT_ID`, `STRIPE_PRICE_MONTHLY`, and `STRIPE_PRICE_YEARLY`. Point a webhook at `APP_BASE_URL/billing/webhook` for `checkout.session.completed` and the customer subscription events. Checkout starts a 14-day trial, then Pro, and stamps the Fillip product id on the session. The webhook applies an event only when every product id on it is `STRIPE_PRODUCT_ID` and the price is one of those two. Other products on the same Stripe account are ignored. When the subscription is no longer entitled, the account moves to the free plan and reminders keep working inside the free caps. Set `FILLIP_CAP_TRIAL_EMAILS_PER_MONTH`, `FILLIP_CAP_PRO_EMAILS_PER_MONTH`, and `FILLIP_CAP_ANNUAL_EMAILS_PER_MONTH` to the allowances those plans can afford. Unset monthly caps default to 100 for the whole trial and 1,000 for Pro and Annual. `FILLIP_CAP_FREE_OPEN_REMINDERS` and `FILLIP_CAP_FREE_EMAILS_PER_MONTH` default to 10 and 30. An older `customer.subscription.deleted` event does not revoke a newer active Fillip subscription.
3. In Resend, verify the domain you will send from. Set `RESEND_API_KEY` and `FILLIP_FROM_EMAIL` to an address on that domain. Fillip sends one recipient, the account's verified email. Each ping is reserved on the account counter before the provider is called, so the last free ping cannot leave twice (once per channel, or from two workers). The email idempotency key is `fillip/<reminder>/<occurrence>`. The Telegram key for that same occurrence is `fillip/<reminder>/<occurrence>/telegram`. Fillip writes an attempt on the delivery row before the call. While that attempt is inside the two-minute claim lease, a later run retries it with the same idempotency key and leaves a one-time reminder due. That covers a crash after the attempt mark and before the provider accepts. After the lease, a one-time email is retried for 24 hours with the same key, because Resend treats a repeat of that key as the same send. A repeating email past the lease is marked not delivered and the series moves on, so that occurrence is not submitted again and the list shows the miss. Telegram cannot dedupe, so a retry inside the lease after Telegram has accepted and before the message id is stored can deliver that ping twice. Fillip prefers that possible duplicate over dropping a ping the provider never accepted. After the Telegram lease, Fillip does not call sendMessage again. It marks the occurrence not delivered, shows that in the list, and emails a failed or delayed notice with the key fillip/<reminder>/<occurrence>/not-delivered. A claim that dies after its lock ticket and before the status update is retried once that ticket is two minutes old. Moving from the free plan to Pro clears a hold that was only the free monthly cap, so a due reminder sends on the next run. An every-N series jumps straight to the next occurrence, and one reminder that fails does not stop the rest of the sweep. Resend Pro allows 50,000 emails a month and has no daily limit. 600 a day and 15,000 a month are Fillip's chosen share of that shared pool. Set `FILLIP_GLOBAL_MAX_EMAILS_PER_DAY` to 600 and `FILLIP_GLOBAL_MAX_EMAILS_PER_MONTH` to 15000. If either value is empty, Fillip sends no email and logs that the guard is closed. When either number is reached, or Resend returns a quota or rate-limit response, Fillip keeps the due reminders queued and sends them in order after the window or the backoff passes. It does not mark them sent. A late email says it was delayed. Public `GET /health` returns only `ok`, `service`, and `version`. `GET /internal/status` with a `CRON_SECRET` bearer token shows the current counts under `globalEmails`, `purged` and `purgedAt` for the count and time recorded by the last delivery run, which is the only place that deletes removed reminders older than 30 days, and `stopped` with reason `provider` while a 429 back-off is still in the future. Re-run `supabase/schema.sql` so the provider backoff row and `billing_event_created` column exist. A nonexistent local time, such as 2:30am on a spring-forward morning, is not saved. The tool says the clock does not exist and names the shifted time. Saving it requires accept_shifted_time. A repeating reminder that was already saved moves only that occurrence forward by one hour for that day, to 3:30 rather than 1:30. An ambiguous fall-back hour is saved and named. Abbreviations such as EST and PST are refused; use an IANA zone such as America/New_York. A recurring reminder that missed its runs jumps to the next future time instead of replaying each missed one.
4. Generate `FILLIP_UNSUBSCRIBE_SECRET` and `CRON_SECRET`. Set `APP_BASE_URL` to the public origin.
5. Deploy the Dockerfile or `npm start`. Do not commit `.env`.
6. Schedule delivery once a minute. On Vercel, `vercel.json` already calls `GET /internal/deliver`. Set `CRON_SECRET` on the project and Vercel sends it as a bearer token. On Supabase, the commented schedule in `supabase/cron.sql` posts to the same path with `pg_cron` and `pg_net`. One of those is enough.
7. After the public URL exists, put it in `server.json` `remotes` and in the connect instructions you give people. Update `mcp_resource` if the host changed, then reconnect clients.
8. Re-run `supabase/schema.sql` so the free-plan default, reminder channel, calendar token, Telegram columns, the owner select and delete policies on `deliveries`, and the open-reminder cap trigger exist. The select policy is what lets an authenticated session delete its own delivery rows. The trigger locks the owner's profile row and an advisory lock on insert and on an update that turns a reminder active, so creates and resumes cannot both pass the free plan's 10 open reminders. `fillip_reserve_ping` increments the monthly counter and the daily counter in one conditional update. The older 3-argument form is dropped on that re-run. `remove_reminder` sets the reminder to removed and records `removed_at`. It leaves the list and the calendar feed and does not send. `restore_reminder` brings back the same id within 30 days in the exact status it had before. Only a reminder that was active gets a new next time when the old one has passed, and only that one goes through the open-cap trigger. A paused reminder stays paused, keeps its time, and does not go through the cap, because paused rows are not open. A cancelled or completed reminder comes back as it was, does not send, and does not count toward the open cap. Restoring one that is already back returns that reminder and the note `Already restored.` Removed rows do not count toward the open cap. `GET` or `POST /internal/deliver` runs `fillip_purge_removed` before it checks the email provider, so a missing `RESEND_API_KEY` still deletes removed reminders older than 30 days and their deliveries. That 503 response includes the purged count. `GET /internal/status` does not delete anything. It reports the last purge count and time under `purged` and `purgedAt`. Right before the email or Telegram provider call, Fillip checks again that the reminder is still active. If it was removed, paused, cancelled, or completed, that delivery is marked skipped, nothing is sent, and the reserved ping is released. Remove, pause, and cancel mark an in-progress delivery cancelled in the same update. Export or delete on the data page, and account deletion, still remove those rows immediately. Deleting account data and its deliveries runs with the service role. Authenticated users can still select and delete their own rows, and cannot insert or update reminders directly. The profile row stays; it holds the billing identity. Support requests are not keyed to the account. The calendar feed is `GET /calendar/<token>.ics`. `calendar_feed` returns that secret link and can rotate it. Old links stop working after a rotation.
9. Telegram is optional and uses a webhook, not polling. In BotFather, create a bot and copy its token into `TELEGRAM_BOT_TOKEN`. Set `TELEGRAM_WEBHOOK_SECRET` to a long random string. Optionally set `TELEGRAM_BOT_USERNAME`. Then register the webhook (replace the two secrets and the public origin):

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$APP_BASE_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d "allowed_updates=[\"message\"]"
```

People link a chat from `delivery_settings`, which returns a `t.me` start link that expires in 30 minutes. Fillip answers `POST /telegram/webhook` only when the bot token is set and the secret header matches. If `TELEGRAM_BOT_TOKEN` is empty, that path is not found and the delivery tool is not listed. Telegram sends count toward the per-account ping allowance. A reminder delivered to both email and Telegram counts as 2 pings. Telegram does not count toward the Resend global guard. Telegram cannot dedupe a message the way Resend can. Fillip stores an attempt on `fillip/<reminder>/<occurrence>/telegram` before calling sendMessage. A run inside the two-minute claim lease retries that attempt with the same key. Telegram cannot dedupe, so a crash after Telegram accepted and before the message id is stored can deliver a second copy. Fillip prefers that duplicate over dropping a ping the provider never accepted. After the lease, that attempt is not submitted again. Fillip marks it not delivered, shows it in the list, and emails a failed or delayed notice.

`GET /health` should show the Supabase, Stripe, Resend, and sender flags as true before you rely on a ping. `globalEmails` shows how close the shared send guard is. `stopped: true` means due reminders are waiting, not dropped.
