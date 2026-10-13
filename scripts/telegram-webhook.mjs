import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BOT_UPDATES } from '../telegram-updates.js';
import { hiddenToken, request, SetupError } from './telegram-setup.mjs';

export function readWebhookConfig(text, botId) {
  const origin = text.match(/^PUBLIC_BASE_URL\s*=\s*"([^"\r\n]+)"/m)?.[1];
  let url;
  try { url = new URL(origin); } catch { throw new SetupError('Не заполнен PUBLIC_BASE_URL в wrangler.toml.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('replace')) {
    throw new SetupError('PUBLIC_BASE_URL должен быть полным HTTPS-адресом Worker без пути и параметров.');
  }
  if (botId === 'manager') {
    const username = text.match(/^MANAGER_BOT_USERNAME\s*=\s*"([^"\r\n]+)"/m)?.[1]?.replace(/^@/, '');
    if (!/^[a-z0-9_]{5,32}$/i.test(username || '')) throw new SetupError('Заполните MANAGER_BOT_USERNAME в wrangler.toml.');
    return { username, secretBinding: 'MANAGER_WEBHOOK_SECRET', url: `${url.origin}/tg/manager`, manager: true };
  }
  const registryText = text.match(/^BOT_REGISTRY\s*=\s*'''\s*\r?\n([\s\S]*?)^'''/m)?.[1];
  let registry;
  try { registry = JSON.parse(registryText); }
  catch { throw new SetupError('Не удалось прочитать BOT_REGISTRY из wrangler.toml. Проверь конфигурацию.'); }
  if (!Array.isArray(registry)) throw new SetupError('BOT_REGISTRY должен содержать список ботов.');
  const enabled = registry.filter((bot) => bot.enabled === true && (!botId || bot.id === botId));
  if (enabled.length !== 1) throw new SetupError('Укажи один включённый сервис: node scripts/telegram-webhook.mjs его-id');
  const bot = enabled[0];
  if (!/^[a-z0-9-]+$/.test(bot.id) || !/^[a-z0-9_]+$/i.test(bot.username) || bot.username.startsWith('REPLACE_')) {
    throw new SetupError('В BOT_REGISTRY не заполнены корректные id и username бота.');
  }
  return { username: bot.username, secretBinding: bot.webhookSecretBinding, url: `${url.origin}/tg/${bot.id}` };
}

export async function connectWebhook(config, token, secret, { fetchImpl = fetch, log = console.log } = {}) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new SetupError('Нужен полный токен выбранного бота из BotFather, содержащий двоеточие.');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new SetupError('Нужен тот же webhook secret, который сохранён в Wrangler, без пробелов и кавычек.');
  const me = await request(token, 'getMe', {}, fetchImpl);
  if (String(me?.username).toLowerCase() !== config.username.toLowerCase()) {
    throw new SetupError(`Введён токен другого бота. Нужен токен @${config.username}, указанного в настройках.`);
  }
  const previous = await request(token, 'getWebhookInfo', {}, fetchImpl);
  if (previous.url && previous.url !== config.url) {
    throw new SetupError('У этого бота уже настроен другой webhook. Подключение сохранено; сообщи об этом перед его заменой.');
  }
  log('Подключаю передачу сообщений Telegram к Worker…');
  const accepted = await request(token, 'setWebhook', {
    url: config.url, secret_token: secret,
    allowed_updates: BOT_UPDATES,
    drop_pending_updates: false,
  }, fetchImpl);
  if (accepted !== true) throw new SetupError('Telegram не подтвердил регистрацию webhook.');
  const current = await request(token, 'getWebhookInfo', {}, fetchImpl);
  if (current.url !== config.url) throw new SetupError('Адрес webhook после записи отличается от настроенного. Проверь, не перенастраивает ли бота другая программа.');
  log(`Webhook зарегистрирован: ${config.url}`);
  if (Number.isSafeInteger(current.pending_update_count)) log(`Сообщений в очереди Telegram: ${current.pending_update_count}`);
  if (current.last_error_date) log('Telegram хранит последнюю ошибку доставки. Проверь, приходят ли новые сообщения; при сбое сообщи об этом.');
  log(config.manager
    ? 'Теперь откройте личный чат управляющего бота и отправьте /start. Ответ подтвердит webhook и secret.'
    : 'Теперь отправь /selfcheck в General группы поддержки. Ответ бота подтвердит реальную доставку и правильность webhook secret.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readWebhookConfig(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'), process.argv[2]);
    console.log(`Подключение @${config.username} к ${config.url}`);
    const token = await hiddenToken(`1/2 — токен @${config.username} из BotFather (ввод скрыт): `);
    const secret = await hiddenToken(`2/2 — тот же webhook secret, который сохранён в ${config.secretBinding} (ввод скрыт): `);
    await connectWebhook(config, token, secret);
  } catch (error) {
    console.error(error instanceof SetupError ? error.message : 'Не удалось прочитать настройки подключения. Проверь wrangler.toml.');
    process.exitCode = 1;
  }
}
