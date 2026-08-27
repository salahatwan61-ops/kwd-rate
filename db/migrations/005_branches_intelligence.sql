ALTER TABLE branches ADD COLUMN IF NOT EXISTS services JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS map_label VARCHAR(180);
CREATE INDEX IF NOT EXISTS idx_branches_geo ON branches(latitude, longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
