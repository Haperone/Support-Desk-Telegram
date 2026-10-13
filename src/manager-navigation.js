const button = (text, callback_data) => ({ text, callback_data });
const divider = { text: '────────', disabled: {} };

function parentRoute(route, primary) {
  const [namespace, action, key, detail] = String(route || '').split(':');
  if (namespace === 'um' && action === 'st') {
    const parts = String(route).split(':');
    if (key === 'home') return 'mg:storage';
    if (key === 'missing') return `um:st:topic:${parts[3]}:${parts[4] || 0}`;
    if (['topic', 'mark', 'protect', 'remind'].includes(key)) return `um:st:list:${parts.at(-1) || 0}`;
    return 'um:st:home';
  }
  if (namespace === 'mu') {
    if (action === 'audit') return `mu:card:${key}:${detail}`;
    if (action === 'card') return `mu:home:${key}`;
    if (action === 'list') return `mu:home:${key}`;
    if (action === 'home') return 'mg:home';
    if (action === 'search' || action === 'searchcancel') return 'mu:home:a';
    if (action === 'restrict') return `mu:card:${key}:${detail}`;
    if (action === 'act') return `mu:card:${detail}:${route.split(':')[4]}`;
    if (action === 'period') return `mu:card:${detail}:${route.split(':')[4]}`;
    return 'mu:home:a';
  }
  if (namespace !== 'mg') return 'mg:home';
  if (action === 'section') return 'mg:home';
  if (action === 'service') return primary ? 'mg:section:bots' : 'mg:home';
  if (['settings', 'ready', 'test', 'testnew', 'choose', 'timers', 'lifecycle', 'lifedo', 'begin', 'flow'].includes(action))
    return key?.startsWith('b') ? `mg:service:${key}` : 'mg:home';
  if (['rxview', 'attackview'].includes(action))
    return key === 'a' ? primary ? 'mg:section:bots' : 'mg:home' : `mg:service:${key}`;
  if (['msgs', 'rx', 'style', 'attack'].includes(action)) return `mg:settings:${key}`;
  if (['msg', 'msgsave', 'msgcancel', 'msgrevise', 'copymsg', 'copypreview', 'copyapply'].includes(action))
    return key?.startsWith('b') ? `mg:msgs:${key}` : 'mg:home';
  if (['rxtest', 'rxcheck', 'rxstop', 'rxset'].includes(action)) return `mg:rx:${key}`;
  if (['stylecolors', 'styleicons', 'styleicon', 'stylecolor', 'stylereset'].includes(action)) return `mg:style:${key}`;
  if (['attackconfirm', 'attackset'].includes(action)) return `mg:attack:${key}`;
  if (action === 'queuebots') return `mg:queue:a:${key || 'needs'}:0`;
  if (action === 'problems' && key && key !== 'a') return `mg:service:${key}`;
  if (action === 'queue' || action === 'problems' || action === 'drafts' || action === 'draftwork'
    || action === 'draftnote' || action === 'draftmsg') return primary ? 'mg:section:work' : 'mg:home';
  if (['urgent', 'urgentall'].includes(action) || action === 'page' && ['urgent', 'urgentall'].includes(key))
    return primary ? 'mg:section:overdue' : 'mg:home';
  if (action === 'work' || action === 'pw' || action === 'qw' || action === 'act'
    || action === 'transfer' || action === 'transferpage' || action === 'to' || action === 'commit') return 'mg:mine';
  if (action === 'diag') return `mg:service:${key}`;
  if (['operators', 'opprimary', 'opcard', 'opremove', 'opadd', 'opaddconfirm', 'opconfirm'].includes(action))
    return action === 'operators' ? 'mg:home' : 'mg:operators';
  if (action === 'alert') return key === 'home' ? 'mg:home' : 'mg:alert:home';
  if (action === 'help') return key ? 'mg:help' : 'mg:home';
  if (['delivery', 'recover'].includes(action) && key && key !== 'a') return `mg:service:${key}`;
  if (['health', 'healthpage', 'metrics', 'delivery', 'recover'].includes(action))
    return primary ? 'mg:section:control' : 'mg:home';
  if (action === 'plan' || action === 'storage') return primary ? 'mg:section:platform' : 'mg:home';
  if (['addbot', 'addbotpage', 'reggrp', 'newgrp'].includes(action)) return primary ? 'mg:section:bots' : 'mg:home';
  return 'mg:home';
}

function isNavigation(item) {
  if (!item?.callback_data) return false;
  if (item.callback_data === 'mg:home') return true;
  if (item.callback_data === 'um:st:home') return true;
  return /^(?:←\s*)?(?:Назад(?:\s+к\s+.*)?|К сервису|К сервисам|К карточке|К результатам|К списку|Пользователи|Фильтры|Настройки сервиса|Отмена|Хранилище|Темы|Главное меню)$/.test(item.text || '');
}

function styleAction(item, screenText) {
  if (!item?.callback_data || item.style) return item;
  const label = String(item.text || '').replace(/^(?:🔴|🟢|⚠️|🗑️)\s*/u, '');
  const data = item.callback_data;
  const destructiveConfirmation = data.startsWith('mu:confirm:')
    && /^Подтвердите действие: (?:Заблокировать|Ограничить)(?:\s|$)/u.test(screenText);
  const danger = /^(?:Да,\s*)?(?:Удалить|Отключить|Выключить|Очистить|Приостановить|Заблокировать|Ограничить|Сбросить)(?:\s|$)/iu.test(label)
    || /^(?:Подтвердить (?:служебную )?очистку|Я удалил эту тему|Да, темы больше нет|Снять защиту)(?:\s|$)/u.test(label)
    || label === 'OFF' && data.startsWith('mg:attackconfirm:')
    || data.startsWith('um:st:arm:')
    || destructiveConfirmation;
  if (danger) return { ...item, style: 'danger' };
  const confirm = /^(?:Подтвердить|Применить|Сохранить|Да,)(?:\s|$)/u.test(label)
    || data.startsWith('br:connect:') || data.startsWith('mg:confirm:');
  return confirm ? { ...item, style: 'success' } : item;
}

export function managerScreenKeyboard(rows, { route = '', primary = false, root = false, screenText = '' } = {}) {
  if (root) return (rows || []).map(row => row.map(item => styleAction(item, screenText)));
  const actions = [];
  const exits = [];
  for (const [index, row] of (rows || []).entries()) {
    const remaining = [];
    for (const item of row) (index >= rows.length - 2 && isNavigation(item) ? exits : remaining)
      .push(styleAction(item, screenText));
    if (remaining.length) actions.push(remaining);
  }
  const explicit = exits.find(item => item.callback_data !== 'mg:home' && item.callback_data !== 'um:st:home');
  const parent = parentRoute(route, primary);
  const back = explicit?.callback_data || parent;
  return [...actions, [divider], [
    { ...button('← Назад', back), style: 'primary' },
    { ...button('🏠 Меню', 'mg:home'), style: 'primary' },
  ]];
}
