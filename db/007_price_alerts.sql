CREATE TABLE IF NOT EXISTS alert_events (
 id BIGSERIAL PRIMARY KEY,
 alert_id BIGINT NOT NULL REFERENCES user_alerts(id) ON DELETE CASCADE,
 observed_rate NUMERIC(18,8) NOT NULL,
 target_rate NUMERIC(18,8) NOT NULL,
 direction VARCHAR(10) NOT NULL,
 method VARCHAR(20) NOT NULL,
 company_id INT REFERENCES exchange_companies(id) ON DELETE SET NULL,
 trust_score INT,
 triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_events_alert_time ON alert_events(alert_id, triggered_at DESC);

CREATE TABLE IF NOT EXISTS notification_outbox (
 id BIGSERIAL PRIMARY KEY,
 alert_event_id BIGINT NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 channel VARCHAR(20) NOT NULL DEFAULT 'IN_APP',
 destination TEXT,
 subject TEXT,
 body TEXT NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
 attempts INT NOT NULL DEFAULT 0,
 available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 sent_at TIMESTAMPTZ,
 last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending ON notification_outbox(status, available_at);

ALTER TABLE user_alerts ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'IN_APP';
ALTER TABLE user_alerts ADD COLUMN IF NOT EXISTS cooldown_minutes INT NOT NULL DEFAULT 60;
ALTER TABLE user_alerts ADD COLUMN IF NOT EXISTS amount NUMERIC(18,4) NOT NULL DEFAULT 1;
ALTER TABLE user_alerts ADD COLUMN IF NOT EXISTS last_condition_state BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_alerts ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE user_alerts ADD COLUMN IF NOT EXISTS last_observed_rate NUMERIC(18,8);
ALTER TABLE user_alerts ADD COLUMN IF NOT EXISTS last_trust_score INT;
ALTER TABLE user_alerts ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE user_alerts ADD COLUMN IF NOT EXISTS webhook_url TEXT;

DO $$ BEGIN
  ALTER TABLE user_alerts ADD CONSTRAINT user_alerts_channel_chk CHECK (channel IN ('IN_APP','EMAIL','PUSH','WHATSAPP','WEBHOOK'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE user_alerts ADD CONSTRAINT user_alerts_direction_chk CHECK (direction IN ('ABOVE','BELOW'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE user_alerts ADD CONSTRAINT user_alerts_method_chk CHECK (method IN ('CASH','TRANSFER','CARD'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
