require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SQL = `
CREATE TABLE IF NOT EXISTS cases (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  filename      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'processing',
  request_id    TEXT,
  check_url     TEXT,
  page_count    INTEGER,
  ocr_json      JSONB,
  ocr_markdown  TEXT,
  token_estimate INTEGER,
  gemini_file_name TEXT,
  gemini_store_name TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cases_status_idx ON cases (status);
CREATE INDEX IF NOT EXISTS cases_created_idx ON cases (created_at DESC);

-- Structured legal facts extracted by Datalab /api/v1/extract
ALTER TABLE cases ADD COLUMN IF NOT EXISTS facts JSONB;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS facts_status TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS extract_check_url TEXT;

-- Mapping of PDF page index -> printed page number visible in the doc
-- (extracted from Datalab PageHeader/PageFooter blocks)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS page_map JSONB;

-- Distinguish uploaded PDF case files from standalone research sessions
-- (no PDF — pure voice-based legal research, judgments still indexed
-- into the case's Gemini File Search store for later Speak access)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'document';
CREATE INDEX IF NOT EXISTS cases_kind_idx ON cases (kind);

-- Legal Research jobs — multi-turn scoping in voice, then IKAPI fetch +
-- index judgments into the case's existing Gemini File Search store.
CREATE TABLE IF NOT EXISTS research_jobs (
  id           BIGSERIAL PRIMARY KEY,
  case_id      BIGINT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  scope        JSONB,          -- { keywords, doctype, sections, years_back, ... }
  plan         TEXT,           -- agent's plan summary (what it'll fetch)
  status       TEXT NOT NULL DEFAULT 'scoping',
                                -- scoping | confirmed | running | done | failed
  judgments    JSONB,          -- [{tid,title,court,date,citation,indexed,error}]
  summary      TEXT,           -- final paragraph the agent will narrate
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS research_jobs_case_idx ON research_jobs (case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS research_jobs_status_idx ON research_jobs (status);

-- Unified conversation log. Voice and text BOTH append rows here.
-- Frontend renders the whole thread by case_id in chronological order.
--   role: 'user' | 'assistant' | 'tool'
--   content: plain spoken/typed text
--   meta:    { source: 'voice'|'text', tool?: {...}, research_job_id?: N }
CREATE TABLE IF NOT EXISTS conversation_messages (
  id          BIGSERIAL PRIMARY KEY,
  case_id     BIGINT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS conv_msgs_case_idx
  ON conversation_messages (case_id, created_at);
`;

(async () => {
  try {
    await pool.query(SQL);
    console.log('Migration complete.');
    process.exit(0);
  } catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
  }
})();
