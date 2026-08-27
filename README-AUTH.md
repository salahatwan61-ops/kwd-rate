# KWD Rate v10 — User Authentication

## Included
- Registration/login/logout with HttpOnly session cookie.
- Password hashing with Node.js `crypto.scrypt` (no password stored in plaintext).
- Email verification tokens and password reset tokens.
- User profile and password change.
- Favorites for currencies and exchange companies.
- User-owned price alerts and comparison history.
- USER/ADMIN roles in the data model.
- Login/register rate limiting in-process.

## Database
New migration: `db/006_users_auth.sql`.
For a fresh Docker database it is mounted automatically as init script 07.
For an existing PostgreSQL database, run the migration manually:

```bash
psql "$DATABASE_URL" -f db/006_users_auth.sql
```

## Routes
- `/auth.html` — login/register/reset flow
- `/account.html` — authenticated account dashboard
- `GET /api/auth/me`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/verify-email?token=...`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/account`
- `PUT /api/account/profile`
- `PUT /api/account/password`
- `POST/DELETE /api/account/favorites/currency...`
- `POST/DELETE /api/account/favorites/company...`
- `POST/DELETE /api/account/alerts...`
- `POST /api/account/comparisons`

## Production notes
Set `NODE_ENV=production`, a real `APP_BASE_URL`, and `COOKIE_SECURE=true` behind HTTPS. The development build returns verification/reset URLs in API responses so the flow can be tested without an email provider. In production, connect the token events to an email provider and do not expose `dev_url` values.

For multi-instance deployment, move login rate limiting to Redis and add CSRF protection for state-changing cookie-authenticated endpoints.

For notification delivery features, apply `db/008_notifications.sql` after the alerts migration.
