import { table, integer, text } from 'sdk/db';

export const statusConfig = table('alert_status_config', {
  id: integer('id').primaryKey(),
  monitorUrl: text('monitor_url').notNull(),
  accessToken: text('access_token').notNull(),
});

export const statusCache = table('alert_status_cache', {
  id: integer('id').primaryKey(),
  snapshot: text('snapshot_json'),
  fetchedAt: text('fetched_at'),
  attemptedAt: text('attempted_at').notNull(),
  errorKind: text('error_kind'),
});
