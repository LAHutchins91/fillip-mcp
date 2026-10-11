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

`GET /health` reports whether Supabase, Stripe, the sender, and Telegram are configured. `POST /mcp` with `tools/list` answers without a sign-in. Tool calls require OAuth. A signed-in account on the free plan, the trial, or Pro can use them. Caps, not a lockout, enforce the plan.

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
| `SUPABASE_SERVICE_ROLE_KEY` | Service role for the delivery job, billing profile writes, and the stop link. |
| `STRIPE_SECRET_KEY` | Stripe secret for Checkout and the billing portal. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `POST /billing/webhook`. |
| `STRIPE_PRODUCT_ID` | Fillip's own Stripe product id. Webhook events for any other product are ignored. |
| `STRIPE_PRICE_MONTHLY` | Fillip's monthly price id on that product. Not printed. |
| `STRIPE_PRICE_YEARLY` | Fillip's yearly price id on that product. Not printed. |
| `RESEND_API_KEY` | Resend token used only by the delivery job. |
| `FILLIP_FROM_EMAIL` | From address on a domain you have verified in Resend. Required. There is no default address. |
| `FILLIP_UNSUBSCRIBE_SECRET` | HMAC secret for stop links. Required before any email is sent. A GET on the link shows a confirm page. POST is what stops mail, so a link prefetcher cannot unsubscribe the account. |
| `FILLIP_UNSUBSCRIBE_SECRET_PREVIOUS` | Comma-separated secrets that should still open stop links after `FILLIP_UNSUBSCRIBE_SECRET` is rotated. Empty when there is no previous secret. |
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

