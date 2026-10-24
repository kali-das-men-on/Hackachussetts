-- Target table for when reports move from data/reports.jsonl into a real database.
-- Works on PostgreSQL; for SQLite swap TIMESTAMPTZ -> TEXT and DOUBLE PRECISION -> REAL.
-- Column names match the flattened JSON in schema/report.schema.json.

CREATE TABLE reports (
    id                  TEXT PRIMARY KEY,              -- "R-1001"
    client_report_id    TEXT NOT NULL UNIQUE,          -- de-dupes retries
    created_at          TIMESTAMPTZ NOT NULL,
    submitted_at        TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'received'
                        CHECK (status IN ('received','in_review','assigned','in_progress','resolved','rejected')),
    updated_at          TIMESTAMPTZ,                   -- last status change
    status_history      JSONB NOT NULL DEFAULT '[]',   -- [{status, at, note}], oldest first; TEXT on SQLite

    photo_path          TEXT NOT NULL,                 -- or an object-store key later
    photo_mime          TEXT NOT NULL,
    photo_bytes         INTEGER NOT NULL,

    audio_path          TEXT,                          -- optional voice note, NULL when none
    audio_mime          TEXT CHECK (audio_mime IN ('audio/webm','audio/mp4','audio/ogg','audio/mpeg','audio/wav')),
    audio_bytes         INTEGER,
    audio_duration_s    REAL CHECK (audio_duration_s BETWEEN 0 AND 30),

    lat                 DOUBLE PRECISION,
    lng                 DOUBLE PRECISION,
    accuracy_m          DOUBLE PRECISION,
    location_source     TEXT NOT NULL CHECK (location_source IN ('gps','map','address')),
    address             TEXT,

    description         VARCHAR(500),
    category            TEXT CHECK (category IN ('pothole','streetlight','trash','graffiti','sidewalk','other')),  -- NULL at intake; filled by AI from the description

    contact_email       VARCHAR(254),
    contact_phone       VARCHAR(32),

    device_id           TEXT,
    user_agent          TEXT,
    was_queued_offline  BOOLEAN NOT NULL DEFAULT FALSE,

    CHECK ((lat IS NOT NULL AND lng IS NOT NULL) OR address IS NOT NULL)
);

CREATE INDEX reports_created_at_idx ON reports (created_at DESC);
CREATE INDEX reports_status_idx     ON reports (status);
