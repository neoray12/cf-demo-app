-- Main chat history index. Full turn records live in R2 (HISTORY_BUCKET);
-- D1 holds what the history list, search and stats need.

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  title         TEXT NOT NULL,
  model         TEXT,
  provider      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  turn_count    INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  last_status   TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversations_email_updated ON conversations (email, updated_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  conversation_id  TEXT NOT NULL,
  turn_index       INTEGER NOT NULL,
  email            TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER NOT NULL,
  duration_ms      INTEGER NOT NULL,
  ttft_ms          INTEGER,
  status           TEXT NOT NULL,
  model            TEXT,
  provider         TEXT,
  compat_model     TEXT,
  routed_model     TEXT,
  finish_reason    TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  reasoning_tokens INTEGER,
  tool_calls       INTEGER NOT NULL DEFAULT 0,
  tool_names       TEXT,
  error_type       TEXT,
  user_text        TEXT,
  assistant_text   TEXT,
  r2_key           TEXT NOT NULL,
  PRIMARY KEY (conversation_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_turns_email ON turns (email, started_at DESC);
