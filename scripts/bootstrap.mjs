import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hiddenToken, request, SetupError } from './telegram-setup.mjs';
import { connectWebhook } from './telegram-webhook.mjs';
import { installationNames, renderBootstrapConfigs, newRateNamespaceStart, readD1List, findOwnDatabase } from './bootstrap-config.mjs';
import { probeManagerEndpoint, probeMonitorEndpoint } from './bootstrap-probe.mjs';
import { WRANGLER, UUID, ACCOUNT, digest, validateOrigin, validateTimezone, validateBootstrapState, runStage, parseBootstrapArgs } from './bootstrap-state.mjs';
import { discoverWorkersOrigin } from './bootstrap-cloudflare.mjs';
import { setupServerlessStatus } from './bootstrap-serverless.mjs';
import { BOOTSTRAP_HELP, createBootstrapText, selectBootstrapLanguage } from './bootstrap-copy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let resumeCommand;
let setupLocale;
let text = createBootstrapText('ru');
const log = value => console.log(text(value));
const askToken = prompt => hiddenToken(text(prompt));

function npx() {
  if (process.platform !== 'win32') return { command: 'npx', prefix: [] };
  const roots = [dirname(process.execPath), process.env.APPDATA && join(process.env.APPDATA, 'npm'),
    ...(process.env.PATH || '').split(';')].filter(Boolean);
  const cli = roots.map(root => join(root, 'node_modules', 'npm', 'bin', 'npx-cli.js')).find(existsSync);
  if (!cli) throw new Error('Не найден npm/bin/npx-cli.js. Установите Node.js вместе с npm.');
  return { command: process.execPath, prefix: [cli] };
}

