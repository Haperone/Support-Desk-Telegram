import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { digest, validateTimezone } from './bootstrap-state.mjs';

const CLI = '@tgcloud/cli@0.2.0';
export const identityProbe = `import { api } from 'sdk';
export default async function () {
  const me = await api.getMe();
  const result = { id: me.id, username: me.username };
  console.log('BOOTSTRAP_IDENTITY:' + JSON.stringify(result));
  return { inspected: true };
}
`;

export function parseIdentity(output) {
  let bot;
  try { bot = JSON.parse(output.match(/BOOTSTRAP_IDENTITY:(\{[^\r\n]*\})/)?.[1]); } catch { /* Safe message below. */ }
  if (!Number.isSafeInteger(bot?.id) || bot.id <= 0 || !/^[a-z0-9_]{5,32}$/i.test(bot.username || '')) {
    throw new Error('Telegram не подтвердил идентификатор алерт-бота. Публикация остановлена.');
  }
  return bot;
}

export function checkWebhook(bot, output, { requireActive = false } = {}) {
  // The SDK restricts getWebhookInfo; the supported CLI reads it outside the isolate.
  const url = output.match(/^\s*url:\s*(\S.*?)\s*$/m)?.[1];
  if (!url) throw new Error('Telegram CLI не подтвердил webhook. Подключение остановлено.');
  if (url !== `https://cloud.telegram.org/app${bot.id}/webhook` && !(url === '(none set)' && !requireActive)) {
    throw new Error('У бота другой webhook или webhook не подключён. Текущий адрес сохранён; проверьте выбранного бота.');
  }
}

export function renderStatusSettings(state, bot) {
  const adminId = Number(state.adminId), groupId = Number(state.groupId);
  if (!Number.isSafeInteger(adminId) || adminId <= 0 || !Number.isSafeInteger(groupId) || groupId >= 0
    || !Number.isSafeInteger(bot?.id) || bot.id < 0 || !/^[a-z0-9_]{5,32}$/i.test(bot.username || '')) {
    throw new Error('Не удалось подготовить права доступа новой установки.');
  }
  const timezone = validateTimezone(state.timezone || 'UTC');
  const locale = ['en', 'ru', 'es', 'zh'].includes(state.monitorLocale) ? state.monitorLocale : 'en';
  return `// Generated for this installation; no bot or CLI tokens are stored here.\n`
    + `export const ADMIN_IDS = [${adminId}];\nexport const ALERT_BOT_ID = ${bot.id};\n`
    + `export const ALERT_BOT_USERNAME = ${JSON.stringify(bot.username.toLowerCase())};\n`
    + `export const STATUS_GROUP_IDS = [${groupId}];\nexport const DISPLAY_TIMEZONE = ${JSON.stringify(timezone)};\n`
    + `export const STATUS_LOCALE = ${JSON.stringify(locale)};\n`;
}

export function prepareStatusProject(root, project, state, bot, save) {
  const source = join(root, 'alert-serverless');
  const paths = ['tgcloud/schema.js', 'tgcloud.jsonc', ...['lib', 'endpoints', 'handlers'].flatMap(folder =>
    readdirSync(join(source, 'tgcloud', folder)).filter(name => name.endsWith('.js')).map(name => `tgcloud/${folder}/${name}`))];
  for (const path of paths) {
    const content = path === 'tgcloud/lib/settings.js' ? renderStatusSettings(state, bot)
      : path === 'tgcloud.jsonc' ? '{}\n' : readFileSync(join(source, path), 'utf8');
    const target = join(project, path);
    const previous = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (previous !== null && previous !== content && state.serverlessFiles?.[path] !== digest(previous)) {
      throw new Error(`Файл статуса ${path} изменён вручную. Сохраните изменения перед повторной настройкой.`);
    }
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
    state.serverlessFiles = { ...state.serverlessFiles, [path]: digest(content) };
    save();
  }
}

export function checkServerlessTarget(state, bot, snapshotOutput) {
  if (bot.id === state.managerBotId || bot.username.toLowerCase() === state.managerUsername.toLowerCase()) {
    throw new Error('Это Админушка. Войдите через CLI Access отдельного алерт-бота.');
  }
  if (state.serverless?.botId && state.serverless.botId !== bot.id) throw new Error('CLI вошёл в другого алерт-бота. Верните доступ к боту этой установки.');
  const count = snapshotOutput.match(/\b(\d+) modules?\b/)?.[1];
  if (count === undefined) throw new Error('Не удалось проверить модули Telegram. Публикация остановлена.');
  if (Number(count) > 0 && !(state.serverless?.botId === bot.id && state.serverless.deployStarted === true)) {
    throw new Error('В Serverless этого бота уже есть программа. Мастер подключает пустое приложение либо продолжает собственную установку.');
  }
}

