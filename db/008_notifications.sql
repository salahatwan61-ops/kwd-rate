CREATE TABLE IF NOT EXISTS notification_preferences (
 user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 whatsapp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 whatsapp_phone VARCHAR(32),
 quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 quiet_start TIME,
 quiet_end TIME,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 endpoint TEXT NOT NULL,
 p256dh TEXT NOT NULL,
 auth TEXT NOT NULL,
 user_agent TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_used_at TIMESTAMPTZ,
 UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS provider VARCHAR(40);
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(32);
INSERT INTO notification_preferences(user_id)
SELECT id FROM users ON CONFLICT DO NOTHING;
