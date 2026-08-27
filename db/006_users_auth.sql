CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (
 id BIGSERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 full_name VARCHAR(160) NOT NULL DEFAULT '', role VARCHAR(20) NOT NULL DEFAULT 'USER',
 email_verified BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS user_sessions (
 id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash CHAR(64) UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), user_agent TEXT, ip_address INET
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE TABLE IF NOT EXISTS user_tokens (
 id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash CHAR(64) UNIQUE NOT NULL, token_type VARCHAR(30) NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_tokens_user_type ON user_tokens(user_id,token_type);
CREATE TABLE IF NOT EXISTS user_favorite_currencies (
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, currency_code VARCHAR(3) NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,currency_code)
);
CREATE TABLE IF NOT EXISTS user_favorite_companies (
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, company_id INT NOT NULL REFERENCES exchange_companies(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,company_id)
);
CREATE TABLE IF NOT EXISTS user_alerts (
 id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 from_currency VARCHAR(3) NOT NULL DEFAULT 'KWD', to_currency VARCHAR(3) NOT NULL,
 target_rate NUMERIC(18,8) NOT NULL, direction VARCHAR(10) NOT NULL DEFAULT 'ABOVE', method VARCHAR(20) NOT NULL DEFAULT 'CASH',
 company_id INT REFERENCES exchange_companies(id) ON DELETE SET NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
 last_triggered_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_alerts_active ON user_alerts(user_id,is_active);
CREATE TABLE IF NOT EXISTS user_comparisons (
 id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 from_currency VARCHAR(3) NOT NULL, to_currency VARCHAR(3) NOT NULL, amount NUMERIC(18,4) NOT NULL,
 method VARCHAR(20) NOT NULL DEFAULT 'CASH', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_comparisons_user ON user_comparisons(user_id,created_at DESC);
