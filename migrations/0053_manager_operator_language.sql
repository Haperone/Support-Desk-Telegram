CREATE TABLE manager_operator_preferences (
  operator_id INTEGER PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'en' CHECK(language IN ('en','ru','es','zh')),
  updated_at TEXT NOT NULL
);
