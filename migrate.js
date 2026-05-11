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
