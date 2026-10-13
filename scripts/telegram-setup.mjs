import { emitKeypressEvents } from 'node:readline';
import { pathToFileURL } from 'node:url';

export class SetupError extends Error {}

export function hiddenToken(prompt = 'Вставь токен бота поддержки и нажми Enter (ввод скрыт): ') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new SetupError('Запусти команду в обычном окне PowerShell, без перенаправления ввода или вывода.');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(prompt);
    const finish = (error) => {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
      value = '';
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new SetupError('Проверка отменена.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { value = value.slice(0, -1); return; }
      if (key.ctrl && key.name === 'u') { value = ''; return; }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    process.stdin.on('keypress', onKey);
  });
}

export async function request(token, method, body, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    let data;
    try { data = await response.json(); } catch { /* Report HTTP status without printing the body. */ }
    if (response.ok && data?.ok === true) return data.result;
    const code = Number.isInteger(data?.error_code) ? data.error_code : response.status;
    const explanations = {
      401: 'Telegram отклонил токен. Скопируй действующий токен выбранного бота у @BotFather.',
      404: 'Telegram не нашёл бота по этому токену. Проверь, что скопирован весь токен из @BotFather.',
      409: 'Конфликт подключения: бот уже получает обновления через webhook или другой запущенный процесс. Не отключай его вслепую.',
      429: 'Telegram временно ограничил запросы. Подожди и повтори проверку позже.',
    };
    // Never print response bodies, request URLs, raw errors or stacks: they may contain the token.
    throw new SetupError(`${method}: код ${code}. ${explanations[code] || 'Telegram вернул ошибку или некорректный ответ. Пришли эту строку для диагностики.'}`);
  } catch (error) {
    if (error instanceof SetupError) throw error;
    const code = error?.cause?.code || error?.code;
    if (error?.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
      throw new SetupError(`${method}: Telegram не ответил за 15 секунд. Проверь доступ к api.telegram.org с этого компьютера.`);
    }
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
      throw new SetupError(`${method}: не удалось найти api.telegram.org через DNS. Проверь подключение к интернету и настройки DNS.`);
    }
    if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(code)) {
      throw new SetupError(`${method}: ошибка проверки HTTPS-сертификата. Проверь дату компьютера и настройки антивируса или прокси; не отключай проверку сертификатов.`);
    }
    throw new SetupError(`${method}: не удалось подключиться к Telegram. Проверь интернет, ограничения сети, VPN или прокси. Работа приложения Telegram сама по себе не проверяет доступ терминала к Bot API.`);
  }
}

export async function checkTelegramSetup(token, { fetchImpl = fetch, log = console.log, table = console.table } = {}) {
  try {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
      throw new SetupError('Неверный формат токена. Нужна целая строка вида число:буквы_и_цифры из @BotFather, без кавычек, слова bot и пробелов.');
    }
    log('1/3 — проверяю токен и соединение с Telegram…');
    const me = await request(token, 'getMe', {}, fetchImpl);
    log(`Токен принят: @${me.username}. Убедись, что это нужный бот поддержки.`);
    log('2/3 — проверяю существующее подключение…');
    const hook = await request(token, 'getWebhookInfo', {}, fetchImpl);
    if (hook.url) {
      log('У этого бота уже есть webhook. Настройки сохранены, получение ID остановлено. Сообщи об этом, чтобы выбрать способ без отключения работающего бота.');
      return 'webhook';
    }
    log('3/3 — ищу сообщение /setup в группе…');
    // No offset: existing updates remain unconfirmed. Preserve allowed_updates as well.
    const updates = await request(token, 'getUpdates', { timeout: 0, limit: 100 }, fetchImpl);
    if (!Array.isArray(updates)) throw new SetupError('getUpdates: Telegram вернул неожиданный формат списка сообщений.');
    const messages = updates.map((update) => update.message).filter((message) =>
      message && /^\/setup(?:@\w+)?(?:\s|$)/i.test(message.text || '') && message.chat?.type === 'supergroup');
    if (!messages.length) {
      log('Сообщение /setup в группе с темами пока не найдено. Отправь /setup в General или /setup alerts в топик для предупреждений от своего аккаунта, проверь, что этот бот добавлен в группу, и повтори команду.');
      if (updates.length === 100) log('В очереди уже 100 или больше обновлений. Они сохранены; новые сообщения могут находиться дальше. Сообщи об этом для следующего шага.');
      return 'empty';
    }
    table(messages.map((message) => ({
      UserId: message.from?.id,
      Username: message.from?.username || '',
      GroupId: message.chat.id,
      GroupName: message.chat.title,
      ThreadId: message.message_thread_id ?? '',
      ForAlerts: /^\/setup(?:@\w+)?\s+alerts\s*$/i.test(message.text || ''),
      IsForum: message.chat.is_forum === true,
      SentAsChat: message.sender_chat?.id || '',
    })));
    log('Выбери своё сообщение в нужной группе. IsForum должен быть true, SentAsChat — пустым. UserId нужен для ADMIN_IDS, GroupId — для SUPPORT_GROUP_ID и ALERT_CHAT_ID.');
    log('Для отдельного топика алертов найди строку ForAlerts = true: её ThreadId нужен для ALERT_THREAD_ID. Если ThreadId пустой, отправь /setup alerts внутри нужного топика и повтори проверку.');
    return 'found';
  } catch (error) {
    log(error instanceof SetupError ? error.message : 'Неожиданная ошибка проверки. Сообщи, на каком из трёх шагов она возникла.');
    return 'error';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkTelegramSetup(await hiddenToken());
    if (result === 'error') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof SetupError ? error.message : 'Не удалось запустить ввод токена в этом терминале.');
    process.exitCode = 1;
  }
}
