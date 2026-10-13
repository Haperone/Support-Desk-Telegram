export const REACTION_DIRECTIONS = Object.freeze(['support_to_user', 'user_to_support']);
const reactionLanguage = value => value === true ? 'ru' : value === false ? 'en' : ['en','ru','es','zh'].includes(value) ? value : 'en';
const reactionCopy = {
  en: { support:'Support → user', user:'User → support', onVerified:'🟢 enabled, verified', onUnverified:'🟢 enabled, not verified', offVerified:'verified, disabled', offUnverified:'disabled, not verified' },
  ru: { support:'Поддержка → пользователь', user:'Пользователь → поддержка', onVerified:'🟢 включено, проверено', onUnverified:'🟢 включено, не проверено', offVerified:'проверено, выключено', offUnverified:'выключено, не проверено' },
  es: { support:'Soporte → usuario', user:'Usuario → soporte', onVerified:'🟢 activado y verificado', onUnverified:'🟢 activado, sin verificar', offVerified:'verificado, desactivado', offUnverified:'desactivado, sin verificar' },
  zh: { support:'支持人员 → 用户', user:'用户 → 支持人员', onVerified:'🟢 已启用并验证', onUnverified:'🟢 已启用，未验证', offVerified:'已验证，未启用', offUnverified:'未启用，未验证' },
};
const reactionExtra = {
  es: {
    'Reaction check':'Comprobación de reacciones', 'verified (3/3)':'verificado (3/3)',
    'Telegram did not confirm the mirror. Remove your reaction and repeat the requested step.':'Telegram no confirmó la sincronización. Quite su reacción y repita el paso indicado.',
    'not confirmed':'sin confirmar', 'waiting for your action and a Telegram event':'esperando su acción y un evento de Telegram',
    'Open the private chat below and press Start. This link is valid for 20 minutes and only for the primary administrator.':'Abra el chat privado y pulse Iniciar. El enlace dura 20 minutos y solo sirve al administrador principal.',
    'Open bot for check':'Abrir bot para comprobar',
    'Add 👍, replace it with 👀, then remove it on both test messages. Wait for the prompt on each message to update after every step.':'Añada 👍, cámbiela por 👀 y quítela en ambos mensajes de prueba. Espere a que se actualicen las instrucciones después de cada paso.',
    'General test':'Prueba en General', 'Private chat test':'Prueba en chat privado',
    'This direction is verified. Both directions turn on automatically when the check is complete.':'Esta dirección está verificada. Ambas se activarán automáticamente al finalizar la comprobación.',
    'On THIS test message, ':'En ESTE mensaje de prueba, ', 'add 👍.':'añada 👍.',
    'replace your reaction with 👀.':'cambie su reacción por 👀.', 'remove your reaction.':'quite su reacción.',
    'Wait for this text to update after each step. Then check the other direction in the other chat.':'Espere a que se actualice este texto tras cada paso. Después compruebe la otra dirección en el otro chat.',
    'If your reaction is set but progress has not changed, its event has not arrived. Press Refresh result. You can close the check and enable only the confirmed direction.':'Si la reacción aparece pero no avanza, aún no llegó su evento. Pulse Actualizar resultado. Puede cerrar la comprobación y activar solo la dirección confirmada.',
    'Enable verified directions':'Activar direcciones verificadas',
    'Both directions turn on automatically after the check. Normal messaging continues to work.':'Ambas direcciones se activan automáticamente al terminar. La conversación normal sigue funcionando.',
    'Preparing the reaction check…':'Preparando la comprobación de reacciones…',
    'in the manager bot → service → Reactions':'en el bot administrador → servicio → Reacciones',
    'in General → Reactions':'en General → Reacciones',
    'The check has ended. Unconfirmed directions stay disabled. Start a new check in the manager bot → service → Reactions.':'La comprobación terminó. Las direcciones no confirmadas siguen desactivadas. Inicie otra en el bot administrador → servicio → Reacciones.',
    'The check has ended. Unconfirmed directions stay disabled. Start a new check in General → Reactions.':'La comprobación terminó. Las direcciones no confirmadas siguen desactivadas. Inicie otra en General → Reacciones.',
    'Test message preparation did not complete. Close this check and start a new one in the manager bot → service → Reactions.':'No se prepararon los mensajes de prueba. Cierre esta comprobación e inicie otra en el bot administrador → servicio → Reacciones.',
    'Test message preparation did not complete. Close this check and start a new one in General → Reactions.':'No se prepararon los mensajes de prueba. Cierre esta comprobación e inicie otra en General → Reacciones.',
    'This check link is stale. Start a check in the manager bot → service → Reactions.':'Este enlace ha caducado. Inicie una comprobación en el bot administrador → servicio → Reacciones.',
    'This check link is stale. Start a check in General → Reactions.':'Este enlace ha caducado. Inicie una comprobación en General → Reacciones.',
    'This reaction check button is unavailable.':'Este botón de comprobación de reacciones no está disponible.',
  },
  zh: {
    'Reaction check':'表情反应检查', 'verified (3/3)':'已验证 (3/3)',
    'Telegram did not confirm the mirror. Remove your reaction and repeat the requested step.':'Telegram 未确认同步。请移除表情反应并重复指定步骤。',
    'not confirmed':'未确认', 'waiting for your action and a Telegram event':'等待您的操作和 Telegram 事件',
    'Open the private chat below and press Start. This link is valid for 20 minutes and only for the primary administrator.':'打开下方私人聊天并点击“开始”。链接仅供主管理员使用，有效期 20 分钟。',
    'Open bot for check':'打开机器人进行检查',
    'Add 👍, replace it with 👀, then remove it on both test messages. Wait for the prompt on each message to update after every step.':'在两条测试消息上依次添加 👍、改为 👀、再移除。每一步后请等待消息提示更新。',
    'General test':'General 测试', 'Private chat test':'私人聊天测试',
    'This direction is verified. Both directions turn on automatically when the check is complete.':'此方向已验证。检查完成后，两个方向会自动启用。',
    'On THIS test message, ':'在这条测试消息上，', 'add 👍.':'添加 👍。',
    'replace your reaction with 👀.':'将表情反应改为 👀。', 'remove your reaction.':'移除表情反应。',
    'Wait for this text to update after each step. Then check the other direction in the other chat.':'每一步后请等待此文本更新，然后在另一个聊天中检查反向同步。',
    'If your reaction is set but progress has not changed, its event has not arrived. Press Refresh result. You can close the check and enable only the confirmed direction.':'如果表情反应已显示但进度未变化，事件可能尚未送达。点击“刷新结果”。您也可以结束检查，仅启用已确认的方向。',
    'Enable verified directions':'启用已验证的方向',
    'Both directions turn on automatically after the check. Normal messaging continues to work.':'检查完成后，两个方向会自动启用。普通消息不受影响。',
    'Preparing the reaction check…':'正在准备表情反应检查…',
    'in the manager bot → service → Reactions':'在管理员机器人 → 服务 → 表情反应中',
    'in General → Reactions':'在 General → 表情反应中',
    'The check has ended. Unconfirmed directions stay disabled. Start a new check in the manager bot → service → Reactions.':'检查已结束。未确认的方向保持关闭。请在管理员机器人 → 服务 → 表情反应中重新检查。',
    'The check has ended. Unconfirmed directions stay disabled. Start a new check in General → Reactions.':'检查已结束。未确认的方向保持关闭。请在 General → 表情反应中重新检查。',
    'Test message preparation did not complete. Close this check and start a new one in the manager bot → service → Reactions.':'测试消息准备失败。请结束本次检查，并在管理员机器人 → 服务 → 表情反应中重试。',
    'Test message preparation did not complete. Close this check and start a new one in General → Reactions.':'测试消息准备失败。请结束本次检查，并在 General → 表情反应中重试。',
    'This check link is stale. Start a check in the manager bot → service → Reactions.':'此检查链接已过期。请在管理员机器人 → 服务 → 表情反应中重新开始。',
    'This check link is stale. Start a check in General → Reactions.':'此检查链接已过期。请在 General → 表情反应中重新开始。',
    'This reaction check button is unavailable.':'此表情反应检查按钮不可用。',
  },
};
export const REACTION_EXTRA_TRANSLATIONS = reactionExtra;
const reactionText=(locale,english)=>{
  if (locale === 'es' || locale === 'zh') return reactionExtra[locale][english] || (locale === 'es' ? 'Traducción pendiente' : '缺少翻译');
  return english;
};
export function reactionDirection(state, direction) {
  if (!REACTION_DIRECTIONS.includes(direction)) throw new Error('Unknown reaction direction');
  return {
    verified: Number(state?.[`${direction}_verified`] ?? state?.capability_verified) === 1,
    enabled: Number(state?.[`${direction}_enabled`] ?? state?.enabled) === 1,
  };
}
export function reactionDirectionLabel(direction, ru) {
  const copy=reactionCopy[reactionLanguage(ru)];
  return direction === 'support_to_user' ? copy.support : copy.user;
}
export function reactionSummary(state, ru) {
  const copy=reactionCopy[reactionLanguage(ru)];
  return REACTION_DIRECTIONS.map(direction => {
    const value = reactionDirection(state, direction);
    return `${reactionDirectionLabel(direction, ru)}: ${value.enabled
      ? value.verified ? copy.onVerified : copy.onUnverified
      : value.verified ? copy.offVerified : copy.offUnverified}`;
  }).join('\n');
}

