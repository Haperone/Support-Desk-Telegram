// UI state is scoped to an operator and a topic; shared pinned cards stay shared.
const now = () => new Date().toISOString();
const one = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
export const workspaceThread = message => Number(message?.message_thread_id || 1);
export const topicLink = (group, thread, message = null) => /^-100\d+$/.test(String(group)) && Number(thread) > 1
  ? `https://t.me/c/${String(group).slice(4)}/${thread}${message ? '/' + message : ''}` : null;

export async function workspaceSession(db, actor, message) {
  return one(db, 'SELECT * FROM operator_ui_sessions WHERE operator_id=? AND chat_id=? AND thread_id=?', actor, message.chat.id, workspaceThread(message));
}
export function internalPrompt(markup) {
  for (const b of markup?.inline_keyboard?.flat() || []) {
    const match = /^um:(pa|o|m|w):(cancel|confirm|save|revise|noteconfirm|notecancel):([^:]+)$/.exec(b.callback_data || '');
    if (match) return { kind: match[1], nonce: match[3] };
  }
  return null;
}
export async function rememberInternalPrompt(db, message, actor, markup) {
  const prompt = internalPrompt(markup);
  if (!prompt || !message?.message_id) return;
  await run(db, 'INSERT INTO operator_input_prompts(chat_id,message_id,operator_id,kind,nonce,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id,message_id) DO UPDATE SET operator_id=excluded.operator_id,kind=excluded.kind,nonce=excluded.nonce', message.chat.id, message.message_id, actor, prompt.kind, prompt.nonce, now());
}
export async function repliedInternalPrompt(db, message) {
  if (!message.reply_to_message?.message_id) return null;
  const saved = await one(db, 'SELECT * FROM operator_input_prompts WHERE chat_id=? AND message_id=?', message.chat.id, message.reply_to_message.message_id);
  if (saved) return saved;
  // Telegram may have accepted a prompt before its receipt could be saved in D1.
  // Its own bot-authored keyboard still proves that a reply is internal.
  const prompt = message.reply_to_message.from?.is_bot && internalPrompt(message.reply_to_message.reply_markup);
  return prompt ? {...prompt, operator_id:null} : null;
}
const navigationCopy = {
  en: { pause:'Pause input',back:'← Back',home:'Main menu',case:'Conversation' },
  ru: { pause:'Отложить ввод',back:'← Назад',home:'Главное меню',case:'К обращению' },
  es: { pause:'Pausar entrada',back:'← Atrás',home:'Menú principal',case:'Conversación' },
  zh: { pause:'暂停输入',back:'← 返回',home:'主菜单',case:'会话' },
};
export function withNavigation(markup, ru, thread = 1, route = null, parent = null) {
  const locale = ru === true ? 'ru' : ru === false ? 'en' : ru;
  const copy = navigationCopy[locale] || navigationCopy.en;
  const root=thread===1?'um:n:home':'um:tp:refresh';
  const rows = (markup?.inline_keyboard || []).map(row=>row.filter(b=>!/^←\s+/.test(b.text)&&(b.callback_data!==root||/^(?:🔄\s*)?(?:Обновить|Refresh|Actualizar|刷新)/i.test(b.text))&&b.callback_data!=='um:w:back')).filter(row=>row.length);
  if (internalPrompt(markup)) rows.push([{text:copy.pause,callback_data:'um:w:pause'}]);
  if(route===root&&!internalPrompt(markup))return {inline_keyboard:rows};
  const back=parent||root;
  if(!rows.flat().some(b=>b.callback_data===back||b.callback_data==='um:w:results')) rows.push([{text:copy.back,callback_data:back}]);
  if(back!==root)rows.push([{text:thread===1?copy.home:copy.case,callback_data:root}]);
  return {inline_keyboard:rows};
}
function safeRoute(route) {
  return /^um:(?:n:(?:home|bots|bot|system|settings|help|check)|g:(?:home|bots|bot|list|card|audit|uaudit)|tp:(?:refresh|info|manage|audit|risk)|r:(?:home|bots)|s:(?:home|colors|icons)|d:home|m:(?:home|view)|o:(?:home|card|primary)|dl:(?:home|issues)|w:(?:queue|queuebots|searchresults|resume|ready|problems|card|more|snooze))(?::|$)/.test(route || '') ? route : null;
}
// Back follows the screen hierarchy. Filters and pages are state of one list.
export function workspaceParent(route, listRoute, thread = 1) {
  const root=thread===1?'um:n:home':'um:tp:refresh',p=String(route||root).split(':'),[,section,action,key,user]=p;
  if(route===root)return root;
  if(section==='w') {
    if(['more','snooze'].includes(action))return `um:w:card:${key}:${user}`;
    if(action==='card')return listRoute||'um:w:queue:a:needs:0';
    if(action==='queuebots')return listRoute?.startsWith('um:w:queue:')?listRoute:'um:w:queue:a:needs:0';
    if(action==='problems')return Number(user)>0?`um:w:card:${key}:${user}`:'um:n:system';
    if(action==='ready')return p[4]==='details'?`um:w:ready:${key}`:key&&key!=='a'?`um:n:bot:${key}`:'um:n:system';
    return root;
  }
  if(section==='g') {
    if(action==='card')return listRoute||`um:g:list:${key}:x:0`;
    if(action==='uaudit')return `um:g:card:${key}:${user}`;
    if(action==='audit')return 'um:n:system';
    if(action==='list')return `um:g:home:${key}`;
    if(action==='home'&&key!=='a')return 'um:g:home:a';
    return root;
  }
  if(section==='n') {
    if(action==='bot')return 'um:n:bots';
    if(['settings','check'].includes(action))return 'um:n:system';
    if(action==='help'&&key)return 'um:n:help';
    return root;
  }
  if(section==='tp')return root;
  if(section==='o')return action==='home'?root:'um:o:home:0';
  if(['d','dl'].includes(section))return 'um:n:system';
  if(['r','s','m'].includes(section)) {
    if(!['home','bots'].includes(action))return `um:${section}:home:${key||'a'}`;
    return key&&key!=='a'?`um:n:bot:${key}`:'um:n:settings';
  }
  return root;
}
function savedParent(session) {
  try {const parents=JSON.parse(session?.history_json||'[]');return parents.length===1?safeRoute(parents[0]):null;}catch{return null;}
}
function contextualParent(route,session,listRoute,thread) {
  if(route===session?.route&&savedParent(session))return savedParent(session);
  const card=/^um:g:card:([^:]+):([^:]+)$/.exec(route);
  if(card&&[`um:w:more:${card[1]}:${card[2]}`,`um:w:card:${card[1]}:${card[2]}`].includes(session?.route))return session.route;
  // A service check is reachable both from System and from a service card.
  if(/^um:w:ready:[^:]+$/.test(route)&&['um:n:check','um:w:ready:a'].includes(session?.route))return 'um:n:check';
  return workspaceParent(route,listRoute,thread);
}

