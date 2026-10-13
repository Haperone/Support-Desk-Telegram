-- Non-overlapping Cloudflare windows; overlapping polling must not inflate totals.
CREATE TABLE statistics_runtime_windows (
 script_name TEXT NOT NULL,window_start TEXT NOT NULL,requests INTEGER NOT NULL,
 exceptions INTEGER NOT NULL,resource_failures INTEGER NOT NULL,quality TEXT NOT NULL,
 PRIMARY KEY(script_name,window_start)
);
CREATE INDEX statistics_runtime_age ON statistics_runtime_windows(window_start);
INSERT INTO monitor_state(key,value) VALUES('statistics_runtime_count','0');
CREATE TRIGGER statistics_runtime_capacity BEFORE INSERT ON statistics_runtime_windows
WHEN NOT EXISTS(SELECT 1 FROM statistics_runtime_windows WHERE script_name=NEW.script_name AND window_start=NEW.window_start)
 AND (SELECT CAST(value AS INTEGER) FROM monitor_state WHERE key='statistics_runtime_count')>=50000 BEGIN
 SELECT RAISE(IGNORE);
END;
CREATE TRIGGER statistics_runtime_count_insert AFTER INSERT ON statistics_runtime_windows BEGIN
 UPDATE monitor_state SET value=CAST(value AS INTEGER)+1 WHERE key='statistics_runtime_count';
END;
CREATE TRIGGER statistics_runtime_count_delete AFTER DELETE ON statistics_runtime_windows BEGIN
 UPDATE monitor_state SET value=CAST(value AS INTEGER)-1 WHERE key='statistics_runtime_count';
END;