export async function setupServerlessStatus({ root, state, backupDir, save, ask, choose, child, npx, generatedSecret, log = console.log }) {
  const project = join(root, '.bootstrap-serverless', state.slug);
  log(`\nСтатус алерт-бота — Telegram Serverless\nВ @${state.managerUsername} откройте «Алерты» и подключите отдельного алерт-бота.\nВ BotFather включите Serverless для этого же алерт-бота и откройте CLI Access.\nИсходящие алерты идут из Cloudflare; /status работает в личке и выбранной группе. Проверки по расписанию здесь нет.`);
  await ask('Когда алерт-бот подключён и CLI Access готов, нажмите Enter');
  prepareStatusProject(root, project, state, { id: state.serverless?.botId || 0, username: state.serverless?.username || 'pending_bot' }, save);
  const runtime = npx();
  const run = (args, options = {}) => child(runtime.command, [...runtime.prefix, '--yes', '--package', CLI, 'tgcloud', ...args], { cwd: project, ...options });
  const probePath = join(project, 'tgcloud', 'endpoints', 'bootstrapIdentity.js');
  if (existsSync(probePath) && readFileSync(probePath, 'utf8') !== identityProbe) {
    throw new Error('Файл bootstrapIdentity.js уже существует и отличается от проверки мастера. Сохраните его перед продолжением.');
  }
  let bot;
  if (!existsSync(probePath)) writeFileSync(probePath, identityProbe, { flag: 'wx', encoding: 'utf8' });
  try {
    let output;
    try { output = await run(['run', 'endpoints/bootstrapIdentity', '{}']); }
    catch {
      log('Вставьте CLI Access token алерт-бота в запрос Telegram CLI.');
      await run(['login'], { inherit: true });
      output = await run(['run', 'endpoints/bootstrapIdentity', '{}']);
    }
    bot = parseIdentity(output);
  } finally { unlinkSync(probePath); }
  const snapshot = await run(['fetch']);
  checkServerlessTarget(state, bot, snapshot);
  checkWebhook(bot, await run(['webhook']));
  if (!await choose(`Подключить статус @${bot.username} к ${state.publicBaseUrl}? Доступ: пользователь ${state.adminId}, группа ${state.groupId}.`, [
    { label: 'Да, это мой алерт-бот', value: true }, { label: 'Отмена', value: false },
  ])) return;
  state.serverless = { ...state.serverless, botId: bot.id, username: bot.username, deployStarted: true };
  save();
  prepareStatusProject(root, project, state, bot, save);
  const monitorUrl = state.publicBaseUrl.replace(`https://${state.names.supportWorker}.`, `https://${state.names.monitorWorker}.`) + '/health/status';
  const token = await generatedSecret(state.config.monitor, 'STATUS_READ_TOKEN', join(backupDir, 'telegram-support-status-read-token.dpapi'));
  await run(['push', 'tgcloud/schema.js', 'tgcloud/lib/', 'tgcloud/endpoints/'], { inherit: true });
  await run(['migrate', '--safe'], { inherit: true });
  const ctx = JSON.stringify({ initData: { user: { id: Number(state.adminId) } } });
  // `run` echoes arguments; capture this output and never print it, including on failure.
  const result = await run(['run', 'endpoints/configureStatus', JSON.stringify({ monitorUrl, accessToken: token }), '--ctx', ctx]);
  if (!/configured:\s*true/.test(result)) throw new Error('Telegram не подтвердил настройку. Сохранённые ключи оставлены для повторной попытки.');
  const status = await run(['run', 'endpoints/getStatus', '{}', '--ctx', ctx]);
  if (!/\berror:\s*null/.test(status)) throw new Error('Статус пока не получил ответ Cloudflare. Проверьте монитор и повторите --status-bot; ключи сохраняются.');
  await run(['push', 'tgcloud/handlers/'], { inherit: true });
  checkWebhook(bot, await run(['webhook']), { requireActive: true });
  state.serverless.completedAt = new Date().toISOString();
  save();
  log(`Статус подключён. В личке @${bot.username} или группе отправьте /status@${bot.username}.\nПроект Telegram этой установки: ${project}`);
  if (/overall:\s*['"]degraded['"]/.test(status)) {
    log('Монитор отвечает, но пока сообщает неполные проверки или проблемы. Подробности — в /status; первая проверка Cron новой установки ещё могла не пройти.');
  }
}
