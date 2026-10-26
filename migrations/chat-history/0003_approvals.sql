-- Human-in-the-loop approvals for MCP writes (src/lib/approvals.ts).
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  conversation_id TEXT,
  server_id       TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  args_json       TEXT NOT NULL,
  code_mode       INTEGER NOT NULL DEFAULT 0,
  risk            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  writes_json     TEXT NOT NULL,
  status          TEXT NOT NULL,
  workflow_id     TEXT,
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER,
  decided_by      TEXT,
  executed_at     INTEGER,
  result_json     TEXT,
  error           TEXT,
  events_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_email_created ON approvals (email, created_at DESC);