function child(command, args, { input, inherit = false, missingWorker = false, cwd = ROOT } = {}) {
  return new Promise((done, reject) => {
    const proc = spawn(command, args, { cwd, windowsHide: true,
      stdio: [inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'] });
    let out = '';
    let err = '';
    if (!inherit) {
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', chunk => { out += chunk; });
      // Do not copy stderr: Wrangler and PowerShell may include sensitive input in errors.
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', chunk => { err += chunk; });
      if (input !== undefined) proc.stdin.end(input + '\n');
      else proc.stdin.end();
    }
    proc.on('error', () => reject(new Error(`Не удалось запустить ${command === process.execPath ? 'Node.js / npm' : 'Windows PowerShell'}. Проверьте установку программы.`)));
    proc.on('close', code => {
      if (code === 0) return done(out.trim());
      if (missingWorker && /code["']?\s*:\s*10007\b/.test(err + out)) return done(null);
      reject(new Error(`Команда завершилась с кодом ${code}. Текущий шаг сохранён; проверьте доступ к сервису и повторите показанную команду установки.`));
    });
  });
}

async function wrangler(args, options) {
  const { command, prefix } = npx();
  return child(command, [...prefix, '--yes', `wrangler@${WRANGLER}`, ...args], options);
}

function save(state, path) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

async function askRaw(prompt, fallback = '') {
  const io = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await io.question(`${prompt}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback; }
  finally { io.close(); }
}

const ask = (prompt, fallback) => askRaw(text(prompt), fallback);

async function requireAnswer(prompt, pattern, fallback = '') {
  while (true) {
    const answer = await ask(prompt, fallback);
    if (pattern.test(answer)) return answer;
    log('Значение не подходит. Исправьте ввод или нажмите Ctrl+C, чтобы выйти.');
  }
}

async function choose(prompt, options) {
  log(prompt);
  options.forEach((option, index) => log(`  ${index + 1}. ${option.translate === false ? option.label : text(option.label)}`));
  while (true) {
    const answer = await ask('Номер варианта', '1');
    if (/^[1-9]\d*$/.test(answer) && options[Number(answer) - 1]) return options[Number(answer) - 1].value;
    log('Выберите номер из списка.');
  }
}

async function validated(prompt, validate, fallback = '') {
  while (true) {
    try { return validate(await ask(prompt, fallback)); }
    catch (error) { log(error.message); }
  }
}

function parseJson(raw, title) {
  try { return JSON.parse(raw); }
  catch { throw new Error(`${text(title)}: Wrangler вернул некорректный JSON.`); }
}

function accountOptions(whoami) {
  const accounts = whoami?.accounts || whoami?.result?.accounts || [];
  return Array.isArray(accounts) ? accounts.filter(item => ACCOUNT.test(item?.id)) : [];
}

async function telegramSetup(token) {
  const me = await request(token, 'getMe', {});
  if (!/^[a-z0-9_]{5,32}$/i.test(me?.username || '')) throw new Error('Telegram не вернул корректный username управляющего бота.');
  const hook = await request(token, 'getWebhookInfo', {});
  if (hook.url) throw new Error('У управляющего бота уже есть webhook. Используйте нового бота для новой установки.');
  log(`Управляющий бот: @${me.username}. Добавьте его администратором группы с темами, затем отправьте от своего аккаунта /setup@${me.username} в General.`);
  while (true) {
    await ask('После отправки нажмите Enter');
    const updates = await request(token, 'getUpdates', { timeout: 0, limit: 100 });
    if (!Array.isArray(updates)) throw new Error('Telegram не вернул список обновлений.');
    const matches = updates.map(item => item.message).filter(message =>
      message?.text?.trim().toLowerCase() === `/setup@${me.username.toLowerCase()}`
      && message.chat?.type === 'supergroup' && message.chat?.is_forum === true
      && (!message.message_thread_id || message.message_thread_id === 1)
      && Number.isSafeInteger(message.from?.id) && !message.sender_chat);
    const message = matches.at(-1);
    if (!message) {
      log('Сообщение пока не найдено. Отправьте указанную команду в General от своего аккаунта (без анонимного режима администратора).');
      if (updates.length === 100) throw new Error('Очередь нового бота заполнена. Обновления сохранены; для установки используйте нового свободного бота.');
      continue;
    }
    const member = await request(token, 'getChatMember', { chat_id: message.chat.id, user_id: me.id });
    if (member?.status !== 'administrator' || !member.can_manage_topics || !member.can_pin_messages) {
      log('Выдайте Админушке права администратора на управление темами и закрепление сообщений.');
      continue;
    }
    log(`Группа: ${message.chat.title} (${message.chat.id}); администратор: ${message.from.id}.`);
    if (!await choose('Это верная группа и ваш аккаунт?', [
      { label: 'Да, продолжить', value: true }, { label: 'Нет, отправлю команду заново', value: false },
    ])) continue;
    return { managerUsername: me.username, managerBotId: me.id, groupId: String(message.chat.id), adminId: String(message.from.id) };
  }
}

async function d1List() { return readD1List(parseJson(await wrangler(['d1', 'list', '--json']), 'Список D1')); }

async function workerExists(name) {
  const output = await wrangler(['deployments', 'list', '--name', name, '--json', '--config', join(ROOT, 'wrangler.toml')], { missingWorker: true });
  if (output === null) return false;
  const value = parseJson(output, `Список deploy ${name}`);
  if (!Array.isArray(value) && !Array.isArray(value?.deployments)) throw new Error(`Неожиданный ответ о Worker ${name}.`);
  // Even a Worker with no deployments occupies the name. Only a 10007 proves absence.
  return true;
}

async function ensureDatabase(state, path, name, field) {
  let list = await d1List();
  const expected = state[field] || null;
  const found = expected ? findOwnDatabase(list, name, expected) : list.find(db => db.name === name);
  if (expected) {
    if (!found) throw new Error(`D1 ${name} с UUID из состояния отсутствует. Не создаём замену автоматически.`);
    return;
  }
  if (found && state.pendingDb !== name) throw new Error(`D1 ${name} уже существует. Мастер не присоединяет чужую базу.`);
  if (!found) {
    state.pendingDb = name;
    save(state, path);
    log(`Создаю пустую D1 ${name}…`);
    try { await wrangler(['d1', 'create', name]); }
    catch {
      // A lost response can still mean the database was created; inspect the account.
      list = await d1List();
      if (!list.some(db => db.name === name)) throw new Error(`Не удалось создать D1 ${name}. Проверьте Cloudflare и повторите запуск.`);
    }
  }
  list = await d1List();
  const created = list.find(db => db.name === name);
  if (!UUID.test(created?.uuid || '')) throw new Error(`D1 ${name} не появилась с корректным UUID.`);
  state[field] = created.uuid;
  state.pendingDb = null;
  save(state, path);
}

function configPaths(slug) {
  return { main: join(ROOT, `wrangler.bootstrap.${slug}.toml`),
    first: join(ROOT, `wrangler.bootstrap.${slug}.first.toml`),
    monitor: join(ROOT, 'monitor', `wrangler.bootstrap.${slug}.toml`) };
}

function writeConfig(path, content, state) {
  if (existsSync(path)) {
    const previous = readFileSync(path, 'utf8');
    if (previous !== content && state.configHashes?.[path] !== digest(previous)) {
      throw new Error(`Конфигурация ${path} изменена вручную или создана старым мастером. Автоматическая перезапись остановлена; сохраните файл для сверки.`);
    }
    if (previous !== content) writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  } else {
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  state.configHashes = { ...state.configHashes, [path]: digest(content) };
}

async function secretNames(config) {
  const value = parseJson(await wrangler(['secret', 'list', '--config', config]), 'Список секретов');
  if (!Array.isArray(value)) throw new Error('Wrangler вернул неожиданный список секретов.');
  return new Set(value.map(item => item.name));
}

async function ensureSecret(config, name, value) {
  if ((await secretNames(config)).has(name)) return false;
  if (!value) throw new Error(`Нужно значение для секрета ${name}.`);
  await wrangler(['secret', 'put', name, '--config', config], { input: value });
  if (!(await secretNames(config)).has(name)) throw new Error(`Секрет ${name} не появился после записи.`);
  return true;
}

async function protectedWebhookSecret(path, mode = 'CreateOrRead') {
  return child('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(ROOT, 'scripts', 'bootstrap-secret.ps1'), '-Mode', mode, '-Path', path]);
}

async function generatedSecret(config, name, path) {
  const exists = (await secretNames(config)).has(name);
  if (exists && !existsSync(path)) throw new Error(`${name} уже есть в Cloudflare, но его зашифрованная копия отсутствует. Восстановите резервную копию; ключ не заменён.`);
  const value = await protectedWebhookSecret(path, exists ? 'Read' : 'CreateOrRead');
  if (!exists) await ensureSecret(config, name, value);
  return value;
}

function migrationDigest(folder) {
  return digest(readdirSync(folder).filter(name => name.endsWith('.sql')).sort()
    .map(name => `${name}\n${readFileSync(join(folder, name), 'utf8')}`).join('\n'));
}

function sourceDigest() {
  // All Worker modules currently live in these two directories.
  return digest([ROOT, join(ROOT, 'monitor')].flatMap(folder => readdirSync(folder).filter(name => name.endsWith('.js')).sort()
    .map(name => `${folder === ROOT ? '' : 'monitor/'}${name}\n${readFileSync(join(folder, name), 'utf8')}`)).join('\n'));
}

async function main() {
  const interactive = process.platform === 'win32' && process.stdin.isTTY && process.stdout.isTTY;
  if (interactive && !process.argv.slice(2).includes('--help')) {
    setupLocale = await selectBootstrapLanguage({ ask: askRaw, log: console.log });
    text = createBootstrapText(setupLocale);
  }
  const args = parseBootstrapArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`${BOOTSTRAP_HELP}\n\n${createBootstrapText('en')(BOOTSTRAP_HELP)}`);
    return;
  }
  if (!interactive) {
    throw new Error('Мастер первого запуска работает в обычном окне PowerShell на Windows.');
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 13) throw new Error('Обновите Node.js до 22.13 или новее и повторите npm run setup.');
  await child('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major']);
  log('Freeflare Desk — установка\nПонадобятся новая Админушка, группа с темами и ключи Cloudflare.\nCtrl+C прерывает работу; созданные ресурсы сохраняются для продолжения.');
  let arg = args.slug;
  if (arg) installationNames(arg);
  const states = readdirSync(ROOT).filter(name => /^\.bootstrap-state-[a-z0-9-]+\.json$/.test(name));
  if (!arg && states.length) arg = await choose('Нашёл сохранённые установки:', [
    ...states.map(name => ({ label: `Открыть ${name.slice(17, -5)}`, value: name.slice(17, -5) })),
    { label: 'Создать новую установку', value: null },
  ]);
  if (!arg && args.statusBot) throw new Error('Для --status-bot выберите существующую установку.');
  const slug = arg || await validated('Имя новой установки (латиница, цифры, дефис)', value => {
    installationNames(value); return value;
  }, `support-${randomBytes(4).toString('hex')}`);
  const names = installationNames(slug);
  resumeCommand = `node scripts/bootstrap.mjs ${slug}${args.statusBot ? ' --status-bot' : ''}`;
  const path = join(ROOT, `.bootstrap-state-${slug}.json`);
  const config = configPaths(slug);
  let managerToken;
  let state = existsSync(path) ? parseJson(readFileSync(path, 'utf8'), 'Состояние установки') : null;
  if (state) validateBootstrapState(state, { slug, names, config });
  if (args.statusBot && !state?.completed.includes('Webhook Админушки')) throw new Error('Сначала завершите основную установку без --status-bot.');
  log(`Установка: ${slug}. Для повторного запуска: ${resumeCommand}`);
  log('Этот мастер создаёт отдельные Worker и D1. Работающую установку он не обновляет.');
  let whoami = parseJson(await wrangler(['whoami', '--json']), 'Проверка Cloudflare');
  if (whoami?.loggedIn !== true) {
    log('Войдите в Cloudflare в открывшемся браузере.');
    await wrangler(['login'], { inherit: true });
    whoami = parseJson(await wrangler(['whoami', '--json']), 'Проверка входа');
    if (whoami?.loggedIn !== true) throw new Error('Вход не завершён. Повторите npm run setup.');
  }
  const accounts = accountOptions(whoami);
  if (!accounts.length) throw new Error('Wrangler не показал доступных Cloudflare аккаунтов. Проверьте права входа.');
  if (!state) {
    const accountId = accounts.length === 1 ? accounts[0].id : await choose('Выберите аккаунт Cloudflare:',
      accounts.map(item => ({ label: `${item.name || text('Без названия')} (${item.id})`, value: item.id, translate: false })));
    log(`Аккаунт Cloudflare: ${accounts.find(item => item.id === accountId).name || accountId}`);
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
    managerToken = await askToken('Токен новой Админушки из BotFather (ввод скрыт): ');
    const telegram = await telegramSetup(managerToken);
    let publicBaseUrl;
    try {
      const credentials = parseJson(await wrangler(['auth', 'token', '--json']), 'Проверка авторизации');
      publicBaseUrl = await discoverWorkersOrigin(accountId, names.supportWorker, credentials);
    } catch { /* Public URL can be entered without extracting CLI credentials. */ }
    if (!publicBaseUrl) {
      log(`Не удалось определить workers.dev. Найдите или создайте его: https://dash.cloudflare.com/${accountId}/workers-and-pages`);
      publicBaseUrl = await validated(`Полный будущий адрес https://${names.supportWorker}.ВАШ_СУБДОМЕН.workers.dev`, value => validateOrigin(value, names.supportWorker));
    }
    log(`Адрес вашей установки: ${publicBaseUrl}`);
    log(`Создайте Turnstile → Managed для hostname ${new URL(publicBaseUrl).hostname}: https://dash.cloudflare.com/${accountId}/turnstile`);
    const turnstileSiteKey = await requireAnswer('Публичный Turnstile site key для этого hostname', /^0x[A-Za-z0-9_-]{15,}$/);
    const timezone = await validated('Часовой пояс для алертов', validateTimezone, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const languageNames = { ru: 'Русский', en: 'English', es: 'Español', zh: '简体中文' };
    const monitorLocale = await choose('Язык алертов:', [setupLocale, ...Object.keys(languageNames).filter(value => value !== setupLocale)]
      .map(value => ({ value, label: languageNames[value] })));
    state = { version: 2, slug, names, accountId, config, ...telegram, publicBaseUrl, timezone, monitorLocale, setupLocale,
      turnstileSiteKey, rateNamespaceStart: newRateNamespaceStart(), completed: [], pendingDb: null };
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
    const current = await d1List();
    for (const name of [names.supportDb, names.monitorDb]) {
      if (current.some(db => db.name === name)) throw new Error(`D1 ${name} уже есть. Выберите новое имя установки.`);
    }
    for (const name of [names.supportWorker, names.monitorWorker]) {
      if (await workerExists(name)) throw new Error(`Worker ${name} уже существует. Выберите другое имя установки.`);
    }
    log(`Будут созданы две БД: ${names.supportDb}, ${names.monitorDb}; два Worker: ${names.supportWorker}, ${names.monitorWorker}.\nГруппа: ${state.groupId}; Админушка: @${state.managerUsername}; время: ${timezone}.`);
    if ((await ask('Для создания ресурсов напишите СОЗДАТЬ')).toUpperCase() !== text('СОЗДАТЬ')) throw new Error('Установка отменена до изменений в Cloudflare.');
    save(state, path);
  } else {
    if (accounts.length && !accounts.some(item => item.id === state.accountId)) throw new Error('Текущий Wrangler вошёл в другой Cloudflare аккаунт.');
    log('Продолжаю ранее начатую установку по локальному файлу состояния.');
  }
  state.setupLocale = setupLocale;
  save(state, path);
  process.env.CLOUDFLARE_ACCOUNT_ID = state.accountId;
  const backupDir = join(process.env.USERPROFILE, '.codex', 'backups', 'telegram-support', slug);
  const offerStatus = async () => {
    if (!args.statusBot && !await choose('Подключить статус /status в алерт-боте на Telegram Serverless?', [
      { label: 'Позже — завершить установку', value: false }, { label: 'Подключить сейчас', value: true },
    ])) {
      log(`Позже: node scripts/bootstrap.mjs ${slug} --status-bot`);
      return;
    }
    resumeCommand = `node scripts/bootstrap.mjs ${slug} --status-bot`;
    await setupServerlessStatus({ root: ROOT, state, backupDir, save: () => save(state, path), ask, choose,
      child, npx, generatedSecret, log });
  };
  if (args.statusBot || state.completedAt) {
    log(`Основная установка уже завершена: ${state.publicBaseUrl}. Сервисы добавляются через Админушку.`);
    await offerStatus();
    return;
  }
  // Check identity before resuming any resource mutation.
  if (!managerToken) managerToken = await askToken(`Токен @${state.managerUsername} для продолжения (ввод скрыт): `);
  const me = await request(managerToken, 'getMe', {});
  if (String(me?.username).toLowerCase() !== state.managerUsername.toLowerCase()
    || state.managerBotId && me.id !== state.managerBotId) throw new Error('Токен принадлежит другой Админушке.');
  const priorHook = await request(managerToken, 'getWebhookInfo', {});
  if (priorHook.url && priorHook.url !== `${state.publicBaseUrl}/tg/manager`) throw new Error('Админушка уже подключена к другому адресу. Её настройки сохранены.');
  state.managerBotId = me.id;
  if (!state.workersChecked) {
    for (const name of [names.supportWorker, names.monitorWorker]) {
      if (await workerExists(name)) throw new Error(`Worker ${name} уже существует в аккаунте. Мастер не перезапишет его.`);
    }
    state.workersChecked = true;
    save(state, path);
  }
  await ensureDatabase(state, path, names.supportDb, 'supportDbId');
  await ensureDatabase(state, path, names.monitorDb, 'monitorDbId');
  const templates = [readFileSync(join(ROOT, 'wrangler.toml'), 'utf8'), readFileSync(join(ROOT, 'monitor', 'wrangler.toml'), 'utf8')];
  const generated = renderBootstrapConfigs(...templates, state);
  writeConfig(config.main, generated.main, state);
  writeConfig(config.first, generated.firstMain, state);
  writeConfig(config.monitor, generated.monitor, state);
  save(state, path);
  const stage = (name, fingerprint, action) => runStage(state, name, fingerprint, action, () => save(state, path), log);
  const code = sourceDigest();
  await stage('Миграции основной D1', migrationDigest(join(ROOT, 'migrations')), () => wrangler(['d1', 'migrations', 'apply', names.supportDb, '--remote', '--config', config.main], { inherit: true }));
  await stage('Миграции D1 монитора', migrationDigest(join(ROOT, 'monitor', 'migrations')), () => wrangler(['d1', 'migrations', 'apply', names.monitorDb, '--remote', '--config', config.monitor], { inherit: true }));
  if (!state.completed.includes('Основной Worker с monitor bindings')) await stage('Первый deploy основного Worker', digest(code + generated.firstMain), () => wrangler(['deploy', '--config', config.first], { inherit: true }));
  const mainSecretConfig = state.completed.includes('Основной Worker с monitor bindings') ? config.main : config.first;
  // Telegram can rotate a token mid-install; the encrypted Worker binding must follow the validated token.
  await wrangler(['secret', 'put', 'MANAGER_BOT_TOKEN', '--config', mainSecretConfig], { input: managerToken });
  if (!(await secretNames(mainSecretConfig)).has('MANAGER_BOT_TOKEN')) throw new Error('Токен Админушки не появился в Cloudflare.');
  const webhookBackup = join(backupDir, 'manager-webhook-secret.dpapi');
  const webhookSecret = await generatedSecret(mainSecretConfig, 'MANAGER_WEBHOOK_SECRET', webhookBackup);
  if (!(await secretNames(mainSecretConfig)).has('TURNSTILE_SECRET_KEY')) {
    const turnstileSecret = await askToken('Turnstile secret key (ввод скрыт): ');
    await ensureSecret(mainSecretConfig, 'TURNSTILE_SECRET_KEY', turnstileSecret);
  }
  await generatedSecret(mainSecretConfig, 'BOT_REGISTRY_KEY', join(backupDir, `${names.supportWorker}-registry-key.dpapi`));
  await stage('Deploy Worker монитора', digest(code + generated.monitor), () => wrangler(['deploy', '--config', config.monitor], { inherit: true }));
  if (!(await secretNames(config.monitor)).has('CF_ANALYTICS_TOKEN')) {
    log(`Создайте API token с правами аналитики по инструкции monitor/README.md: https://dash.cloudflare.com/profile/api-tokens`);
    const analyticsToken = await askToken('Cloudflare API token для аналитики монитора (ввод скрыт): ');
    await ensureSecret(config.monitor, 'CF_ANALYTICS_TOKEN', analyticsToken);
  }
  await generatedSecret(config.monitor, 'ALERT_CONFIG_KEY', join(backupDir, 'telegram-support-alert-config-key.dpapi'));
  const statusSecret = await generatedSecret(config.monitor, 'STATUS_READ_TOKEN', join(backupDir, 'telegram-support-status-read-token.dpapi'));
  await stage('Основной Worker с monitor bindings', digest(code + generated.main), () => wrangler(['deploy', '--config', config.main], { inherit: true }));
  await probeManagerEndpoint(state.publicBaseUrl, webhookSecret);
  await probeMonitorEndpoint(state.publicBaseUrl.replace(`https://${names.supportWorker}.`, `https://${names.monitorWorker}.`), statusSecret);
  log('✓ Основной Worker, монитор и чтение обеих БД проверены.');
  await stage('Webhook Админушки', digest(state.publicBaseUrl + webhookSecret), async () => {
    if (!managerToken) managerToken = await askToken('Токен Админушки для webhook (ввод скрыт): ');
    await connectWebhook({ username: state.managerUsername, url: `${state.publicBaseUrl}/tg/manager`, manager: true },
      managerToken, webhookSecret, { log });
  });
  if (!managerToken) managerToken = await askToken('Токен Админушки для финальной проверки webhook (ввод скрыт): ');
  const currentBot = await request(managerToken, 'getMe', {});
  if (String(currentBot?.username).toLowerCase() !== state.managerUsername.toLowerCase()) {
    throw new Error('Финальная проверка токена Админушки не прошла.');
  }
  let currentHook = await request(managerToken, 'getWebhookInfo', {});
  if (!currentHook?.url) {
    await connectWebhook({ username: state.managerUsername, url: `${state.publicBaseUrl}/tg/manager`, manager: true },
      managerToken, webhookSecret, { log });
    currentHook = await request(managerToken, 'getWebhookInfo', {});
  }
  if (currentHook?.url !== `${state.publicBaseUrl}/tg/manager`) throw new Error('Финальная проверка webhook Админушки не прошла.');
  if (!(await workerExists(names.supportWorker)) || !(await workerExists(names.monitorWorker))) {
    throw new Error('Один из Worker не найден после публикации. Проверьте Cloudflare и повторите запуск.');
  }
  state.version = 2;
  state.completedAt = new Date().toISOString();
  save(state, path);
  log(`\nГотово: две D1, оба Worker, секреты и webhook Админушки @${state.managerUsername}.`);
  log(`Публичный адрес: ${state.publicBaseUrl}.`);
  log('Откройте личку Админушки и отправьте /start. Ответ подтвердит живую доставку webhook.');
  log('Затем через «Управление ботами поддержки → Добавить сервисного бота» подключите первый сервис.');
  log('Алерт-бот подключается отдельно через меню «Алерты». Контрольный обмен с клиентом остаётся на проверке в меню Админушки.');
  log(`Файлы этой установки: ${config.main}, ${config.monitor}; зашифрованные резервные копии: ${backupDir}.`);
  await offerStatus();
}

main().catch(error => {
  // Do not print stacks or raw child errors: Telegram and Wrangler URLs can contain credentials.
  const message = error instanceof SetupError || error instanceof Error ? error.message : 'Установка остановлена. Повторите запуск после устранения проблемы.';
  console.error(setupLocale ? text(message) : `${message}\n${createBootstrapText('en')(message)}`);
  if (resumeCommand) console.error(text(`Продолжить: ${resumeCommand}`));
  process.exitCode = 1;
});
