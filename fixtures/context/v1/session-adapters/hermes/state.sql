PRAGMA foreign_keys = OFF;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  user_id TEXT,
  model TEXT,
  model_config TEXT,
  system_prompt TEXT,
  parent_session_id TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  end_reason TEXT,
  message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  timestamp REAL NOT NULL,
  token_count INTEGER,
  finish_reason TEXT
);

INSERT INTO sessions (
  id, source, user_id, model, model_config, system_prompt,
  parent_session_id, started_at, ended_at, end_reason,
  message_count, tool_call_count, input_tokens, output_tokens
) VALUES
(
  'session-hermes-real-1',
  'cli',
  'fixture-user',
  'gemini-3.1-flash-lite-preview',
  '{}',
  'fixture system prompt',
  NULL,
  1772918441.825671,
  1772918443.383229,
  'completed',
  2,
  0,
  0,
  0
),
(
  'session-hermes-real-older',
  'cli',
  'fixture-user',
  'gemini-3.1-flash-lite-preview',
  '{}',
  'fixture old prompt',
  NULL,
  1772917800.0,
  1772917801.0,
  'completed',
  1,
  0,
  0,
  0
);

INSERT INTO messages (
  session_id, role, content, timestamp, token_count, finish_reason
) VALUES
('session-hermes-real-1', 'user', 'Respond with fixture-ok only.', 1772918442.06595, NULL, NULL),
('session-hermes-real-1', 'assistant', 'fixture-ok', 1772918443.39074, NULL, 'stop'),
('session-hermes-real-older', 'system', 'older', 1772917801.0, NULL, NULL);
