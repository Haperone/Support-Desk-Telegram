CREATE TABLE manager_work_navigation (
  operator_id INTEGER PRIMARY KEY,
  list_route TEXT NOT NULL,
  card_route TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