1. Create a Supabase project. Run `supabase/schema.sql`, then `supabase/oauth_resource_binding.sql`. In Authentication → Auth Hooks, set Customize Access Token Claims to `public.fillip_access_token_hook`. Set `fillip_private.settings.mcp_resource` to `APP_BASE_URL/mcp` (see `supabase/README-oauth.md`). Add redirect URLs for `APP_BASE_URL` and `APP_BASE_URL/oauth/consent`. The consent page emails a one-time code. In Authentication → Providers, keep Email enabled. In Authentication → Emails, the Magic Link template must show `{{ .Token }}` so the message contains the code the page asks for. Turn on custom SMTP and point it at Resend (`smtp.resend.com`, port 465, username `resend`, password a Resend API key, sender on your verified domain). Supabase's built-in mailer is rate limited; Resend SMTP is what keeps sign-in codes arriving. Leave Google disabled unless you set `FILLIP_AUTH_GOOGLE_ENABLED=true` after enabling that provider. Password sign-in stays on the page behind "Use a password instead" for a review account.
2. In Stripe, create Fillip's own product and two prices on it, monthly and yearly. Put those ids in `STRIPE_PRODUCT_ID`, `STRIPE_PRICE_MONTHLY`, and `STRIPE_PRICE_YEARLY`. Point a webhook at `APP_BASE_URL/billing/webhook` for `checkout.session.completed` and the customer subscription events. Checkout starts a 14-day trial, then Pro, and stamps the Fillip product id on the session. The webhook applies an event only when every product id on it is `STRIPE_PRODUCT_ID` and the price is one of those two. Other products on the same Stripe account are ignored. When the subscription is no longer entitled, the account moves to the free plan and reminders keep working inside the free caps. Set `FILLIP_CAP_TRIAL_EMAILS_PER_MONTH`, `FILLIP_CAP_PRO_EMAILS_PER_MONTH`, and `FILLIP_CAP_ANNUAL_EMAILS_PER_MONTH` to the allowances those plans can afford. Unset monthly caps default to 100 for the whole trial and 1,000 for Pro and Annual. `FILLIP_CAP_FREE_OPEN_REMINDERS` and `FILLIP_CAP_FREE_EMAILS_PER_MONTH` default to 10 and 30. An older `customer.subscription.deleted` event does not revoke a newer active Fillip subscription.
3. In Resend, verify the domain you will send from. Set `RESEND_API_KEY` and `FILLIP_FROM_EMAIL` to an address on that domain. Fillip sends one recipient, the account's verified email. Each ping is reserved on the account counter before the provider is called, so the last free ping cannot leave twice (once per channel, or from two workers). The email idempotency key is `fillip/<reminder>/<occurrence>`. The Telegram key for that same occurrence is `fillip/<reminder>/<occurrence>/telegram`. Fillip writes the attempt on the delivery row before the call and will not call the provider again for that occurrence and channel. Resend treats a repeat of the email key as the same send. Telegram's API has no idempotency key. The residual risk is a dropped ping: if the process dies after that row is stored and before Telegram accepts, Fillip does not retry, so the message is not sent twice. A crash after Telegram accepts is not sent again, because the row was written first. A claim that dies after its lock ticket and before the status update is retried once that ticket is two minutes old. Moving from the free plan to Pro clears a hold that was only the free monthly cap, so a due reminder sends on the next run. An every-N series jumps straight to the next occurrence, and one reminder that fails does not stop the rest of the sweep. Resend Pro allows 50,000 emails a month and has no daily limit. 600 a day and 15,000 a month are Fillip's chosen share of that shared pool. Set `FILLIP_GLOBAL_MAX_EMAILS_PER_DAY` to 600 and `FILLIP_GLOBAL_MAX_EMAILS_PER_MONTH` to 15000. If either value is empty, Fillip sends no email and logs that the guard is closed. When either number is reached, or Resend returns a quota or rate-limit response, Fillip keeps the due reminders queued and sends them in order after the window or the backoff passes. It does not mark them sent. A late email says it was delayed. Public `GET /health` returns only `ok`, `service`, and `version`. `GET /internal/status` with a `CRON_SECRET` bearer token shows the current counts under `globalEmails`, and `stopped` with reason `provider` while a 429 back-off is still in the future. Re-run `supabase/schema.sql` so the provider backoff row and `billing_event_created` column exist. A nonexistent local time, such as 2:30am on a spring-forward morning, is moved forward and the tool says so. Abbreviations such as EST and PST are refused; use an IANA zone such as America/New_York. A recurring reminder that missed its runs jumps to the next future time instead of replaying each missed one.
4. Generate `FILLIP_UNSUBSCRIBE_SECRET` and `CRON_SECRET`. Set `APP_BASE_URL` to the public origin.
5. Deploy the Dockerfile or `npm start`. Do not commit `.env`.
6. Schedule delivery once a minute. On Vercel, `vercel.json` already calls `GET /internal/deliver`. Set `CRON_SECRET` on the project and Vercel sends it as a bearer token. On Supabase, the commented schedule in `supabase/cron.sql` posts to the same path with `pg_cron` and `pg_net`. One of those is enough.
7. After the public URL exists, put it in `server.json` `remotes` and in the connect instructions you give people. Update `mcp_resource` if the host changed, then reconnect clients.
8. Re-run `supabase/schema.sql` so the free-plan default, reminder channel, calendar token, Telegram columns, the owner select and delete policies on `deliveries`, and the open-reminder cap trigger exist. The select policy is what lets an authenticated session delete its own delivery rows. The trigger locks the owner's count so two creates cannot both pass the free plan's 10 open reminders. Deleting reminders runs with the service role, so a missing user delete policy cannot leave delivery rows behind. The profile row stays; it holds the billing identity. Support requests are not keyed to the account. The calendar feed is `GET /calendar/<token>.ics`. `calendar_feed` returns that secret link and can rotate it. Old links stop working after a rotation.
9. Telegram is optional and uses a webhook, not polling. In BotFather, create a bot and copy its token into `TELEGRAM_BOT_TOKEN`. Set `TELEGRAM_WEBHOOK_SECRET` to a long random string. Optionally set `TELEGRAM_BOT_USERNAME`. Then register the webhook (replace the two secrets and the public origin):

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$APP_BASE_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d "allowed_updates=[\"message\"]"
```

People link a chat from `delivery_settings`, which returns a `t.me` start link that expires in 30 minutes. Fillip answers `POST /telegram/webhook` only when the bot token is set and the secret header matches. If `TELEGRAM_BOT_TOKEN` is empty, that path is not found and the delivery tool is not listed. Telegram sends count toward the per-account ping allowance. A reminder delivered to both email and Telegram counts as 2 pings. Telegram does not count toward the Resend global guard. Telegram cannot dedupe a message the way Resend can. Fillip stores `fillip/<reminder>/<occurrence>/telegram` before calling sendMessage and then will not call again. If that stored attempt is lost after Telegram has already accepted, a later run could deliver a second copy; writing the attempt first is what keeps that window to a lost database write.

`GET /health` should show the Supabase, Stripe, Resend, and sender flags as true before you rely on a ping. `globalEmails` shows how close the shared send guard is. `stopped: true` means due reminders are waiting, not dropped.
