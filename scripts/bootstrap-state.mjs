import { createHash } from 'node:crypto';

export const WRANGLER = '4.149.0';
export const ACCOUNT = /^[a-f0-9]{32}$/i;
export const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export const digest = value => createHash('sha256').update(value).digest('hex');

export function validateOrigin(value, worker) {
  let url;
  try { url = new URL(value); } catch { /* Report a safe, actionable error below. */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/'
    || url.search || url.hash || !new RegExp(`^${worker}\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.workers\\.dev$`).test(url.hostname)) {
    throw new Error(`Адрес должен иметь вид https://${worker}.ВАШ_СУБДОМЕН.workers.dev`);
  }
  return url.origin;
}

export function validateTimezone(value) {
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error('Укажите часовой пояс, например Europe/Budapest или UTC.'); }
}

export function validateBootstrapState(state, { slug, names, config }) {
  const fail = () => { throw new Error('Файл состояния установки повреждён или относится к другой папке. Восстановите его из резервной копии.'); };
  if (![1, 2].includes(state?.version) || state.slug !== slug || !ACCOUNT.test(state.accountId || '')
    || Object.entries(names).some(([key, value]) => state.names?.[key] !== value)
    || Object.entries(config).some(([key, value]) => state.config?.[key] !== value)
    || !Array.isArray(state.completed) || state.completed.some(value => typeof value !== 'string')
    || !/^-[1-9]\d+$/.test(state.groupId || '') || !Number.isSafeInteger(Number(state.groupId))
    || !/^[1-9]\d*$/.test(state.adminId || '') || !Number.isSafeInteger(Number(state.adminId))
    || !/^[a-z0-9_]{5,32}$/i.test(state.managerUsername || '')
    || !/^0x[A-Za-z0-9_-]{15,}$/.test(state.turnstileSiteKey || '')
    || !Number.isSafeInteger(state.rateNamespaceStart) || state.rateNamespaceStart < 1 || state.rateNamespaceStart > 900_000_000
    || ['supportDbId', 'monitorDbId'].some(key => state[key] && !UUID.test(state[key]))
    || state.supportDbId && state.supportDbId === state.monitorDbId
    || state.pendingDb && ![names.supportDb, names.monitorDb].includes(state.pendingDb)
    || state.monitorLocale && !['en', 'ru', 'es', 'zh'].includes(state.monitorLocale)
    || state.setupLocale !== undefined && !['en', 'ru'].includes(state.setupLocale)) fail();
  if (state.publicBaseUrl !== validateOrigin(state.publicBaseUrl, names.supportWorker)) fail();
  if (state.timezone) validateTimezone(state.timezone);
  if (state.managerBotId !== undefined && (!Number.isSafeInteger(state.managerBotId) || state.managerBotId <= 0)) fail();
  return state;
}

// A completed stage is reusable only for the exact input it successfully applied.
export async function runStage(state, name, fingerprint, action, save, log = console.log) {
  if (state.completed.includes(name) && state.stageFingerprints?.[name] === fingerprint) {
    log(`✓ ${name}: уже выполнено`);
    return;
  }
  log(`→ ${name}`);
  state.pendingStage = name;
  save();
  await action();
  if (!state.completed.includes(name)) state.completed.push(name);
  state.stageFingerprints = { ...state.stageFingerprints, [name]: fingerprint };
  state.pendingStage = null;
  save();
  log(`✓ ${name}`);
}

export function parseBootstrapArgs(args) {
  const flags = args.filter(value => value.startsWith('--'));
  const names = args.filter(value => !value.startsWith('--'));
  if (flags.some(value => !['--help', '--status-bot'].includes(value)) || names.length > 1) {
    throw new Error('Использование: node scripts/bootstrap.mjs [имя] [--status-bot]. Справка: --help.');
  }
  return { slug: names[0], help: flags.includes('--help'), statusBot: flags.includes('--status-bot') };
}
