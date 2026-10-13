-- Names are supplied by the user's own /start update, not by a third-party lookup.
ALTER TABLE manager_dm_status ADD COLUMN first_name TEXT;
ALTER TABLE manager_dm_status ADD COLUMN username TEXT;
