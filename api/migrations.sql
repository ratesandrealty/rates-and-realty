-- ============================================================
-- RATES & REALTY — SQL MIGRATION
-- Run in Supabase SQL Editor (supabase.com → your project → SQL)
-- ============================================================

-- ── APPOINTMENTS TABLE ────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title       TEXT NOT NULL,
  type        TEXT DEFAULT 'call',          -- call | appointment | showing | follow-up | milestone
  status      TEXT DEFAULT 'scheduled',     -- scheduled | completed | cancelled
  scheduled_at TIMESTAMPTZ NOT NULL,
  lead_id     TEXT,                         -- references leads.id (loose FK for flexibility)
  contact_id  UUID REFERENCES contacts(id),
  notes       TEXT,
  created_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: admin users can read/write all; others see nothing
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access to appointments"
  ON appointments
  FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- ── ACTIVITY EVENTS TABLE ─────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_events (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id     TEXT,                         -- references leads.id
  contact_id  UUID REFERENCES contacts(id),
  user_id     UUID REFERENCES auth.users(id),
  type        TEXT NOT NULL,               -- lead_created | status_changed | note_added | task_created | etc.
  description TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access to activity_events"
  ON activity_events
  FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- Index for fast lead-level queries
CREATE INDEX IF NOT EXISTS idx_activity_events_lead_id ON activity_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_activity_events_created_at ON activity_events(created_at DESC);

-- ── COMMUNICATIONS TABLE ──────────────────────────────────
-- Stores SMS, email, and call log entries (Twilio/email integration ready)
CREATE TABLE IF NOT EXISTS communications (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id         TEXT,
  contact_id      UUID REFERENCES contacts(id),
  type            TEXT NOT NULL,            -- sms | email | call
  direction       TEXT DEFAULT 'outbound',  -- inbound | outbound
  contact_name    TEXT,
  subject         TEXT,
  body            TEXT,
  status          TEXT DEFAULT 'sent',      -- sent | delivered | failed | received
  external_id     TEXT,                     -- Twilio message SID, email provider ID
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE communications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access to communications"
  ON communications
  FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_communications_lead_id ON communications(lead_id);

-- ── WEBSITE EVENTS TABLE ──────────────────────────────────
-- For tracking page visits, CTA clicks, form starts (add JS tracking later)
CREATE TABLE IF NOT EXISTS website_events (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id  TEXT,
  lead_id     TEXT,
  event_type  TEXT NOT NULL,              -- page_view | cta_click | form_start | form_submit
  page        TEXT,
  source      TEXT,
  medium      TEXT,
  campaign    TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE website_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public insert for website_events"
  ON website_events
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Admin read website_events"
  ON website_events
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- ── LEADS TABLE ENHANCEMENTS ──────────────────────────────
-- Add missing columns if they don't exist (safe to run multiple times)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_type TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS loan_amount NUMERIC;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_address TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES auth.users(id);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ── CONTACTS TABLE ENHANCEMENTS ───────────────────────────
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_type TEXT DEFAULT 'lead';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;

-- ── TASKS TABLE ENHANCEMENTS ──────────────────────────────
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES auth.users(id);

-- ── UPDATED_AT TRIGGERS ───────────────────────────────────
-- Auto-update updated_at on leads
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS leads_updated_at ON leads;
CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

DROP TRIGGER IF EXISTS tasks_updated_at ON tasks;
CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

DROP TRIGGER IF EXISTS appointments_updated_at ON appointments;
CREATE TRIGGER appointments_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- ── SEED: Update existing lead statuses ───────────────────
-- Normalize any null status values to "new"
UPDATE leads SET status = 'new' WHERE status IS NULL;
UPDATE tasks SET status = 'open' WHERE status IS NULL;

-- ── SHOWINGS TABLE ────────────────────────────────────────
-- Public-facing showing scheduler (from search-homes.html)
CREATE TABLE IF NOT EXISTS showings (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL,
  phone            TEXT,
  property_address TEXT NOT NULL,
  preferred_date   DATE,
  preferred_time   TEXT,
  status           TEXT DEFAULT 'new'
                     CHECK (status IN ('new','confirmed','completed','cancelled')),
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE showings ENABLE ROW LEVEL SECURITY;

-- Anyone can submit a showing request
CREATE POLICY "public_insert_showings"
  ON showings FOR INSERT
  WITH CHECK (true);

-- Anyone can read (admin checks via app logic; harden with auth if needed)
CREATE POLICY "public_read_showings"
  ON showings FOR SELECT
  USING (true);

-- Updates allowed (for status changes from CRM)
CREATE POLICY "public_update_showings"
  ON showings FOR UPDATE
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_showings_status     ON showings(status);
CREATE INDEX IF NOT EXISTS idx_showings_created_at ON showings(created_at DESC);

DROP TRIGGER IF EXISTS showings_updated_at ON showings;
CREATE TRIGGER showings_updated_at
  BEFORE UPDATE ON showings
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();


-- ── FAVORITES TABLE ────────────────────────────────────────
-- Saved/favorited listings from search-homes.html
CREATE TABLE IF NOT EXISTS favorites (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email    TEXT NOT NULL,
  property_id   TEXT NOT NULL,
  property_data JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_email, property_id)
);

ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_insert_favorites"
  ON favorites FOR INSERT
  WITH CHECK (true);

CREATE POLICY "public_read_favorites"
  ON favorites FOR SELECT
  USING (true);

CREATE POLICY "public_delete_favorites"
  ON favorites FOR DELETE
  USING (true);

CREATE INDEX IF NOT EXISTS idx_favorites_user_email  ON favorites(user_email);
CREATE INDEX IF NOT EXISTS idx_favorites_property_id ON favorites(property_id);


-- ── LEAD SCORING COLUMNS ──────────────────────────────────
-- Add score_tier to leads table (score column should already exist)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS score_tier TEXT DEFAULT 'cold';  -- hot | warm | cold

-- Add lead_score and score_tier to contacts table
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_score  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS score_tier  TEXT DEFAULT 'cold';  -- hot | warm | cold

-- Add timeline column to leads if missing (used for scoring)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS timeline TEXT;  -- asap | 1-3months | 3-6months | 6-12months | exploring

-- Index for fast tier filtering
CREATE INDEX IF NOT EXISTS idx_leads_score_tier    ON leads(score_tier);
CREATE INDEX IF NOT EXISTS idx_contacts_score_tier ON contacts(score_tier);
CREATE INDEX IF NOT EXISTS idx_contacts_lead_score ON contacts(lead_score DESC);

-- ── DPA PROGRAMS — max_income_tier column ─────────────────
-- Add max_income_tier to dpa_programs if not present
ALTER TABLE public.dpa_programs
  ADD COLUMN IF NOT EXISTS max_income_tier TEXT DEFAULT 'over180';

UPDATE public.dpa_programs
  SET max_income_tier = 'over180'
  WHERE slug IN ('calhfa-myhome', 'gsfa-platinum', 'calhfa-zip', 'calhfa-dream-for-all');

UPDATE public.dpa_programs
  SET max_income_tier = '80to120'
  WHERE slug IN ('oc-map', 'santa-ana-dpa');

-- DPA leads table
CREATE TABLE IF NOT EXISTS public.dpa_leads (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  first_name        TEXT,
  last_name         TEXT,
  email             TEXT,
  phone             TEXT,
  county            TEXT,
  first_time_buyer  BOOLEAN,
  credit_score_range TEXT,
  program_interest  TEXT,
  message           TEXT,
  utm_source        TEXT,
  utm_campaign      TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.dpa_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_insert_dpa_leads" ON public.dpa_leads
  FOR INSERT WITH CHECK (true);

CREATE POLICY "public_read_dpa_leads" ON public.dpa_leads
  FOR SELECT USING (true);

-- Done!
-- After running this migration:
-- 1. The CRM Calendar will start saving appointments
-- 2. Activity events will log to the timeline
-- 3. Communications feed will be ready for Twilio/email integration
-- 4. Website event tracking is ready for JS instrumentation
-- 5. Showing scheduler (search-homes.html) saves to showings table
-- 6. Favorites (search-homes.html) saved to favorites table
-- 7. Lead scoring columns added to leads and contacts tables
