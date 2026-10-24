-- Supabase schema for civic issue reports. Safe to re-run:
--   psql "$DATABASE_URL" -f schema/supabase.sql      (or paste into the Supabase SQL editor)
--
-- One row per report in civic_reports. The API shape is nested (see schema/report.schema.json):
--   { id, client_report_id, created_at,
--     user: what the resident sent   -> address .. was_queued_offline, photo_*, audio_*
--     ai:   the triage agent's output -> the `ai` jsonb column (null until it has run)
--     gov:  staff-owned fields        -> gov_* columns }
-- civic_report_json(row) builds that shape, so the mapping lives in one place.
--
-- Who writes what:
--   backend/main.py and frontend/server.js insert rows (user columns) and upload the photo /
--   voice note to the private Storage bucket "civic-reports" at photos/<id>.<ext>, audio/<id>.<ext>.
--   backend/agent.py fills `ai`. Staff change gov_* through set_report_gov().
--
-- Privacy: RLS is on with no policies, so Supabase's public REST API (anon key) cannot read the
-- table. The public issues board uses public_issues() / lookup_issues(), which return only
-- non-identifying fields: never contact, device id, user agent, voice note or internal notes.

CREATE SEQUENCE IF NOT EXISTS civic_report_seq START 1001;  -- ids are R-1001, R-1002, ...

CREATE TABLE IF NOT EXISTS civic_reports (
    id            text PRIMARY KEY,
    created_at    timestamptz NOT NULL DEFAULT now(),
    status        text NOT NULL DEFAULT 'received',
    address       text,
    description   text,
    contact_email text,
    contact_phone text,
    category      text,
    ai_summary    text,
    photo_path    text NOT NULL,
    photo_mime    text NOT NULL,
    photo_bytes   integer NOT NULL,
    audio_path    text,
    audio_mime    text,
    audio_bytes   integer
);
-- Columns added for the nested user / ai / gov schema (backend/main.py adds the same ones).
ALTER TABLE civic_reports
    ADD COLUMN IF NOT EXISTS client_report_id   text,
    ADD COLUMN IF NOT EXISTS submitted_at       timestamptz,
    ADD COLUMN IF NOT EXISTS lat                double precision,
    ADD COLUMN IF NOT EXISTS lng                double precision,
    ADD COLUMN IF NOT EXISTS accuracy_m         double precision,
    ADD COLUMN IF NOT EXISTS location_source    text,
    ADD COLUMN IF NOT EXISTS device_id          text,
    ADD COLUMN IF NOT EXISTS user_agent         text,
    ADD COLUMN IF NOT EXISTS was_queued_offline boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS audio_duration_s   double precision,
    ADD COLUMN IF NOT EXISTS ai                 jsonb,
    ADD COLUMN IF NOT EXISTS gov_status         text NOT NULL DEFAULT 'received',
    ADD COLUMN IF NOT EXISTS gov_department     text,
    ADD COLUMN IF NOT EXISTS gov_severity_score integer,
    ADD COLUMN IF NOT EXISTS gov_feedback       text,
    ADD COLUMN IF NOT EXISTS gov_internal_notes text,
    ADD COLUMN IF NOT EXISTS gov_updated_by     text,
    ADD COLUMN IF NOT EXISTS gov_updated_at     timestamptz,
    -- Public timeline for the issues board: [{status, at, note}], oldest first.
    -- '[]' for rows nobody has touched yet; civic_status_history() fills in the first step.
    ADD COLUMN IF NOT EXISTS gov_status_history jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE civic_reports ENABLE ROW LEVEL SECURITY;

-- ---------- merged problems (backend/problems.py) ----------
-- Several reports of the same real-world issue share one problem_id. Staff see one issue per
-- problem, and an action on it applies to every report in it.
ALTER TABLE civic_reports
    ADD COLUMN IF NOT EXISTS ip_hash      text,
    ADD COLUMN IF NOT EXISTS photo_sha256 text,
    ADD COLUMN IF NOT EXISTS photo_dhash  text,
    ADD COLUMN IF NOT EXISTS problem_id   text,
    ADD COLUMN IF NOT EXISTS merge_reason text,
    ADD COLUMN IF NOT EXISTS counted      boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS civic_reports_problem ON civic_reports (problem_id);

