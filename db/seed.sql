INSERT INTO currencies(code,name_ar,name_en,symbol,flag,sort_order) VALUES
('KWD','الدينار الكويتي','Kuwaiti Dinar','د.ك','🇰🇼',1),('USD','الدولار الأمريكي','US Dollar','$','🇺🇸',2),('EUR','اليورو','Euro','€','🇪🇺',3),('GBP','الجنيه الإسترليني','British Pound','£','🇬🇧',4),('SAR','الريال السعودي','Saudi Riyal','﷼','🇸🇦',5),('AED','الدرهم الإماراتي','UAE Dirham','د.إ','🇦🇪',6),('EGP','الجنيه المصري','Egyptian Pound','E£','🇪🇬',7),('INR','الروبية الهندية','Indian Rupee','₹','🇮🇳',8)
ON CONFLICT(code) DO NOTHING;
INSERT INTO exchange_companies(name_ar,name_en,slug,rating) VALUES
('شركة الصرافة A','Exchange A','exchange-a',4.8),('شركة الصرافة B','Exchange B','exchange-b',4.6),('شركة الصرافة C','Exchange C','exchange-c',4.5),('شركة الصرافة D','Exchange D','exchange-d',4.2)
ON CONFLICT(slug) DO NOTHING;
INSERT INTO rate_sources(name,type,status) VALUES ('KWD Rate Manual Feed','MANUAL','ACTIVE') ON CONFLICT DO NOTHING;
INSERT INTO exchange_rates(company_id,currency_id,buy_rate,sell_rate,transfer_rate,fees,source_id,captured_at)
SELECT c.id, cur.id, v.buy, v.sell, v.sell, 0, s.id, NOW() FROM (VALUES
('exchange-a','USD',3.2574,3.2574),('exchange-b','USD',3.2512,3.2512),('exchange-c','USD',3.2478,3.2478),('exchange-d','USD',3.2410,3.2410),
('exchange-a','EUR',3.8061,3.8061),('exchange-b','EUR',3.7980,3.7980),('exchange-a','GBP',4.3922,4.3922),('exchange-a','SAR',0.8674,0.8674),('exchange-a','AED',0.8867,0.8867),('exchange-a','EGP',106.18,106.18),('exchange-a','INR',269.70,269.70)
) v(slug,code,buy,sell) JOIN exchange_companies c ON c.slug=v.slug JOIN currencies cur ON cur.code=v.code CROSS JOIN rate_sources s WHERE s.name='KWD Rate Manual Feed';

UPDATE exchange_rates SET quote_type='CASH', rate_basis='FOREIGN_PER_KWD', fee_type='FIXED', fee_currency='KWD', confidence=80 WHERE quote_type IS NULL OR rate_basis IS NULL;
