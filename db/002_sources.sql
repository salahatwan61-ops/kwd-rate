ALTER TABLE exchange_companies ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'EXCHANGE';
CREATE INDEX IF NOT EXISTS idx_companies_kind ON exchange_companies(kind);
INSERT INTO exchange_companies(name_ar,name_en,slug,kind,is_active) VALUES
('البنك المركزي الكويتي','Central Bank of Kuwait','cbk-reference','REFERENCE',true),
('شركة البحرين للصرافة','Bahrain Exchange Company (BEC)','bec-kuwait','EXCHANGE',true),
('الكويت والبحرين للصرافة','Kuwait Bahrain Exchange (KBE)','kbe-kuwait','EXCHANGE',true)
ON CONFLICT(slug) DO UPDATE SET name_ar=EXCLUDED.name_ar,name_en=EXCLUDED.name_en,kind=EXCLUDED.kind;
INSERT INTO rate_sources(name,type,endpoint,update_frequency_minutes,status) VALUES
('Central Bank of Kuwait','REFERENCE','https://www.cbk.gov.kw/en/monetary-policy/market-operations/exchange-rates',60,'ACTIVE'),
('BEC Kuwait','WEB','https://www.bec.com.kw/',10,'ACTIVE'),
('KBE Kuwait','WEB','https://kbe.com.kw/currencyrate.php',30,'ACTIVE')
ON CONFLICT DO NOTHING;
