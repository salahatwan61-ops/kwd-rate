# KWD Rate — Price Alerts v1

## Flow
`Collector -> DB -> Trust/Comparison -> Alert Engine -> alert_events -> notification_outbox`

Every scheduled/manual rate sync evaluates active user alerts after rate collection. An alert only triggers when the observed quote is fresh, valid, and has a trust score >= 65. Company-specific alerts are evaluated against that company; market alerts use the best eligible company.

## Anti-spam
- `cooldown_minutes` defaults to 60 and cannot be created below 5 minutes through the API.
- A condition crossing the target triggers immediately.
- If the condition remains true, a repeat notification is allowed only after the cooldown.
- Every trigger is stored in `alert_events`.

## Channels
- `IN_APP`: durable notification stored in `notification_outbox` and shown by the account API.
- `EMAIL`: queued with the user's email as destination. A real email provider/SMTP worker must be configured before production delivery.
- `WEBHOOK`: queued and can be dispatched with `node alert-engine.js --once` when `dispatchWebhooks()` is invoked by a worker; failed deliveries retry up to 5 times.

## Existing database
Run:
`psql "$DATABASE_URL" -f db/007_price_alerts.sql`

For a fresh Docker database it is mounted automatically as init script 08.

# Notification Delivery v2

Channels now supported: `IN_APP`, `EMAIL`, `PUSH`, `WHATSAPP`, `WEBHOOK`.

Run the worker every 30 seconds in production (cron, systemd timer, PM2, or a container):
`node notification-worker.js --once`

## Email
Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.

## Browser Push
Generate VAPID keys with:
`npx web-push generate-vapid-keys`
Then set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`.
Push requires HTTPS in production.

## WhatsApp
Set `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` for Meta WhatsApp Cloud API. The user must opt in and provide an international-format phone number. For business-initiated messages outside the applicable WhatsApp customer-service window, use an approved WhatsApp message template.

## User controls
`/account.html` now contains a Notification Center, unread count, mark-read controls, delivery preferences, quiet hours, and browser push registration.
