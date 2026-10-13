import { managementBotFromKey, managementBotKey, parseBotRegistry } from './worker.js';
import { opaqueManagerText } from './manager-language.js';

const button = (text, callback_data) => ({ text, callback_data });
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
const pageSize = 5;
const actionNames = {
  message_delete: 'Удаление сообщения',
  manual_ban: 'Пользователь заблокирован', manual_unban: 'Блокировка снята',
  manual_restrict: 'Ограничение включено', manual_unrestrict: 'Ограничение снято',
  manual_trust: 'Доверие включено', manual_untrust: 'Доверие снято', risk_reset: 'Риск сброшен',
  conversation_close: 'Тема закрыта', conversation_open: 'Тема открыта',
  conversation_reopened_by_user: 'Обращение возобновлено пользователем',
  conversation_topic_restored: 'Тема восстановлена после удаления',
  conversation_open_recreated: 'Удалённая тема восстановлена',
  work_take: 'Обращение взято', work_release: 'Назначение снято',
  work_waiting: 'Ожидаем клиента', work_resolve: 'Обращение решено',
  work_needs: 'Обращению нужен ответ', work_hour: 'Возврат через час',
  work_tomorrow: 'Возврат завтра', work_handoff: 'Обращение передано',
  manager_work_take: 'Обращение взято', manager_work_release: 'Назначение снято',
  manager_work_waiting: 'Ожидаем клиента', manager_work_needs: 'Обращению нужен ответ',
  manager_work_resolve: 'Обращение решено', manager_work_snooze: 'Обращение отложено',
  manager_work_tomorrow: 'Возврат завтра', manager_work_transfer: 'Обращение передано',
  temporary_mute: 'Автоограничение',
  cloudflare_plan: 'План Cloudflare изменён',
  attack_control_auto: 'Защита возвращена в AUTO',
  attack_control_on: 'Усиленная защита на час',
  attack_control_off: 'Защита выключена на час',
  attack_mode_enter: 'Усиленная защита включена автоматически',
  attack_mode_exit: 'Усиленная защита завершена автоматически',
  reactions_enable: 'Реакции включены', reactions_disable: 'Реакции выключены',
  bot_message_welcome_text: 'Приветствие изменено',
  bot_message_auto_reply_text: 'Автоответ изменён',
  bot_messages_copy: 'Сообщения скопированы с другого бота',
  message_w_enable: 'Приветствие включено', message_w_disable: 'Приветствие выключено',
  message_a_enable: 'Автоответ включён', message_a_disable: 'Автоответ выключен',
  message_w_on: 'Приветствие включено', message_w_off: 'Приветствие выключено',
  message_a_on: 'Автоответ включён', message_a_off: 'Автоответ выключен',
  topic_style_color: 'Цвет новых тем изменён', topic_style_icon: 'Иконка новых тем изменена',
  topic_style_reset: 'Оформление тем сброшено',
  operator_added: 'Оператор добавлен', operator_removed: 'Оператор удалён',
  language_en: 'Язык сервиса изменён: English', language_ru: 'Язык сервиса изменён: Русский',
  language_es: 'Язык сервиса изменён: Español', language_zh: 'Язык сервиса изменён: 简体中文',
};

// Both the system journal and a user's history use the same event sources as
// the former General screen. The caller has already authorized the operator.
export async function showManagerAudit(env, db, { key = 'a', userId = null, page = 0, details = false } = {}, show) {
  const registry = parseBotRegistry(env.BOT_REGISTRY);
  const config = key === 'a' ? null : managementBotFromKey(registry, key);
  const id = userId == null ? null : Number(userId);
  if (key !== 'a' && !config || id != null && (!Number.isSafeInteger(id) || id <= 0))
    return show('История устарела. Откройте карточку пользователя заново.');
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) >= 0 && Number(page) <= 100 ? Number(page) : 0;
  const rows = (await db.prepare(`SELECT * FROM (
    SELECT created_at,bot_id,user_id,operator_name AS actor_name,action,duration_seconds,reason,result,0 AS actor_is_system
      FROM operator_audit WHERE (? IS NULL OR bot_id=?) AND (? IS NULL OR user_id=?)
    UNION ALL
    SELECT created_at,bot_id,user_id,'Система',event_type,NULL,NULL,'success',1
      FROM abuse_events WHERE event_type IN ('temporary_mute','attack_mode_enter','attack_mode_exit')
      AND event_key NOT LIKE 'manual-%' AND (? IS NULL OR bot_id=?) AND (? IS NULL OR user_id=?)
    UNION ALL
    SELECT created_at,NULL,NULL,actor_name,action,NULL,
      ('operator=' || target_operator_id || '; name=' || target_name ||
        CASE WHEN target_username IS NULL THEN '' ELSE '; username=@' || target_username END),result,0
      FROM support_operator_audit WHERE ? IS NULL AND ? IS NULL
  ) ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(
    config?.id ?? null, config?.id ?? null, id, id,
    config?.id ?? null, config?.id ?? null, id, id,
    config?.id ?? null, id, pageSize + 1, safePage * pageSize).all()).results || [];
  const lines = rows.slice(0, pageSize).map(row =>
    `${clean(row.created_at)} · ${row.bot_id ? opaqueManagerText(clean(row.bot_id)) : 'команда'} · ${row.actor_is_system ? 'Система' : opaqueManagerText(clean(row.actor_name || 'Система'))} — ${clean(actionNames[row.action] || row.action)}`
    + (row.user_id ? ` · ${row.user_id}` : '')
    + (row.duration_seconds ? ` · ${Math.ceil(row.duration_seconds / 60)} мин` : '')
    + (row.reason ? ` · ${opaqueManagerText(clean(row.reason))}` : '') + ` · ${clean(row.result)}`
    + (details && actionNames[row.action] ? ` [${clean(row.action)}]` : ''));
  const route = (next, expanded = details) => id == null
    ? `mg:audit:${key}:${next}${expanded ? ':d' : ''}`
    : `mu:audit:${key}:${id}:${next}${expanded ? ':d' : ''}`;
  const navigation = [];
  if (safePage) navigation.push(button('←', route(safePage - 1)));
  if (rows.length > pageSize) navigation.push(button('→', route(safePage + 1)));
  const back = id == null ? 'mg:home' : `mu:card:${key}:${id}`;
  const filters = id == null ? [
    ...(key === 'a' ? [] : [[button('Все сервисы', `mg:audit:a:0${details ? ':d' : ''}`)]]),
    ...registry.map(item => [button(`${item.enabled ? '' : '⏸ '}${opaqueManagerText(item.displayName)}`,
      `mg:audit:${managementBotKey(registry, item.id)}:0${details ? ':d' : ''}`)]),
  ] : [];
  return show(`${id == null ? 'Журнал действий' : `История пользователя ${id} · ${opaqueManagerText(config.displayName)}`} · страница ${safePage + 1}\n\n`
    + (lines.join('\n') || 'Записей нет.'),
  [...(navigation.length ? [navigation] : []),
    [button(details ? 'Скрыть коды' : 'Технические коды', route(safePage, !details))],
    ...filters, [button(id == null ? 'Меню' : 'К карточке', back)]]);
}