CREATE SEQUENCE IF NOT EXISTS civic_problem_seq START 1001;  -- P-1001, P-1002, ...
CREATE TABLE IF NOT EXISTS civic_problems (
    id               text PRIMARY KEY,
    created_at       timestamptz NOT NULL DEFAULT now(),
    last_reported_at timestamptz NOT NULL DEFAULT now(),
    status           text NOT NULL DEFAULT 'open',
    category         text NOT NULL,
    department       text,
    lat              double precision,
    lng              double precision,
    address          text,
    summary          text,
    first_report_id  text,
    top_report_id    text,
    report_count     integer NOT NULL DEFAULT 1,
    reporter_count   integer NOT NULL DEFAULT 1,
    base_severity    integer NOT NULL DEFAULT 0,
    severity_score   integer NOT NULL DEFAULT 0,
    severity_note    text
);
CREATE INDEX IF NOT EXISTS civic_problems_open ON civic_problems (status, category);
ALTER TABLE civic_problems ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  ALTER TABLE civic_reports ADD CONSTRAINT civic_reports_gov_status_check
    CHECK (gov_status IN ('received','in_review','assigned','in_progress','resolved','rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE civic_reports ADD CONSTRAINT civic_reports_gov_department_check
    CHECK (gov_department IN ('public_works','parks_and_recreation','police','fire','health_and_inspections','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE civic_reports ADD CONSTRAINT civic_reports_gov_severity_check
    CHECK (gov_severity_score BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE civic_reports ADD CONSTRAINT civic_reports_location_source_check
    CHECK (location_source IN ('gps','map','address'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS civic_reports_client_id ON civic_reports (client_report_id);
CREATE INDEX IF NOT EXISTS civic_reports_created_at_idx ON civic_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS civic_reports_gov_status_idx ON civic_reports (gov_status);
CREATE INDEX IF NOT EXISTS civic_reports_email_idx      ON civic_reports (lower(contact_email));
CREATE INDEX IF NOT EXISTS civic_reports_phone_idx      ON civic_reports (contact_phone);

-- The earlier draft of this file used a different function name.
DROP FUNCTION IF EXISTS set_report_status(text, text, text);

-- ---------- shape helpers ----------

-- ISO 8601 in UTC with milliseconds and a Z, matching what the servers write.
CREATE OR REPLACE FUNCTION civic_iso(t timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- Timeline for one report. Rows never touched by staff have an empty history: start it at
-- "received" when the report came in, plus the current status if someone set it directly.
CREATE OR REPLACE FUNCTION civic_status_history(r civic_reports) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN jsonb_array_length(r.gov_status_history) > 0 THEN r.gov_status_history
    ELSE jsonb_build_array(jsonb_build_object('status', 'received', 'at', civic_iso(r.created_at), 'note', NULL))
      || CASE WHEN r.gov_status <> 'received'
              THEN jsonb_build_array(jsonb_build_object('status', r.gov_status,
                     'at', civic_iso(coalesce(r.gov_updated_at, r.created_at)), 'note', r.gov_feedback))
              ELSE '[]'::jsonb END
  END;
$$;

-- The full report (staff view, includes contact details). Severity scores are strings ("64"),
-- as in the shared schema.
CREATE OR REPLACE FUNCTION civic_report_json(r civic_reports) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', r.id,
    'client_report_id', r.client_report_id,
    'created_at', civic_iso(r.created_at),
    'user', jsonb_build_object(
      'submitted_at', civic_iso(r.submitted_at),
      'photo', jsonb_build_object('path', r.photo_path, 'mime', r.photo_mime, 'bytes', r.photo_bytes),
      'audio', CASE WHEN r.audio_path IS NULL THEN NULL ELSE jsonb_build_object(
                 'path', r.audio_path, 'mime', r.audio_mime, 'bytes', r.audio_bytes,
                 'duration_s', r.audio_duration_s) END,
      'description', r.description,
      'category', r.category,
      'location', jsonb_build_object('lat', r.lat, 'lng', r.lng, 'accuracy_m', r.accuracy_m,
                                     'source', r.location_source, 'address', r.address),
      'contact', jsonb_build_object('email', r.contact_email, 'phone', r.contact_phone),
      'meta', jsonb_build_object('device_id', r.device_id, 'user_agent', r.user_agent,
                                 'was_queued_offline', r.was_queued_offline)),
    'ai', CASE WHEN r.ai IS NULL THEN NULL
               ELSE r.ai || jsonb_build_object('severity_score', r.ai->>'severity_score') END,
    -- The merged issue this report belongs to (null if not merged: unanalyzed or AI says invalid).
    'problem', (SELECT jsonb_build_object(
                  'id', p.id, 'status', p.status, 'category', p.category,
                  'severity_score', p.severity_score::text, 'severity_note', p.severity_note,
                  'report_count', p.report_count, 'reporter_count', p.reporter_count,
                  'first_report_id', p.first_report_id, 'is_first_report', p.first_report_id = r.id,
                  'counted', r.counted, 'merge_reason', r.merge_reason)
                FROM civic_problems p WHERE p.id = r.problem_id),
    'gov', jsonb_build_object(
      'status', r.gov_status,
      'department', r.gov_department,
      'severity_score', r.gov_severity_score::text,
      'feedback', r.gov_feedback,
      'internal_notes', r.gov_internal_notes,
      'updated_by', r.gov_updated_by,
      'updated_at', civic_iso(r.gov_updated_at),
      'status_history', civic_status_history(r)));
$$;

-- One issue as the public board shows it. Shared by public_issues() and lookup_issues()
-- so the list of public fields lives in one place. Category: the AI's, else the reporter's.
CREATE OR REPLACE FUNCTION civic_public_json(r civic_reports, distance_km double precision)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', r.id,
    'created_at', civic_iso(r.created_at),
    'updated_at', civic_iso(coalesce(r.gov_updated_at, r.created_at)),
    'status', r.gov_status,
    'status_history', civic_status_history(r),
    'category', coalesce(r.ai->>'category', r.category),
    'description', r.description,
    'location', jsonb_build_object('lat', r.lat, 'lng', r.lng, 'address', r.address),
    'photo_url', '/api/issues/' || r.id || '/photo',
    'report_count', coalesce((SELECT p.report_count FROM civic_problems p WHERE p.id = r.problem_id), 1),
    'distance_km', round(distance_km::numeric, 2));
$$;

CREATE OR REPLACE FUNCTION civic_distance_km(lat1 double precision, lng1 double precision,
                                             lat2 double precision, lng2 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT 2 * 6371 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- ---------- functions the servers call ----------

-- GET /api/issues. status_filter: 'all' | 'open' | 'closed' | one status.
-- With lat/lng: within radius_km, nearest first. Without: newest first.
-- One row per issue: reports merged into the same problem show once, as the problem's first
-- report, with report_count telling how many people reported it.
CREATE OR REPLACE FUNCTION public_issues(lat double precision DEFAULT NULL, lng double precision DEFAULT NULL,
                                         radius_km double precision DEFAULT 5, status_filter text DEFAULT 'all',
                                         max_rows integer DEFAULT 50)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH one AS (
    SELECT DISTINCT ON (coalesce(r.problem_id, r.id)) r
      FROM civic_reports r
     ORDER BY coalesce(r.problem_id, r.id), r.created_at, r.id
  ), f AS (
    SELECT one.r, CASE WHEN public_issues.lat IS NOT NULL AND public_issues.lng IS NOT NULL AND (one.r).lat IS NOT NULL
                   THEN civic_distance_km(public_issues.lat, public_issues.lng, (one.r).lat, (one.r).lng) END AS d
      FROM one
     WHERE CASE status_filter
             WHEN 'all' THEN true
             WHEN 'open' THEN (one.r).gov_status NOT IN ('resolved','rejected')
             WHEN 'closed' THEN (one.r).gov_status IN ('resolved','rejected')
             ELSE (one.r).gov_status = status_filter END
  )
  SELECT civic_public_json(f.r, f.d) FROM f
   WHERE public_issues.lat IS NULL OR public_issues.lng IS NULL OR f.d <= radius_km
   ORDER BY f.d ASC NULLS LAST, (f.r).created_at DESC
   LIMIT least(greatest(max_rows, 1), 200);
$$;

-- POST /api/issues/lookup ("Check my reports"). The caller must already know the email or
-- phone; only public fields come back, so contact details are never echoed.
CREATE OR REPLACE FUNCTION lookup_issues(contact text)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT civic_public_json(r, NULL) FROM civic_reports r
   WHERE (position('@' in contact) > 0 AND lower(r.contact_email) = lower(trim(contact)))
      OR (position('@' in contact) = 0 AND r.contact_phone = regexp_replace(contact, '[^0-9+]', '', 'g'))
   ORDER BY r.created_at DESC
   LIMIT 100;
$$;

-- Staff update of the gov fields. Only the keys present in `changes` are touched:
--   status, note (public, shown on the board; also becomes gov.feedback), department,
--   severity_score (0-100), internal_notes (staff only), updated_by.
-- A history entry is added when the status changes or a note is given.
-- Returns civic_report_json() of the updated row, or NULL if the id does not exist.
CREATE OR REPLACE FUNCTION set_report_gov(report_id text, changes jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r civic_reports;
  new_status text;
  note text;
  hist jsonb;
BEGIN
  SELECT * INTO r FROM civic_reports WHERE id = report_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  new_status := coalesce(nullif(changes->>'status', ''), r.gov_status);
  note := nullif(trim(changes->>'note'), '');
  hist := civic_status_history(r);
  IF new_status <> r.gov_status OR note IS NOT NULL THEN
    hist := hist || jsonb_build_array(jsonb_build_object('status', new_status, 'at', civic_iso(now()), 'note', note));
  END IF;

  UPDATE civic_reports SET
    gov_status         = new_status,
    status             = new_status,  -- legacy column, kept in step
    gov_status_history = hist,
    gov_feedback       = coalesce(note, gov_feedback),
    gov_department     = CASE WHEN changes ? 'department' THEN nullif(changes->>'department', '') ELSE gov_department END,
    gov_severity_score = CASE WHEN changes ? 'severity_score' THEN nullif(changes->>'severity_score', '')::integer ELSE gov_severity_score END,
    gov_internal_notes = CASE WHEN changes ? 'internal_notes' THEN nullif(trim(changes->>'internal_notes'), '') ELSE gov_internal_notes END,
    gov_updated_by     = coalesce(nullif(changes->>'updated_by', ''), gov_updated_by),
    gov_updated_at     = now()
  WHERE id = report_id
  RETURNING * INTO r;
  -- Keep the merged problem's open/closed flag in step, so closed issues stop collecting new reports.
  IF r.problem_id IS NOT NULL THEN
    UPDATE civic_problems p SET status = CASE WHEN EXISTS (
        SELECT 1 FROM civic_reports x WHERE x.problem_id = p.id AND x.gov_status NOT IN ('resolved','rejected'))
      THEN 'open' ELSE 'closed' END
    WHERE p.id = r.problem_id;
  END IF;
  RETURN civic_report_json(r);
END $$;

-- ---------- permissions ----------
-- Supabase grants EXECUTE on new functions to anon/authenticated by default, so revoke
-- explicitly. Only public_issues (public fields only) is callable with the anon key.
-- lookup_issues stays server-side so it can be rate-limited.
REVOKE ALL ON FUNCTION civic_report_json(civic_reports) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_issues(double precision, double precision, double precision, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION lookup_issues(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_report_gov(text, jsonb) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION civic_report_json(civic_reports) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION lookup_issues(text) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION set_report_gov(text, jsonb) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public_issues(double precision, double precision, double precision, text, integer) TO anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL;  -- plain Postgres without the Supabase roles
END $$;

-- ---------- documentation, visible in the Supabase table editor ----------
COMMENT ON TABLE civic_reports IS 'One civic issue report. API shape {id, client_report_id, created_at, user, ai, gov}: see civic_report_json() and schema/report.schema.json. RLS on, no policies: server access only.';
COMMENT ON COLUMN civic_reports.id IS 'R-<n> from civic_report_seq, starts at R-1001. Shown to the reporter.';
COMMENT ON COLUMN civic_reports.client_report_id IS 'UUID made on the device; unique, de-duplicates retries and offline re-sends. NULL for early reports.';
COMMENT ON COLUMN civic_reports.created_at IS 'Server receive time.';
COMMENT ON COLUMN civic_reports.status IS 'Legacy. Kept equal to gov_status by set_report_gov(); read gov_status instead.';
COMMENT ON COLUMN civic_reports.ai_summary IS 'Legacy, unused. The summary is ai->>''summary''.';
COMMENT ON COLUMN civic_reports.submitted_at IS 'user.submitted_at: when Send was tapped on the device.';
COMMENT ON COLUMN civic_reports.photo_path IS 'user.photo.path: object key in Storage bucket civic-reports, e.g. photos/R-1004.jpg.';
COMMENT ON COLUMN civic_reports.audio_path IS 'user.audio.path: optional voice note (<= 30 s) in bucket civic-reports, e.g. audio/R-1004.webm.';
COMMENT ON COLUMN civic_reports.audio_duration_s IS 'user.audio.duration_s, as measured on the device.';
COMMENT ON COLUMN civic_reports.description IS 'user.description, <= 500 chars. Shown on the public board.';
COMMENT ON COLUMN civic_reports.category IS 'user.category: the reporter''s pick (the current frontend sends none). The AI''s pick is ai->>''category''.';
COMMENT ON COLUMN civic_reports.lat IS 'user.location.lat. NULL when only an address was given.';
COMMENT ON COLUMN civic_reports.location_source IS 'user.location.source: gps | map | address.';
COMMENT ON COLUMN civic_reports.address IS 'user.location.address, <= 300 chars.';
COMMENT ON COLUMN civic_reports.contact_email IS 'user.contact.email. Private: never on the public board.';
COMMENT ON COLUMN civic_reports.contact_phone IS 'user.contact.phone, digits with optional +. Private.';
COMMENT ON COLUMN civic_reports.device_id IS 'user.meta.device_id: random per-browser id. Private.';
COMMENT ON COLUMN civic_reports.was_queued_offline IS 'user.meta.was_queued_offline: sent from the offline queue.';
COMMENT ON COLUMN civic_reports.ai IS 'Triage agent output (backend/agent.py), NULL until it finishes or if it fails: processed_at, model, taxonomy_version, valid, valid_checks{photo_shows_issue,in_service_area,in_scope}, valid_reason, evidence[], category, category_reason, department, department_reason, severity_score (0-100), severity_reason, summary.';
COMMENT ON COLUMN civic_reports.gov_status IS 'gov.status: received | in_review | assigned | in_progress | resolved | rejected.';
COMMENT ON COLUMN civic_reports.gov_department IS 'gov.department set by staff: public_works | parks_and_recreation | police | fire | health_and_inspections | other.';
COMMENT ON COLUMN civic_reports.gov_severity_score IS 'gov.severity_score 0-100 set by staff (string in the API).';
COMMENT ON COLUMN civic_reports.gov_feedback IS 'gov.feedback: latest public note to the reporter (shown on the board).';
COMMENT ON COLUMN civic_reports.gov_internal_notes IS 'gov.internal_notes: staff only, never public.';
COMMENT ON COLUMN civic_reports.gov_status_history IS 'gov.status_history: [{status, at, note}] oldest first; public. Empty until staff first update the report.';
COMMENT ON FUNCTION civic_report_json(civic_reports) IS 'Row -> full nested report {id, client_report_id, created_at, user, ai, gov}. Includes contact details.';
COMMENT ON FUNCTION public_issues(double precision, double precision, double precision, text, integer) IS 'Public issues board: public fields only, nearest first when lat/lng are given.';
COMMENT ON FUNCTION lookup_issues(text) IS 'Reports filed with this email or phone, public fields only.';
COMMENT ON FUNCTION set_report_gov(text, jsonb) IS 'Staff update of gov fields: {status, note, department, severity_score, internal_notes, updated_by}.';
COMMENT ON TABLE civic_problems IS 'One real-world issue; several reports of it share civic_reports.problem_id. Filled by backend/problems.py.';
COMMENT ON COLUMN civic_reports.problem_id IS 'civic_problems.id this report was merged into. NULL until the AI has run, or if the AI says the report is not valid.';
COMMENT ON COLUMN civic_reports.merge_reason IS 'Why it joined an existing problem (same photo / nearby same kind / AI photo match). NULL for the first report of a problem.';
COMMENT ON COLUMN civic_reports.photo_dhash IS 'Perceptual hash of the photo (16 hex), finds re-saved copies of the same photo.';
