CREATE TABLE IF NOT EXISTS currencies (
 id SERIAL PRIMARY KEY, code VARCHAR(3) UNIQUE NOT NULL, name_ar VARCHAR(100) NOT NULL, name_en VARCHAR(100) NOT NULL,
 symbol VARCHAR(20), flag VARCHAR(10), decimal_places SMALLINT NOT NULL DEFAULT 2, is_active BOOLEAN NOT NULL DEFAULT TRUE,
 sort_order INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS exchange_companies (
 id SERIAL PRIMARY KEY, name_ar VARCHAR(160) NOT NULL, name_en VARCHAR(160), slug VARCHAR(180) UNIQUE NOT NULL,
 logo_url TEXT, description_ar TEXT, phone VARCHAR(40), website TEXT, rating NUMERIC(3,2), is_active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS branches (
 id SERIAL PRIMARY KEY, company_id INT NOT NULL REFERENCES exchange_companies(id) ON DELETE CASCADE, name VARCHAR(160) NOT NULL,
 area VARCHAR(100), address TEXT, latitude NUMERIC(10,7), longitude NUMERIC(10,7), phone VARCHAR(40), working_hours JSONB,
 is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS rate_sources (
 id SERIAL PRIMARY KEY, name VARCHAR(160) NOT NULL, type VARCHAR(30) NOT NULL DEFAULT 'MANUAL', endpoint TEXT,
 update_frequency_minutes INT, last_success TIMESTAMPTZ, status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE IF NOT EXISTS exchange_rates (
 id BIGSERIAL PRIMARY KEY, company_id INT NOT NULL REFERENCES exchange_companies(id) ON DELETE CASCADE,
 currency_id INT NOT NULL REFERENCES currencies(id) ON DELETE CASCADE, buy_rate NUMERIC(18,8), sell_rate NUMERIC(18,8),
 transfer_rate NUMERIC(18,8), fees NUMERIC(18,4) NOT NULL DEFAULT 0, source_id INT REFERENCES rate_sources(id),
 captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ, status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
);
CREATE INDEX IF NOT EXISTS idx_rates_currency_time ON exchange_rates(currency_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_rates_company_currency_time ON exchange_rates(company_id, currency_id, captured_at DESC);
CREATE TABLE IF NOT EXISTS price_alerts (
 id BIGSERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, from_currency VARCHAR(3) NOT NULL DEFAULT 'KWD', to_currency VARCHAR(3) NOT NULL,
 target_rate NUMERIC(18,8) NOT NULL, direction VARCHAR(10) NOT NULL DEFAULT 'ABOVE', is_active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
