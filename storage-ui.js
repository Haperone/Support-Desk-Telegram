import { storageOwner, storageStatement as stmt, readStorageControl, createStorageJob, addJobTopics, confirmStorageJob } from './storage-retention.js';
import { resetPreview, previewFullReset, armFullReset, beginFullReset } from './storage-reset.js';
import { storageText } from './storage-copy.js';
import { customerName } from './user-display.js';
import { managerScreenKeyboard } from './manager-navigation.js';

const PREFIX = 'um:st:';
const PHRASE = 'УДАЛИТЬ ВСЕ ОБРАЩЕНИЯ';
export const STORAGE_RESET_PHRASES = Object.freeze({
  ru: PHRASE,
  en: 'DELETE ALL CONVERSATIONS',
  es: 'ELIMINAR TODAS LAS CONVERSACIONES',
  zh: '删除所有会话',
});
export const isStorageResetPhrase = value => Object.values(STORAGE_RESET_PHRASES).includes(String(value || '').trim());
const button = (text, data) => ({ text, callback_data: PREFIX + data });
function storagePresentation(locale, managerUsername = null, privateStorage = false) {
  const t=storageText(locale);
  const managerHome = privateStorage ? {text:t('Главное меню'),callback_data:'mg:home'}
    : managerUsername ? {text:t('Главное меню'),url:`https://t.me/${managerUsername}?start=menu`} : null;
  const home = () => [button(t('← Хранилище'), 'home'),managerHome||{text:t('Главное меню'),callback_data:'um:n:home'}];
  const topicLabel=row=>customerName(row,t('Пользователь ')+(row.user_id||t('неизвестен')));
  const topicButton=row=>({text:t('Открыть тему ↗'),url:'https://t.me/c/'+String(row.support_group_id).replace(/^-100/,'')+'/'+row.thread_id});
  const dateLocale={ru:'ru-RU',en:'en-GB',es:'es-ES',zh:'zh-CN'}[locale]||'en-GB';
  const activityDate=value=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat(dateLocale,{timeZone:'Europe/Budapest',dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):t('нет данных');
  const states = { present: t('есть'), closed: t('закрыта для обсуждения'), unknown: t('наличие не проверено'), missing_confirmed: t('удаление подтверждено вами') };
  const statuses={preview:t('предпросмотр'),running:t('выполняется'),completed:t('завершено'),cancelled:t('отменено'),expired:t('истекло'),needs_attention:t('требует внимания')};
  const modes={old:t('старые связи'),deleted:t('удалённые темы'),technical:t('служебные записи'),auto:t('автоочистка')};
  return {t,home,managerHome,topicLabel,topicButton,activityDate,states,statusLabel:value=>statuses[value]||value,modeLabel:value=>modes[value]||value};
}
const cursorToken=value=>'~'+Number(value).toString(36);
const shortJob=id=>'~'+btoa(String.fromCharCode(...id.match(/../g).map(hex=>parseInt(hex,16)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const fullJob=id=>id?.startsWith('~')?Array.from(atob(id.slice(1).replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0).toString(16).padStart(2,'0')).join(''):id;
const readCursor=value=>String(value||'').startsWith('~')?parseInt(value.slice(1),36)||0:Number(value)||0;
export function storageCandidate(update) {
  return String(update.callback_query?.data || '').startsWith(PREFIX)
    || /^\/storage(?:@\w+)?(?:\s|$)/i.test(update.message?.text || '')
    || isStorageResetPhrase(update.message?.text);
}

// Runs before ordinary update bookkeeping: the emergency control row is created
// by migration, and using this screen must not require inserting a user/claim.
export async function handleStorageUpdate(bot, env, update, send) {
  if (!storageCandidate(update)) return false;
  const ui=storagePresentation(bot.locale,bot.managerUsername,bot.privateStorage),{t,home,managerHome,topicLabel,topicButton,activityDate,states,statusLabel,modeLabel}=ui;
  const query = update.callback_query;
  const message = query?.message || update.message;
  const actor = query?.from?.id || message?.from?.id;
  const general = bot.privateStorage ? message?.chat?.type === 'private' && Number(message.chat.id) === Number(actor)
    : String(message?.chat?.id) === String(env.SUPPORT_GROUP_ID)
      && (message.message_thread_id == null || Number(message.message_thread_id) === 1);
  if (!general || Number(actor) !== storageOwner(env)) {
    if (query) await send('answerCallbackQuery', { callback_query_id: query.id, text: bot.privateStorage
      ? t('Только главный администратор в личке Админушки.') : t('Только главный администратор в General.'), show_alert: true });
    else if (String(message?.chat?.id) === String(env.SUPPORT_GROUP_ID) && Number(actor) === storageOwner(env)) {
      await send('sendMessage', { chat_id: Number(env.SUPPORT_GROUP_ID), text: t('Хранилище доступно только в General. Откройте здесь /menu.'), reply_markup: { inline_keyboard: [[{ text: 'General', url: 'https://t.me/c/' + String(env.SUPPORT_GROUP_ID).replace(/^-100/, '') + '/1' }]] } });
    }
    return true;
  }
  // Every bot receives a General message. Only the configured owner answers text.
  if (!query && !bot.groupCommandOwner) return true;
  if (query) await send('answerCallbackQuery', { callback_query_id: query.id });
  const sourceButtons=message?.reply_markup?.inline_keyboard?.flat()||[];
  const dedicated=sourceButtons.some(b=>b.callback_data?.startsWith(PREFIX)&&b.callback_data!==PREFIX+'home')&&sourceButtons.every(b=>b.callback_data?.startsWith(PREFIX)||['um:n:home','um:n:system','mg:home','mg:storage'].includes(b.callback_data)||b.url||b.disabled);
  let screenId=query && (query.data!==PREFIX+'home'||dedicated)?message.message_id:null;
  let displayed=screenId?message:null;
  const show = async (text,rows=[home()]) => {
    if (bot.privateStorage) rows = managerScreenKeyboard(rows, {
      route: String(query?.data || PREFIX + 'home'), primary: true,
      screenText: text,
    });
    const body={chat_id:bot.privateStorage?Number(actor):Number(env.SUPPORT_GROUP_ID),text,reply_markup:{inline_keyboard:rows}};
    if(screenId && displayed?.text===text && JSON.stringify(displayed.reply_markup)===JSON.stringify(body.reply_markup))return {ok:true,result:{message_id:screenId}};
    let result=screenId?await send('editMessageText',{...body,message_id:screenId}):null;
    if(result?.ok || /message is not modified/i.test(result?.description||'')){displayed=body;return result;}
    if(result && (result.retryable||result.deferred||result.deliveryUncertain))return result;
    result=await send('sendMessage',body);if(result?.ok&&result.result?.message_id){screenId=result.result.message_id;displayed=body;}return result;
  };
  if (env.RETENTION_ENABLED !== 'true' && env.SUPPORT_DB.storageMode !== 'reset') { await show(t('Очистка ещё не включена в настройках Worker.')); return true; }
  const db = env.SUPPORT_DB;
  const resetEnv = bot.privateStorage ? { ...env, SUPPORT_GROUP_ID: String(env.STORAGE_RESET_GROUP_ID || env.SUPPORT_GROUP_ID) } : env;
  const resetGroup = Number(resetEnv.SUPPORT_GROUP_ID);
  let [action = 'home', a, b, c] = String(query?.data || PREFIX + 'home').slice(PREFIX.length).split(':');
  if (!query && isStorageResetPhrase(message.text)) action = 'phrase';
  const control = await readStorageControl(db);
  const customRules = !query && String(message.text).match(/^\/storage(?:@\w+)?\s+rules\s+(\d+)\s+(\d+)\s+(\d+)\s*$/i);
  if (customRules) {
    const [days, quarantine, daily] = customRules.slice(1).map(Number);
    if (days < 1 || days > 3650 || quarantine < 1 || quarantine > 90 || daily < 1 || daily > 100000) {
      await show(t('Допустимые значения: срок 1–3650 дней, ожидание 1–90 дней, дневная порция 1–100000 связей.')); return true;
    }
    await show(t`Новые правила: ${days} дней, карантин ${quarantine} дней, до ${daily} связей в день. Изменение отменит оставшиеся разрешения старых заданий.`,[[button(t('Применить правила'),`policy:${days}:${quarantine}:${daily}:${control.policy_revision}`)],home()]);return true;
  }
  const topic = async (id) => stmt(db, 'SELECT t.*,c.first_name,c.last_name,c.username FROM storage_topics t LEFT JOIN conversations c ON c.bot_id=t.bot_id AND c.user_id=t.user_id WHERE t.id = ? AND t.support_group_id = ? AND t.generation = ?', Number(id), Number(env.SUPPORT_GROUP_ID), control.generation).first();
  if (action === 'phrase') {
    const started = await beginFullReset(resetEnv, actor, PHRASE);
    await show(started ? t('Полная очистка запущена. Приём сообщений временно отложен: Telegram сможет повторить доставку. Фоновая задача удаляет записи порциями; прогресс — в /storage.') : t('Подтверждение истекло или уже использовано. Откройте новый предпросмотр.'));
    return true;
  }
  if (action === 'pause' || action === 'resume') {
    await stmt(db, "UPDATE storage_control SET stopped = ? WHERE id = 1 AND mode = 'reset' AND reset_actor = ? AND reset_group = ? AND generation = ?", action === 'pause' ? 1 : 0, actor, resetGroup, Number(a)).run();
    action = 'home';
  }
  if (control.mode === 'reset') {
    if (action === 'stop') {
      await show(t('Остановить оставшуюся очистку? Уже удалённые записи не восстановятся. Оставшиеся обращения и очереди сохранятся, приём новых сообщений возобновится после ближайшего фонового этапа.'),
        [[button(t('Да, остановить оставшуюся очистку'), `stopconfirm:${control.generation}`)], home()]); return true;
    }
    // A newly configured primary administrator may cancel the old owner's work
    // after reviewing a fresh stop confirmation, but cannot resume its deletion.
    if (action === 'stopconfirm') await stmt(db, "UPDATE storage_control SET reset_cancel_requested = 1, stopped = 0, reset_actor = ?, reset_group = ? WHERE id = 1 AND mode = 'reset' AND generation = ?", actor, resetGroup, Number(a)).run();
    const current = await readStorageControl(db);
    await show(t`Полная очистка: ${current.reset_cancel_requested ? t('останавливается') : current.stopped ? t('на паузе') : t('выполняется')}.\nУдалено записей: ${current.deleted_rows}. Этап: ${current.reset_cursor + 1}.\nПриём новых сообщений отложен до завершения.${current.last_error ? t('\nПоследний этап не завершился; задача повторит его.') : ''}`,
      [[button(current.stopped ? t('Продолжить') : t('Пауза'), `${current.stopped ? 'resume' : 'pause'}:${current.generation}`)], [button(t('Остановить оставшуюся очистку'), 'stop')], [button(t('Обновить'), 'home')]]);
    return true;
  }
  if (action === 'reset') {
    const preview = await resetPreview(resetEnv);
    const nonce = await previewFullReset(resetEnv, actor);
    await show(t`Удалить все данные обращений из БД, для всех сервисов?\nЧатов: ${preview.conversations}. Связей сообщений: ${preview.mappings}. Сообщений в очередях: ${preview.queued}.\nБудут удалены обращения, связи ответов и реакций, недоставленные сообщения и служебные попытки доставки. В Telegram темы и переписка останутся. Следующее обращение создаст новую тему; прежние кнопки потеряют связь с обращением. Настройки, блокировки, доверие и операторы сохранятся.\nВо время очистки приём временно приостановится. Telegram хранит недоставленные обновления не более 24 часов; большие очереди нужно очищать без длительных пауз. Отменить уже выполненное удаление нельзя.`,
      nonce ? [[button(t('Понимаю, перейти к подтверждению'), `arm:${nonce}`)], home()] : [home()]);
  } else if (action === 'space') {
    let result;
    let timer;
    try {
      result = await Promise.race([env.STORAGE_MONITOR?.snapshot({ cursor: a || '', locale: bot.locale }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Storage check timed out')), 10000); })]);
    } catch { /* The emergency reset remains available independently of the monitor. */ }
    finally { clearTimeout(timer); }
    const values = result?.databases || [];
    const measured=values.filter(row=>row.quality==='available'&&Number.isFinite(row.bytes));
    const attention=measured.filter(row=>Number.isFinite(row.limit_bytes)&&row.bytes>=row.limit_bytes*0.7).length;
    await show(values.length ? t`Использование места${result.quality === 'available' ? '' : t(' (данные неполные)')}\n` + t`На этой странице измерены базы: ${measured.length} из ${values.length}. Выше порога 70%: ${attention}.`+'\n\n'+values.map((row) =>
      t`${row.name}: ${row.quality === 'available' && Number.isFinite(row.bytes) ? (row.bytes / 1000000).toFixed(1) + ' MB'+(row.limit_bytes>0?t` из ${(row.limit_bytes/1000000).toFixed(0)} MB (${(row.bytes/row.limit_bytes*100).toFixed(1)}%)`:'') : t('нет свежего измерения')}\nИзмерено: ${row.measured_at || t('неизвестно')}${row.forecast ? '\n' + row.forecast : ''}`).join('\n\n')
      + t`\n\nПороги уведомлений: 70%, 85%, 95%. Удаление строк не обещает немедленного уменьшения размера файла.`
      : t('Свежие размеры баз пока недоступны. Это не означает, что базы пусты. Очистка и её подтверждения доступны отдельно.'),
      [...(result?.next && new TextEncoder().encode(PREFIX + 'space:' + result.next).length <= 64 ? [[button(t('Другие базы'), `space:${result.next}`)]] : []), home()]);
  } else if (action === 'arm') {
    const armed = await armFullReset(resetEnv, actor, a);
    const phrase=STORAGE_RESET_PHRASES[bot.locale] || STORAGE_RESET_PHRASES.en;
    const instruction=bot.privateStorage
      ? t`Для запуска отправьте сюда в личку отдельным сообщением точно:\n${phrase}\nПодтверждение действует 5 минут с открытия предпросмотра.`
      : t`Для запуска отправьте в General отдельным сообщением точно:\n${phrase}\nПодтверждение действует 5 минут с открытия предпросмотра.`;
    await show(armed ? instruction : t('Этот предпросмотр устарел. Откройте новый.'));
   } else if(action==='policypreview') {
    await show(t`Новые правила: ${a} дней, карантин ${b} дней, до ${c} связей в день. Изменение отменит оставшиеся разрешения старых заданий.`,[[button(t('Применить'),`policy:${a}:${b}:${c}:${control.policy_revision}`)],home()]);
  } else if(action==='policy') {
    const [days,quarantine,daily,revision]=String(query.data).slice(PREFIX.length).split(':').slice(1).map(Number);
    if(Number.isSafeInteger(days)&&days>=1&&days<=3650&&Number.isSafeInteger(quarantine)&&quarantine>=1&&quarantine<=90&&Number.isSafeInteger(daily)&&daily>=1&&daily<=100000) {
      const result=await stmt(db,"UPDATE storage_control SET retention_days=?,quarantine_days=?,daily_limit=?,policy_revision=policy_revision+1 WHERE id=1 AND mode='normal' AND policy_revision=?",days,quarantine,daily,revision).run();
      await show(result.meta?.changes>0?t('Правила сохранены.'):t('Правила уже изменились. Откройте свежий предпросмотр.'),[[button(t('Правила'),'rules')],home()]);
    }else await show(t('Некорректные правила.'),[[button(t('Правила'),'rules')],home()]);
  } else if (action === 'rules' || action === 'days') {
    if (action === 'days' && [90, 180, 365].includes(Number(a))) {
      await show(t`Срок станет ${a} дней. Изменение отменит оставшиеся разрешения старых заданий.`,[[button(t('Применить'),`policy:${a}:${control.quarantine_days}:${control.daily_limit}:${control.policy_revision}`)],home()]);return true;
    }
    const current = await readStorageControl(db);
    await show(t`Очистка после ${current.retention_days} дней без активности. Старые связи сообщений должны быть не моложе этого срока.\nАвтоматически — только темы, удаление которых вы подтвердили, после ${current.quarantine_days} дней ожидания. Остальные требуют согласия. Новая активность отменяет прежний выбор.\nАвтоочистка Free: до ${current.daily_limit} связей в день; ручная очистка также расходует дневной лимит D1.\nИзменить все три значения: /storage rules 180 7 500\nПорядок: срок, ожидание, дневной предел. Изменение правил отменяет прежние разрешения на оставшуюся очистку.`,
      [[90,180,365].map(days=>button(t`${days} дней`,`days:${days}`)),[7,14,30].map(days=>button(t`Ожидание ${days} д.`,`policypreview:${current.retention_days}:${days}:${current.daily_limit}`)),[100,500,1000].map(limit=>button(t`${limit} в день`,`policypreview:${current.retention_days}:${current.quarantine_days}:${limit}`)),home()]);
  } else if (action === 'list') {
    const cursor = Number(a) || 0;
    const rows = (await stmt(db, 'SELECT t.*,c.first_name,c.last_name,c.username FROM storage_topics t LEFT JOIN conversations c ON c.bot_id=t.bot_id AND c.user_id=t.user_id WHERE t.id > ? AND t.support_group_id = ? AND t.generation = ? ORDER BY t.id LIMIT 6', cursor, Number(env.SUPPORT_GROUP_ID), control.generation).all()).results || [];
    await show(t('Темы в БД. Наличие темы Telegram не позволяет проверить простым списком. Если вы удалили её вручную, откройте карточку и подтвердите это.'),
      [...rows.slice(0, 5).map((row) => [button(`${topicLabel(row)} · ${row.bot_id} · ${row.thread_id}${row.protected ? ' 🔒' : ''}`, `topic:${row.id}:${cursor}`)]), ...(cursor?[[button(t("← Начало списка"),"list:0")]]:[]), ...(rows.length > 5 ? [[button(t('Следующие'), `list:${rows[4].id}`)]] : []), home()]);
  } else if (['topic', 'missing', 'mark', 'protect', 'remind'].includes(action)) {
    const listCursor=Number(action==='topic'||action==='missing'?b:c)||0;
    let row = await topic(a);
    if (!row) { await show(t('Тема больше не относится к этому списку. Обновите экран.')); return true; }
    if (action === 'missing') {
      await show(t`Вы лично проверили и удалили тему ${row.thread_id} (${row.bot_id}) в Telegram? Ошибка Telegram сама по себе этого не доказывает.`,
        [[button(t('Да, темы больше нет'), `mark:${row.id}:${row.revision}:${listCursor}`)], [button(t('Назад'), `topic:${row.id}:${listCursor}`)]]); return true;
    }
    if (['mark', 'protect', 'remind'].includes(action)) {
      const set = action === 'mark' ? "state = 'missing_confirmed', missing_at = ?" : action === 'protect' ? 'protected = 1 - protected' : 'remind_after = ?';
      const values = action === 'mark' ? [new Date().toISOString()] : action === 'remind' ? [new Date(Date.now() + 30 * 86_400_000).toISOString()] : [];
      await stmt(db, `UPDATE storage_topics SET ${set}, revision = revision + 1 WHERE id = ? AND revision = ? AND generation = ? AND support_group_id = ?`, ...values, row.id, Number(b), control.generation, Number(env.SUPPORT_GROUP_ID)).run();
      row = await topic(a);
    }
    await show(t`${topicLabel(row)} · ${row.bot_id} · тема ${row.thread_id}\nСостояние: ${states[row.state]}.\nПоследняя известная активность: ${activityDate(row.last_activity)}${row.activity_known ? '' : t(' (неполные исторические данные)')}.\nЗащита от очистки: ${row.protected ? t('включена') : t('выключена')}.`,
      [[topicButton(row)],[button(t('Очистить старые связи'), `one:${row.id}`)], [button(t('Я удалил эту тему'), `missing:${row.id}:${listCursor}`)],
        [button(row.protected ? t('Снять защиту') : t('Не очищать'), `protect:${row.id}:${row.revision}:${listCursor}`), button(t('Напомнить через месяц'), `remind:${row.id}:${row.revision}:${listCursor}`)], [button(t('← Темы'), `list:${listCursor}`)], home()]);
  } else if (['old', 'deleted', 'one', 'technical'].includes(action)) {
    const id = await createStorageJob(env, { mode: action === 'technical' ? 'technical' : action === 'deleted' ? 'deleted' : 'old', actorId: actor, topicId: action === 'one' ? Number(a) : null, botId: action !== 'one' && a && a !== 'all' ? a : null });
    await renderJob(db, id, actor, show, ui);
  } else if (action === 'services') {
    const registry = JSON.parse(env.BOT_REGISTRY || '[]');
    const inGroup = bot.privateStorage ? new Set(((await stmt(db, `SELECT bot_id FROM service_group_routes WHERE group_id=?
      UNION SELECT bot_id FROM storage_topics WHERE support_group_id=?`, Number(env.SUPPORT_GROUP_ID), Number(env.SUPPORT_GROUP_ID)).all()).results || [])
      .map(row => row.bot_id)) : null;
    await show(t('Выберите сервис для очистки старых связей сообщений.'),
      [...registry.filter(service => !inGroup || inGroup.has(service.id)).slice(0, 40)
        .map((service) => [button(service.displayName || service.id, `old:${service.id}`)])
        .filter((row) => new TextEncoder().encode(row[0].callback_data).length <= 64), home()]);
  } else if (['job', 'start', 'cancel', 'exclude'].includes(action)) {
    try { a=fullJob(a); } catch { await show(t('Кнопка задания устарела. Откройте хранилище.')); return true; }
    const job = await stmt(db, 'SELECT * FROM storage_jobs WHERE id = ? AND actor_id = ? AND support_group_id = ? AND generation = ?', a, actor, Number(env.SUPPORT_GROUP_ID), control.generation).first();
    if (!job) { await show(t('Задание устарело или удалено.')); return true; }
    if (action === 'start') await confirmStorageJob(env, a, actor);
    if (action === 'cancel') await stmt(db, "UPDATE storage_jobs SET status = 'cancelled' WHERE id = ? AND actor_id = ? AND status IN ('preview', 'running')", a, actor).run();
    if (action === 'exclude') await stmt(db, "UPDATE storage_job_topics SET status = 'excluded' WHERE job_id = ? AND topic_id = ? AND EXISTS(SELECT 1 FROM storage_jobs WHERE id = ? AND status = 'preview')", a, readCursor(b), a).run();
    if (action === 'job' && job.status === 'preview' && !job.scan_complete) await addJobTopics(env, a);
    await renderJob(db, a, actor, show, ui, action === 'job' ? Number(b) || 0 : action==='exclude'?readCursor(c):0);
  } else if (action === 'jobs') {
    const rows = (await stmt(db, 'SELECT * FROM storage_jobs WHERE actor_id = ? AND support_group_id = ? ORDER BY created_at DESC LIMIT 8', actor, Number(env.SUPPORT_GROUP_ID)).all()).results || [];
    await show(t('Последние задания очистки. Отмена останавливает оставшуюся работу; уже удалённое не восстанавливает.'), [...rows.map((row) => [button(`${modeLabel(row.mode)} · ${statusLabel(row.status)} · ${row.deleted_rows}`, `job:${row.id}`)]), home()]);
  } else if(action==='danger') {
    await show(t('⚠️ Опасные действия\n\nПолная очистка удаляет все данные обращений и недоставленные сообщения. Переписка Telegram останется. Откройте предпросмотр, чтобы увидеть последствия; удаление требует отдельного подтверждения.'),[[button(t('Удалить все данные обращений из БД'),'reset')],home()]);
  } else if(action==='details') {
    await show(t('Хранилище обращений\nОчистка связей освобождает место в D1. Переписка в Telegram остаётся, но ответы и реакции на очищенные сообщения больше не синхронизируются.\nИсторические темы добавляются в список постепенно фоновым сканированием. «Удалённые» — только темы, удаление которых вы подтвердили.'),[home()]);
  } else {
    const jobs=await stmt(db,`SELECT COUNT(CASE WHEN status='running' THEN 1 END) running,
      COUNT(CASE WHEN status='needs_attention' OR (status='running' AND last_error IS NOT NULL) THEN 1 END) attention
      FROM storage_jobs WHERE actor_id=? AND support_group_id=? AND generation=?`,actor,Number(env.SUPPORT_GROUP_ID),control.generation).first();
    const summary=jobs.attention?t`⚠️ Задания, требующие внимания: ${jobs.attention}.`:t('✅ Заданий с проблемами нет.');
    await show(t('Хранилище обращений')+(bot.privateStorage?'\n'+t`Группа: ${bot.storageGroupTitle || env.SUPPORT_GROUP_ID}`:'')+'\n\n'+summary+'\n'+t`Выполняется заданий: ${jobs.running}.`+'\n\n'+t('Полная очистка не запущена. Выберите, что проверить или очистить. Очистка данных не удаляет переписку Telegram.\n\nЗаполненность хранилища проверяется отдельно в «Использование места».'),
      [[button(t('Использование места'), 'space')], [button(t('Темы: проверить и выбрать'), 'list:0')], [button(bot.privateStorage?t('Старые связи: эта группа'):t('Старые связи: все сервисы'), 'old:all'), button(t('Выбрать сервис'), 'services')],
        [button(t('Очистить удалённые топики'), 'deleted:all')], [button(t('Очистить завершённые служебные записи'), 'technical')], [button(t('Правила'), 'rules'), button(t('Задания и прогресс'), 'jobs')], [button(t('Технические детали'),'details')], [button(t('⚠️ Опасные действия'),'danger')], ...(bot.privateStorage ? [[{text:t('Сменить группу'),callback_data:'mg:storage'}]] : []),managerHome ? [managerHome] : [{text:t('← Система'),callback_data:'um:n:system'}]]);
  }
  return true;
}

async function renderJob(db, id, actor, show, ui, cursor = 0) {
  const {t,home,topicLabel,topicButton,activityDate,statusLabel}=ui;
  const job = await stmt(db, `SELECT j.*, (SELECT COUNT(*) FROM storage_job_topics WHERE job_id = j.id AND status = 'pending') AS pending,
    (SELECT COUNT(*) FROM storage_job_topics WHERE job_id = j.id AND status = 'needs_attention') AS busy
    FROM storage_jobs j WHERE id = ? AND actor_id = ?`, id, actor).first();
  if (job.mode === 'technical') {
    await show(t`Служебная очистка: ${statusLabel(job.status)}.\nУдалено записей: ${job.deleted_rows}. Этап ${job.scan_cursor + 1}.\nУдаляются завершённые записи доставки, обработки обновлений и выборочная телеметрия старше ${job.cutoff}. Связи сообщений и чаты сохраняются. Незавершённые доставки не удаляются.`,
      [...(job.status === 'preview' ? [[button(t('Подтвердить служебную очистку'), `start:${id}`)]] : []),
        ...(['preview', 'running'].includes(job.status) ? [[button(t('Отменить оставшуюся работу'), `cancel:${id}`)]] : []), [button(t('Обновить'), `job:${id}`)], home()]);
    return;
  }
  const topics = (await stmt(db, `SELECT jt.*, t.thread_id,t.user_id,t.bot_id,t.support_group_id,t.last_activity,t.activity_known,c.first_name,c.last_name,c.username FROM storage_job_topics jt JOIN storage_topics t ON t.id = jt.topic_id LEFT JOIN conversations c ON c.bot_id=t.bot_id AND c.user_id=t.user_id
    WHERE jt.job_id = ? AND jt.topic_id > ? AND jt.status = 'pending' ORDER BY jt.topic_id LIMIT 6`, id, cursor).all()).results || [];
  const rows = [];
  const counts = await stmt(db, `SELECT COUNT(*) AS n FROM message_mappings m JOIN storage_topics t ON t.bot_id = m.bot_id AND t.thread_id = m.thread_id
    JOIN storage_job_topics jt ON jt.topic_id = t.id WHERE jt.job_id = ? AND jt.status = 'pending' AND m.created_at <= jt.cutoff`, id).first();
  if (job.status === 'preview') {
    rows.push(...topics.slice(0, 5).map((row) => [button(t`Исключить: ${topicLabel(row)} · ${row.bot_id}`, `exclude:${shortJob(id)}:${cursorToken(row.topic_id)}:${cursorToken(cursor)}`),topicButton(row)]));
    if(cursor)rows.push([button(t('← Начало выбранных'),`job:${id}:0`)]);
    if (topics.length > 5) rows.push([button(t('Следующие выбранные'), `job:${id}:${topics[4].topic_id}`)]);
    if (job.scan_complete && job.pending) rows.push([button(t`Подтвердить очистку ${job.pending} тем`, `start:${id}`)]);
  }
  if (['preview', 'running'].includes(job.status)) rows.push([button(t('Отменить оставшуюся работу'), `cancel:${id}`)]);
  rows.push([button(job.scan_complete ? t('Обновить') : t('Продолжить сбор списка'), `job:${id}:${cursor}`)], home());
  await show(t`Задание: ${statusLabel(job.status)}.\nВыбрано ещё тем: ${job.pending}. Требуют внимания: ${job.busy}. Удалено связей: ${job.deleted_rows}.\nСейчас подходят ${counts.n} связей, созданных до ${job.cutoff}.\n${job.mode === 'deleted' ? t('Для подтверждённо удалённых тем: связи любого возраста и запись чата.') : t('Только связи старше выбранного срока; запись чата сохраняется.')}\n${topics.slice(0,5).map(row=>topicLabel(row)+' · '+row.bot_id+' — '+activityDate(row.last_activity)+(row.activity_known?'':t(' (дата неполная)'))).join('\n')}\n${job.scan_complete ? t('Список собран.') : t('Список ещё собирается; подтверждение пока недоступно.')}\nУ выбранных старых сообщений перестанут синхронизироваться ответы и реакции; переписка Telegram останется. Новая активность отменяет очистку соответствующей темы. Неизвестное состояние не означает удаления темы.${job.last_error ? t('\nПредыдущая попытка завершилась ошибкой; задание сохранено.') : ''}`, rows);
}
