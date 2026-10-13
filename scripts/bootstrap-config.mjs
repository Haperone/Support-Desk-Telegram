import { randomInt } from 'node:crypto';

export function installationNames(slug) {
  if (!/^[a-z][a-z0-9-]{4,38}[a-z0-9]$/.test(slug) || slug.includes('--')) {
    throw new Error('Имя установки: 6–40 строчных латинских букв, цифр и дефисов; начните с буквы.');
  }
  return { supportWorker: slug, monitorWorker: `${slug}-monitor`,
    supportDb: `${slug}-support`, monitorDb: `${slug}-monitor` };
}

function line(text, key, value) {
  const pattern = new RegExp(`^${key}\\s*=\\s*.*$`, 'm');
  if (!pattern.test(text)) throw new Error(`Нет параметра ${key} в шаблоне конфигурации.`);
  return text.replace(pattern, `${key} = ${JSON.stringify(String(value))}`);
}

function accountConfig(text, accountId) {
  return /^account_id\s*=/m.test(text) ? line(text, 'account_id', accountId)
    : text.replace(/^name = .*$/m, match => `${match}\naccount_id = ${JSON.stringify(accountId)}`);
}

function serviceTarget(text, oldName, name) {
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^service = "${escaped}"$`, 'gm'), `service = ${JSON.stringify(name)}`);
}

function changeDatabase(text, binding, name, id) {
  const pattern = new RegExp(`(\\[\\[d1_databases\\]\\]\\s*\\r?\\nbinding = "${binding}"\\s*\\r?\\n)database_name = "[^"]+"\\s*\\r?\\ndatabase_id = "[^"]+"`);
  if (!pattern.test(text)) throw new Error(`Не найдена D1 binding ${binding} в шаблоне.`);
  return text.replace(pattern, `$1database_name = ${JSON.stringify(name)}\ndatabase_id = ${JSON.stringify(id)}`);
}

export function renderBootstrapConfigs(mainTemplate, monitorTemplate, input) {
  const { names, accountId, supportDbId, monitorDbId, groupId, adminId,
    managerUsername, publicBaseUrl, turnstileSiteKey, rateNamespaceStart } = input;
  const originalMain = mainTemplate.match(/^name\s*=\s*"([a-z0-9-]+)"/m)?.[1];
  const originalMonitor = monitorTemplate.match(/^name\s*=\s*"([a-z0-9-]+)"/m)?.[1];
  if (!originalMain || !originalMonitor) throw new Error('Не найдены имена Worker в шаблонах.');
  let main = line(mainTemplate, 'name', names.supportWorker);
  main = accountConfig(main, accountId);
  for (const [key, value] of Object.entries({ SUPPORT_GROUP_ID: groupId, ADMIN_IDS: adminId,
    MANAGER_BOT_USERNAME: managerUsername, PUBLIC_BASE_URL: publicBaseUrl,
    TURNSTILE_SITE_KEY: turnstileSiteKey, BOT_REGISTRY: '[]' })) main = line(main, key, value);
  main = changeDatabase(main, 'SUPPORT_DB', names.supportDb, supportDbId);
  let namespace = rateNamespaceStart;
  main = main.replace(/^namespace_id = "\d+"$/gm, () => `namespace_id = "${namespace++}"`);
  if (namespace !== rateNamespaceStart + 5) throw new Error('Не найдены все пять rate limit namespaces.');
  const serviceBlocks = [...main.matchAll(/\[\[services\]\]\s*\r?\n(?:[^\[]*)/g)];
  if (serviceBlocks.length !== 3) throw new Error('Не найдены три monitor service bindings.');
  main = serviceTarget(main, originalMonitor, names.monitorWorker);
  const firstMain = main.replace(/\[\[services\]\]\s*\r?\n(?:[^\[]*)/g, '').trimEnd() + '\n';
  let monitor = line(monitorTemplate, 'name', names.monitorWorker);
  monitor = accountConfig(monitor, accountId);
  for (const [key, value] of Object.entries({ CF_ACCOUNT_ID: accountId, ALERT_CHAT_ID: '', ALERT_THREAD_ID: '',
    DISPLAY_TIMEZONE: input.timezone || 'UTC', MONITOR_LOCALE: input.monitorLocale || 'en',
    RUNTIME_SCRIPT_NAMES: JSON.stringify([names.supportWorker, names.monitorWorker]) })) monitor = line(monitor, key, value);
  monitor = changeDatabase(monitor, 'MONITOR_DB', names.monitorDb, monitorDbId);
  monitor = serviceTarget(monitor, originalMain, names.supportWorker);
  return { main, firstMain, monitor };
}

export function newRateNamespaceStart() { return randomInt(100_000, 900_000_000); }

export function readD1List(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.result) ? value.result : value?.databases;
  if (!Array.isArray(list)) throw new Error('Wrangler вернул неожиданный список D1.');
  return list;
}

export function findOwnDatabase(databases, name, expectedId = null) {
  const found = databases.filter(db => db.name === name);
  if (found.length > 1 || (found.length && expectedId && found[0].uuid !== expectedId)) {
    throw new Error(`D1 ${name}: найден конфликт имени или UUID; установка остановлена.`);
  }
  if (found.length && !expectedId) throw new Error(`D1 ${name} уже существует без записи UUID в состоянии установки; ручная проверка обязательна.`);
  return found[0] || null;
}