const now = () => new Date().toISOString();
const after = ms => new Date(Date.now() + ms).toISOString();
const TTL = 20 * 60_000;
const LEASE = 180_000;
const validId = id => Number.isSafeInteger(id) && id > 0;
const expired = row => !row || row.expires_at <= now();
const active = row => !expired(row) && ['waiting', 'preparing', 'ready'].includes(row.state);
const phase = step => ['👍', '👀', null][step];
function busy() { const error = new Error('Reaction check is busy; retry'); error.retryableReaction = true; return error; }

// Hooks use the invocation's existing D1 budget, Telegram cooldown and registry.
// Tests share the normal update claim; no customer conversation/mapping is made.
export function createReactionChecks(env, { primaryId, resolveBot, telegram, subscribe, receiverId, botKey = () => "a" }) {
  const db = env.SUPPORT_DB;
  const one = (sql, ...params) => db.prepare(sql).bind(...params).first();
  const run = (sql, ...params) => db.prepare(sql).bind(...params).run();
  const read = botId => one('SELECT * FROM reaction_checks WHERE bot_id = ?', botId);

  const lookup = nonce => one('SELECT * FROM reaction_checks WHERE nonce = ?', nonce);
  const call = (botId, method, body) => telegram(resolveBot(botId), method, body);
  const say = (row, ru, en, localeOverride = null) => {
    const language=localeOverride || resolveBot(row.bot_id).locale;
    return language === 'ru' ? ru : reactionText(language,en);
  };
  const settingsLocation = env.MANAGER_BOT_USERNAME ? ['в Админушке → сервис → Реакции', 'in the manager bot → service → Reactions']
    : ['в General → Реакции', 'in General → Reactions'];
  const button = (row, action, ru, en, localeOverride = null) => ({ text: say(row, ru, en, localeOverride), callback_data: `rx:${action}:${row.nonce}` });
  const groupLink = row => `https://t.me/c/${String(row.group_id).replace(/^-100/, '')}/${row.group_message_id}`;

  function progress(row, localeOverride = null) {
    const language = localeOverride || resolveBot(row.bot_id).locale;
    const ru = language === 'ru';
    return [['support', 'support_to_user'], ['user', 'user_to_support']].map(([prefix, direction]) => {
      const step = Number(row[`${prefix}_step`]);
      const label = reactionDirectionLabel(direction, language);
      if (step === 3) return `${label}: ✅ ${ru ? 'проверено (3/3)' : reactionText(language,'verified (3/3)')}`;
      if (row[`${prefix}_error`]) return `${label}: ⚠️ ${ru ? 'Telegram не подтвердил перенос. Уберите свою реакцию и повторите указанный шаг.' : reactionText(language,'Telegram did not confirm the mirror. Remove your reaction and repeat the requested step.')}`;
      if (!active(row)) return `${label}: ${ru ? 'не подтверждено' : reactionText(language,'not confirmed')} (${step}/3)`;
      return `${label}: ${ru ? 'ждём действие и событие Telegram' : reactionText(language,'waiting for your action and a Telegram event')} (${step}/3)`;
    }).join('\n');
  }
  function screen(row, location = 'general', localeOverride = null) {
    const renderSay=(ru,en)=>say(row,ru,en,localeOverride);
    const title = renderSay('Проверка реакций', 'Reaction check') + ` · ${resolveBot(row.bot_id).displayName}`;
    const rows = [];
    let detail;
    if (expired(row) || row.state === 'closed') {
      detail = renderSay(`Проверка завершена. Неподтверждённые направления не включаются. Новый тест можно начать ${settingsLocation[0]}.`, `The check has ended. Unconfirmed directions stay disabled. Start a new check ${settingsLocation[1]}.`);
    } else if (row.state === 'failed' || row.state === 'preparing') {
      detail = renderSay(`Подготовка тестовых сообщений не завершена. Закройте эту проверку и начните новую ${settingsLocation[0]}.`, `Test message preparation did not complete. Close this check and start a new one ${settingsLocation[1]}.`);
    } else if (row.state === 'waiting') {
      detail = renderSay('Откройте личный чат по кнопке и нажмите «Старт». Ссылка действует 20 минут и только для главного администратора.', 'Open the private chat below and press Start. This link is valid for 20 minutes and only for the primary administrator.');
      rows.push([{ text: renderSay('Открыть бота для проверки', 'Open bot for check'), url: `https://t.me/${resolveBot(row.bot_id).username}?start=rx_${row.nonce}` }]);
    } else if (location === 'manager') {
      detail = renderSay('Поставьте 👍, затем замените на 👀 и снимите реакцию на каждом из двух тестовых сообщений. После каждого шага дождитесь обновления подсказки на самом сообщении.', 'Add 👍, replace it with 👀, then remove it on both test messages. Wait for the prompt on each message to update after every step.');
      if (row.group_message_id) rows.push([{ text: renderSay('Тест в General', 'General test'), url: groupLink(row) }]);
      if (row.private_message_id) rows.push([{ text: renderSay('Тест в личном чате', 'Private chat test'), url: `https://t.me/${resolveBot(row.bot_id).username}?start=rx_${row.nonce}` }]);
    } else {
      const prefix = location === 'private' ? 'user' : 'support';
      const step = Number(row[`${prefix}_step`]);
      detail = step === 3
        ? renderSay('Это направление проверено. Оба направления включатся автоматически после завершения проверки.', 'This direction is verified. Both directions turn on automatically when the check is complete.')
        : renderSay('На ЭТОМ тестовом сообщении ', 'On THIS test message, ') + [
          renderSay('поставьте 👍.', 'add 👍.'), renderSay('замените свою реакцию на 👀.', 'replace your reaction with 👀.'), renderSay('снимите свою реакцию.', 'remove your reaction.'),
        ][step] + '\n' + renderSay('После каждого шага дождитесь обновления этого текста. Затем проверьте второе направление в другом чате.', 'Wait for this text to update after each step. Then check the other direction in the other chat.');
      detail += '\n' + renderSay('Если реакция уже стоит, а прогресс не меняется, событие ещё не получено. Нажмите «Обновить результат». Можно закрыть проверку и включить только подтверждённое направление.', 'If your reaction is set but progress has not changed, its event has not arrived. Press Refresh result. You can close the check and enable only the confirmed direction.');
      if (location === 'private' && row.group_message_id) rows.push([{ text: renderSay('Тест в General', 'General test'), url: groupLink(row) }]);
      if (location !== 'private') rows.push([{ text: renderSay('Тест в личном чате', 'Private chat test'), url: `https://t.me/${resolveBot(row.bot_id).username}?start=rx_${row.nonce}` }]);
    }
    if (active(row) || row.state === 'failed') rows.push([button(row, 'refresh', 'Обновить результат', 'Refresh result',localeOverride), button(row, 'stop', 'Закрыть проверку', 'Close check',localeOverride)]);
    if(location==='general')rows.push([{text:renderSay('Перейти к включению направлений','Enable verified directions'),callback_data:`um:r:home:${botKey(row.bot_id)}`}]);
    return { text: `${title}\n\n${detail}\n\n${progress(row,localeOverride)}\n\n${renderSay('После проверки обоих направлений реакции включаются автоматически. Обычная переписка продолжает работать.', 'Both directions turn on automatically after the check. Normal messaging continues to work.')}`, reply_markup: { inline_keyboard: rows } };
  }
  async function refresh(row) {
    for (const [location, chatId, messageId] of [['private', row.owner_id, row.private_message_id], ['general', row.group_id, row.group_message_id]]) {
      if (validId(messageId)) await call(row.bot_id, 'editMessageText', { chat_id: chatId, message_id: messageId, ...screen(row, location) });
    }
  }
  async function claim(row) {
    const token = crypto.randomUUID();
    const result = await run(`UPDATE reaction_checks SET lease_token = ?, lease_until = ?
      WHERE bot_id = ? AND nonce = ? AND expires_at > ? AND (lease_until IS NULL OR lease_until <= ?)`, token, after(LEASE), row.bot_id, row.nonce, now(), now());
    if (result.meta?.changes !== 1) throw busy();
    return token;
  }
  async function release(row, token) {
    await run('UPDATE reaction_checks SET lease_token = NULL, lease_until = NULL WHERE bot_id = ? AND nonce = ? AND lease_token = ?', row.bot_id, row.nonce, token);
  }
  async function save(row, token, fields, values) {
    const result = await run(`UPDATE reaction_checks SET ${fields} WHERE bot_id = ? AND nonce = ? AND lease_token = ? AND lease_until > ? AND expires_at > ?`, ...values, row.bot_id, row.nonce, token, now(), now());
    if (result.meta?.changes !== 1) throw busy();
  }

  async function start(botId) {
    const existing = await read(botId);
    if (active(existing) && String(existing.group_id) === String(env.SUPPORT_GROUP_ID)) return existing;
    if (existing?.lease_until > now()) throw busy();
    const target = resolveBot(botId);
    const receiver = await receiverId();
    if (!target.enabled || !target.username || !receiver) throw new Error('Reaction check bot is unavailable');
    // Caller holds the same settings lease used by the enable/disable controls.
    // Extra subscriptions never enable mirroring; each direction still has its gate.
    for (const id of new Set([botId, receiver])) await subscribe(id, true);
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const row = { bot_id: botId, nonce, owner_id: primaryId, group_id: Number(env.SUPPORT_GROUP_ID), receiver_bot_id: receiver, state: 'waiting', created_at: now(), expires_at: after(TTL) };
    await run(`INSERT INTO reaction_checks(bot_id, nonce, owner_id, group_id, receiver_bot_id, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?) ON CONFLICT(bot_id) DO UPDATE SET
      nonce = excluded.nonce, owner_id = excluded.owner_id, group_id = excluded.group_id, receiver_bot_id = excluded.receiver_bot_id,
      state = 'waiting', private_message_id = NULL, group_message_id = NULL, support_step = 0, user_step = 0,
      support_date = NULL, support_update = NULL, user_date = NULL, user_update = NULL, support_error = NULL, user_error = NULL,
      lease_token = NULL, lease_until = NULL, created_at = excluded.created_at, expires_at = excluded.expires_at`, botId, nonce, primaryId, row.group_id, receiver, row.created_at, row.expires_at);
    return read(botId);
  }

  async function open(botId, message, nonce) {
    if (message.from?.id !== primaryId || message.chat?.id !== primaryId || message.chat?.type !== 'private') return;
    let row = await lookup(nonce);
    if (!row || row.bot_id !== botId || row.owner_id !== primaryId || String(row.group_id) !== String(env.SUPPORT_GROUP_ID)) {
      await call(botId, 'sendMessage', { chat_id: primaryId, text: say({ bot_id: botId }, `Ссылка проверки устарела. Начните проверку ${settingsLocation[0]}.`, `This check link is stale. Start a check ${settingsLocation[1]}.`) });
      return;
    }
    if (!active(row)) {
      await call(botId, 'sendMessage', { chat_id: primaryId, ...screen(row, 'private') }); return;
    }
    const token = await claim(row);
    try {
      row = await read(botId);
      if (row.state === 'ready') { await refresh(row); return; }
      // Never replay a possibly accepted send after a crash/timeout. A new check
      // must be explicitly started; test messages carry no delivery obligations.
      if (row.state !== 'waiting') { await save(row, token, "state = 'failed'", []); await refresh(await read(botId)); return; }
      await save(row, token, "state = 'preparing'", []);
      try {
        db.recoveryCheckpoint?.(14);
        for (const [column, chatId] of [['private_message_id', row.owner_id], ['group_message_id', row.group_id]]) {
          const sent = await call(botId, 'sendMessage', { chat_id: chatId, text: say(row, 'Подготавливаю проверку реакций…', 'Preparing the reaction check…') });
          if (!sent.ok || !validId(sent.result?.message_id) || String(sent.result?.chat?.id) !== String(chatId)
            || (chatId === row.group_id && sent.result.message_thread_id != null && sent.result.message_thread_id !== 1)) throw new Error('Probe message was not confirmed');
          await save(row, token, `${column} = ?`, [sent.result.message_id]);
        }
        await save(row, token, "state = 'ready'", []);
      } catch {
        await save(row, token, "state = 'failed'", []);
      }
      row = await read(botId);
      await refresh(row);
      if (row.state === 'failed' && !row.private_message_id) await call(botId, 'sendMessage', { chat_id: primaryId, ...screen(row, 'private') });
    } finally { await release(row, token); }
  }

  async function callback(botId, query) {
    if (!String(query.data || '').startsWith('rx:')) return false;
    const [, action, nonce, extra] = String(query.data).split(':');
    const row = !extra && ['refresh', 'stop'].includes(action) ? await lookup(nonce) : null;
    const message = query.message;
    const valid = row && row.bot_id === botId && row.owner_id === primaryId && query.from?.id === primaryId
      && String(row.group_id) === String(env.SUPPORT_GROUP_ID)
      && ((message?.chat?.type === 'private' && message.chat.id === row.owner_id && message.message_id === row.private_message_id)
        || (String(message?.chat?.id) === String(row.group_id) && message.message_id === row.group_message_id && (!message.message_thread_id || message.message_thread_id === 1)));
    await call(botId, 'answerCallbackQuery', { callback_query_id: query.id, ...(!valid ? { text: say({ bot_id: botId }, 'Эта кнопка проверки недоступна.', 'This reaction check button is unavailable.'), show_alert: true } : {}) });
    if (!valid) return true;
    if (expired(row)) { await refresh(row); return true; }
    const token = await claim(row);
    try {
      if (action === 'stop') await save(row, token, "state = 'closed'", []);
      await refresh(await read(botId));
    } finally { await release(row, token); }
    return true;
  }

  async function stop(botId, nonce) {
    const row = await read(botId);
    if (!row || row.nonce !== nonce || expired(row)) return;
    const token = await claim(row);
    try { await save(row, token, "state = 'closed'", []); } finally { await release(row, token); }
  }

  async function reaction(botId, update, parsed) {
    const event = parsed.event;
    if (!event || event.user?.id !== primaryId || event.user?.is_bot || event.actor_chat || parsed.unsupported) return false;
    const group = String(event.chat.id) === String(env.SUPPORT_GROUP_ID);
    const row = group
      ? await one('SELECT * FROM reaction_checks WHERE receiver_bot_id = ? AND group_id = ? AND group_message_id = ?', botId, Number(event.chat.id), event.message_id)
      : await one('SELECT * FROM reaction_checks WHERE bot_id = ? AND owner_id = ? AND private_message_id = ?', botId, primaryId, event.message_id);
    if (!row || row.owner_id !== primaryId || String(row.group_id) !== String(env.SUPPORT_GROUP_ID)) return false;
    if (!active(row) || row.state !== 'ready') return true;
    const enabled = await one('SELECT enabled FROM bots WHERE id = ?', row.bot_id);
    if (!resolveBot(row.bot_id).enabled || enabled && Number(enabled.enabled) === 0) return true;
    const prefix = group ? 'support' : 'user';
    const direction = group ? 'support_to_user' : 'user_to_support';
    const token = await claim(row);
    try {
      const latest = await read(row.bot_id);
      if (latest.state !== 'ready') return true;
      // A retry after the durable proof was saved only repairs the UI.
      if (latest[`${prefix}_date`] === event.date && latest[`${prefix}_update`] === update.update_id) {
        await refresh(latest); return true;
      }
      const step = Number(latest[`${prefix}_step`]);
      if (step === 3 || parsed.emoji !== phase(step)) return true;
      if (step === 2 && event.new_reaction.length !== 0) return true;
      if (latest[`${prefix}_date`] != null && (event.date < latest[`${prefix}_date`]
        || (event.date === latest[`${prefix}_date`] && update.update_id <= latest[`${prefix}_update`]))) return true;
      db.recoveryCheckpoint?.(12);
      await save(row, token, 'lease_until = ?', [after(LEASE)]);
      const result = await call(row.bot_id, 'setMessageReaction', {
        chat_id: group ? row.owner_id : row.group_id,
        message_id: group ? row.private_message_id : row.group_message_id,
        reaction: parsed.emoji ? [{ type: 'emoji', emoji: parsed.emoji }] : [],
      });
      if (!result.ok || result.result !== true) {
        await save(row, token, `${prefix}_error = ?`, ['telegram_unconfirmed']);
      } else {
        await db.batch([
          db.prepare(`UPDATE reaction_checks SET ${prefix}_step = ?, ${prefix}_date = ?, ${prefix}_update = ?, ${prefix}_error = NULL
            WHERE bot_id = ? AND nonce = ? AND lease_token = ? AND lease_until > ? AND expires_at > ? AND state = 'ready'`)
            .bind(step + 1, event.date, update.update_id, row.bot_id, row.nonce, token, now(), now()),
          db.prepare(`INSERT INTO reaction_settings(bot_id, enabled, support_to_user_enabled, user_to_support_enabled,
              ${direction}_verified, updated_at, verified_at)
            SELECT bot_id, CASE WHEN support_step=3 AND user_step=3 THEN 1 ELSE 0 END,
              CASE WHEN support_step=3 AND user_step=3 THEN 1 ELSE 0 END,
              CASE WHEN support_step=3 AND user_step=3 THEN 1 ELSE 0 END,
              1, ?, ? FROM reaction_checks WHERE bot_id = ? AND nonce = ? AND ${prefix}_step = 3
              AND lease_token = ? AND lease_until > ? AND expires_at > ? AND state = 'ready'
            ON CONFLICT(bot_id) DO UPDATE SET
              enabled = CASE WHEN excluded.enabled=1 THEN 1 ELSE reaction_settings.enabled END,
              support_to_user_enabled = CASE WHEN excluded.enabled=1 THEN 1
                ELSE COALESCE(reaction_settings.support_to_user_enabled,reaction_settings.enabled) END,
              user_to_support_enabled = CASE WHEN excluded.enabled=1 THEN 1
                ELSE COALESCE(reaction_settings.user_to_support_enabled,reaction_settings.enabled) END,
              ${direction}_verified = 1, updated_at = excluded.updated_at, verified_at = excluded.verified_at`)
            .bind(now(), now(), row.bot_id, row.nonce, token, now(), now()),
        ]);
      }
      await refresh(await read(row.bot_id));
      return true;
    } catch (error) {
      // setMessageReaction is idempotent; a failed D1 proof can safely be retried.
      // Do not acknowledge an event whose step could not be durably recorded.
      error.retryableReaction = true;
      throw error;
    } finally { await release(row, token); }
  }
  return { read, start, screen, open, callback, reaction, active, stop };
}
