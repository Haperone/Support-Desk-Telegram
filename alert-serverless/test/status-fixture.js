import { readFileSync } from 'node:fs';

// Test authorization and language must never depend on a real installation.
const moduleUrl = source => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
const settings = moduleUrl(`
export const ADMIN_IDS = [123456789];
export const ALERT_BOT_ID = 9876543210;
export const ALERT_BOT_USERNAME = 'example_alert_bot';
export const STATUS_GROUP_IDS = [-1001234567890];
export const DISPLAY_TIMEZONE = 'UTC';
export const STATUS_LOCALE = 'ru';
`);
const copySource = readFileSync(new URL('../tgcloud/lib/copy.js', import.meta.url), 'utf8');
const copy = moduleUrl(copySource.replace("'./settings.js'", JSON.stringify(settings)));
const statusSource = readFileSync(new URL('../tgcloud/lib/status.js', import.meta.url), 'utf8');
export const status = await import(moduleUrl(statusSource
  .replace("'./settings.js'", JSON.stringify(settings)).replace("'./copy.js'", JSON.stringify(copy))));
