-- Preserve the old group through a partially completed route cutover so its
-- pinned menu can be refreshed after a Worker interruption.
ALTER TABLE manager_group_flows ADD COLUMN source_group_id INTEGER;