export async function renderWorkspace({db, actor, source, route, botId, text, markup, ru, locale, send, checkpoint, visible = () => true}) {
  route = safeRoute(route);
  const thread = workspaceThread(source);
  // Old prompts remain clickable after a flow is saved/cancelled. Resolve their
  // owner together with the session so the result stays in the clicked window,
  // including prompts created before they became the current session target.
  const session = await one(db, `SELECT s.*, p.message_id AS source_prompt_id
    FROM (SELECT ? operator_id, ? chat_id, ? thread_id) scope
    LEFT JOIN operator_ui_sessions s USING(operator_id,chat_id,thread_id)
    LEFT JOIN operator_input_prompts p ON p.operator_id=scope.operator_id
      AND p.chat_id=scope.chat_id AND p.message_id=?`, actor, source.chat.id, thread, source.message_id || 0);
  const targetMessageId = session.source_prompt_id || (session.bot_id===botId ? session.message_id : null);
  const nextRoute = route || session?.route || (thread===1?'um:n:home':'um:tp:refresh');
  const listRoute = /^um:(?:g:list|w:queue|w:searchresults):/.test(nextRoute) ? nextRoute : session?.list_route || null;
  const prompt = internalPrompt(markup);
  const candidate=prompt?nextRoute:contextualParent(nextRoute,session,listRoute,thread);
  const parent=visible(candidate)?candidate:(thread===1?'um:n:home':'um:tp:refresh');
  const history=parent===nextRoute?[]:[parent];
  markup={inline_keyboard:(markup?.inline_keyboard||[]).map(row=>row.filter(b=>!b.callback_data||visible(b.callback_data))).filter(row=>row.length)};
  // Each prompt starts in a distinct message. Its durable tombstone keeps replies
  // internal even after this message becomes the visible navigation/result screen.
  const body = {chat_id:source.chat.id,text,reply_markup:withNavigation(markup,locale || ru,thread,route?nextRoute:null,parent)};
  checkpoint?.(prompt ? 3 : 2);
  let result;
  if (!prompt && targetMessageId) {
    const unchanged = source.message_id===targetMessageId && session.route===nextRoute
      && source.text===body.text && JSON.stringify(source.reply_markup)===JSON.stringify(body.reply_markup);
    result=unchanged?{ok:true,result:{message_id:targetMessageId}}:await send('editMessageText',{...body,message_id:targetMessageId});
    if (!result.ok && /message is not modified/i.test(result.description||'')) result={ok:true,result:{message_id:targetMessageId}};
    else if (result.ok) result={...result,result:{...result.result,message_id:targetMessageId}};
    else if (result.retryable || result.deferred || result.deliveryUncertain) throw new Error(`Workspace refresh deferred: ${result.description || 'Telegram retry required'}`);
  }
  if (!result?.ok) result=await send('sendMessage',{...body,...(thread>1?{message_thread_id:thread}:{})});
  if (!result.ok) throw new Error(`Workspace delivery not confirmed: ${result.description || 'Telegram delivery failed'}`);
  const id=Number(result.result?.message_id);
  if (!Number.isSafeInteger(id)||id<=0) throw new Error('Workspace has no message id');
  if (prompt) await rememberInternalPrompt(db,{chat:source.chat,message_id:id},actor,markup);
  await run(db, `INSERT INTO operator_ui_sessions(operator_id,chat_id,thread_id,bot_id,message_id,route,history_json,list_route,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(operator_id,chat_id,thread_id) DO UPDATE SET bot_id=excluded.bot_id,message_id=excluded.message_id,route=excluded.route,history_json=excluded.history_json,list_route=excluded.list_route,updated_at=excluded.updated_at`,actor,source.chat.id,thread,botId,id,nextRoute,JSON.stringify(history),listRoute,now());
  return result;
}

export async function workspaceBack(db, actor, source) {
  const session=await workspaceSession(db,actor,source);
  const route=savedParent(session)||workspaceParent(session?.route,session?.list_route,workspaceThread(source));
  await run(db,'UPDATE operator_ui_sessions SET route=?,history_json=? WHERE operator_id=? AND chat_id=? AND thread_id=?',route,'[]',actor,source.chat.id,workspaceThread(source));
  return route;
}
