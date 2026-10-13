import { WorkerEntrypoint } from 'cloudflare:workers';
import { storageSnapshot } from './storage-snapshot.js';
import { statisticsResourceSnapshot } from './statistics-snapshot.js';
import { flushUserAccessAlerts } from './user-access-alerts.js';
import { alertStatus, connectAlertBot, removeAlertBot, switchAlertRoute } from './alert-config.js';
export class StorageHealth extends WorkerEntrypoint {
  snapshot(options) { return storageSnapshot(this.env, { cursor: options?.cursor, locale: options?.locale }); }
  statistics(options) { return statisticsResourceSnapshot(this.env, options); }
}
export class UserAccessAlerts extends WorkerEntrypoint {
  flush() { return flushUserAccessAlerts(this.env); }
}
export class AlertSettings extends WorkerEntrypoint {
  status() { return alertStatus(this.env); }
  connect(options) { return connectAlertBot(this.env, options); }
  switch(options) { return switchAlertRoute(this.env, options); }
  remove(options) { return removeAlertBot(this.env, options); }
}
export { default } from './entry.js';
