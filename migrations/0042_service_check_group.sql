-- Controlled exchanges are tied to the destination used when the check started.
ALTER TABLE service_checks ADD COLUMN group_id INTEGER;
CREATE INDEX service_checks_destination ON service_checks(bot_id,group_id,stage);
