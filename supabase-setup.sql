-- Run this in the Supabase SQL Editor:
-- https://szjlcnprjwlnntlryqpz.supabase.co/project/default/sql

CREATE TABLE IF NOT EXISTS app_state (
  id          TEXT        PRIMARY KEY DEFAULT 'default',
  data        JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE app_state ENABLE ROW LEVEL SECURITY;

-- Allow full access with the anon key (single-user app)
CREATE POLICY "Allow anon full access" ON app_state
  FOR ALL TO anon
  USING (true)
  WITH CHECK (true);
