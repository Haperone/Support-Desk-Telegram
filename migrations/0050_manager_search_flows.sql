-- A short-lived private search prompt; never a conversation or installation setting.
CREATE TABLE manager_search_flows (
  operator_id INTEGER PRIMARY KEY,
  expires_at TEXT NOT NULL
);
