import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { renderWorkspace, workspaceBack, withNavigation, workspaceParent } from '../operator-workspace.js';
import { requestTelegram } from '../telegram-response.js';

for (const status of [429, 503]) test(`workspace respects normalized Telegram ${status} without sending a replacement`, async () => {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url)), calls = [];
  const source = {chat:{id:-1001234567890}, message_thread_id:1};
  const render = send => renderWorkspace({db, actor:7, source, route:'um:n:home', botId:'bot', text:'Screen', markup:{inline_keyboard:[]}, ru:false, send});
  try {
    await render(async () => ({ok:true, result:{message_id:100}}));
    const before = db.sqlite.prepare('SELECT * FROM operator_ui_sessions').get();
    const send = (method, body) => requestTelegram({token:'test', method, body, fetchImpl:async () => {
      calls.push(method);
      return Response.json({ok:false, error_code:status, description:'retry later', parameters:{retry_after:20}}, {status});
    }});
    await assert.rejects(render(send), /Workspace refresh deferred/);
    assert.deepEqual(calls, ['editMessageText']);
    assert.deepEqual(db.sqlite.prepare('SELECT * FROM operator_ui_sessions').get(), before);
  } finally {db.close();}
});

test('workspace repeated current callback skips unchanged text and buttons, but refreshes changed or other screens', async () => {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url)), calls = [];
  const source = {chat:{id:-1001234567890}, message_thread_id:1};
  const markup = {inline_keyboard:[[{text:'Mine', callback_data:'um:w:queue:a:mine:0'}]]};
  const render = (message, text='Screen', buttons=markup) => renderWorkspace({db, actor:7, source:message, route:'um:n:home', botId:'bot', text, markup:buttons, ru:false,
    send:async (method,body) => {calls.push({method,body}); return {ok:true,result:{message_id:100}};}});
  try {
    await render(source);
    const callback = {...source,message_id:100,text:'Screen',reply_markup:markup};
    await render(callback);
    assert.equal(calls.length,1,'no Telegram edit for a repeated unchanged callback');
    await render(callback,'Updated count');
    assert.equal(calls.at(-1).method,'editMessageText');
    await render(callback,'Screen',{inline_keyboard:[]});
    assert.equal(calls.length,3,'changed buttons must be published');
    await render({...callback,message_id:99});
    assert.equal(calls.length,4,'an older/other operator panel cannot suppress the current screen refresh');
    db.sqlite.prepare("UPDATE operator_ui_sessions SET route='um:n:system'").run();
    await render(callback);
    assert.equal(calls.length,5,'a callback snapshot must match the current route');
  } finally {db.close();}
});

test('workspace navigation follows parents while retaining the latest list filter and page',async()=>{
  const db=new SqliteD1(new URL('../migrations/',import.meta.url)),calls=[];
  const source={chat:{id:-1001234567890},message_thread_id:1};
  const render=route=>renderWorkspace({db,actor:7,source,route,botId:'bot',text:'Screen',markup:{inline_keyboard:[]},ru:false,send:async(method,body)=>{calls.push(body);return {ok:true,result:{message_id:100}};}});
  try {
    await render('um:n:home');
    assert.deepEqual(calls.at(-1).reply_markup.inline_keyboard,[]);
    await render('um:w:queue:a:needs:0');
    await render('um:w:queue:a:needs:1');
    await render('um:w:queue:a:mine:1');
    assert.deepEqual(JSON.parse(db.sqlite.prepare('SELECT history_json FROM operator_ui_sessions').get().history_json),['um:n:home']);
    await render('um:w:card:abc:12');
    assert.equal(await workspaceBack(db,7,source),'um:w:queue:a:mine:1');
    await render('um:w:queue:a:mine:1');
    assert.equal(await workspaceBack(db,7,source),'um:n:home');
    await render('um:w:more:abc:12');
    await render('um:g:card:abc:12');
    await render('um:g:card:abc:12');
    assert.equal(await workspaceBack(db,7,source),'um:w:more:abc:12');
    assert.equal(workspaceParent('um:w:snooze:abc:12',null),'um:w:card:abc:12');
    await render('um:n:home');
    await render('um:w:pause');
    assert.equal(calls.at(-1).reply_markup.inline_keyboard.flat().filter(b=>b.callback_data==='um:n:home').length,1,'a transient notice at root still has an exit');
  } finally {db.close();}
});

test('root navigation has no duplicate exits, and internal prompts retain an exit even at root',()=>{
  const root={inline_keyboard:[[{text:'← Back',callback_data:'um:w:back'}],[{text:'Main menu',callback_data:'um:n:home'}]]};
  assert.deepEqual(withNavigation(root,false,1,'um:n:home').inline_keyboard,[]);
  const prompt={inline_keyboard:[[{text:'Cancel',callback_data:'um:w:notecancel:nonce'}]]};
  const buttons=withNavigation(prompt,false,1,'um:n:home','um:n:home').inline_keyboard.flat();
  assert.ok(buttons.some(b=>b.callback_data==='um:w:pause'));
  assert.equal(buttons.filter(b=>b.callback_data==='um:n:home').length,1);
  const recovery={inline_keyboard:[[{text:'Refresh panel',callback_data:'um:tp:refresh'}]]};
  assert.deepEqual(withNavigation(recovery,false,42,'um:tp:refresh'),recovery,'root cleanup must retain recovery actions');
});

for (const kind of ['m', 'o', 'pa', 'w']) test(`workspace ${kind} prompt keeps subsequent navigation in the visible window`, async () => {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url)), calls = [];
  const source = {chat:{id:-1001234567890}, message_thread_id:1};
  let nextId = 100;
  const render = (message, markup={inline_keyboard:[]}) => renderWorkspace({db, actor:7, source:message,
    route:'um:n:home', botId:'bot', text:'Screen', markup, ru:false,
    send:async (method, body) => {calls.push({method,body});return {ok:true,result:{message_id:body.message_id || ++nextId}};}});
  try {
    await render(source);
    const menuId = nextId;
    const action = kind === 'w' ? 'notecancel' : 'cancel';
    await render(source, {inline_keyboard:[[{text:'Cancel',callback_data:`um:${kind}:${action}:nonce`}]]});
    const promptId = nextId;
    assert.notEqual(promptId, menuId, 'input keeps its own message and internal reply identity');
    await render({...source, message_id:promptId});
    assert.equal(calls.at(-1).method, 'editMessageText');
    assert.equal(calls.at(-1).body.message_id, promptId, 'navigation must update the clicked lower window');
    assert.equal(db.sqlite.prepare('SELECT message_id FROM operator_ui_sessions').get().message_id, promptId);
    assert.equal(db.sqlite.prepare('SELECT kind FROM operator_input_prompts WHERE message_id=?').get(promptId).kind, kind,
      'late replies remain internal after changing the visible content');
  } finally {db.close();}
});

test('workspace recovers an existing prompt while preserving another operator panel and the shared pin', async () => {
  const db = new SqliteD1(new URL('../migrations/', import.meta.url)), calls = [];
  const source = {chat:{id:-1001234567890}, message_thread_id:1};
  const render = id => renderWorkspace({db, actor:7, source:{...source,message_id:id}, route:'um:n:home',
    botId:'bot', text:'Result', markup:{inline_keyboard:[]}, ru:false,
    send:async (method,body) => {calls.push({method,body});return {ok:true,result:{message_id:body.message_id || 100}};}});
  try {
    await render(1);
    db.sqlite.prepare("INSERT INTO operator_input_prompts VALUES(?,?,?,'m','old-flow',?)")
      .run(source.chat.id, 318, 7, new Date().toISOString());
    db.sqlite.prepare("INSERT INTO operator_input_prompts VALUES(?,?,?,'m','other-flow',?)")
      .run(source.chat.id, 319, 8, new Date().toISOString());
    await render(318);
    assert.equal(calls.at(-1).body.message_id, 318, 'existing pre-fix prompt takes over from the old menu');
    await render(319);
    assert.equal(calls.at(-1).body.message_id, 318, 'another operator prompt is not overwritten');
    await render(307);
    assert.equal(calls.at(-1).body.message_id, 318, 'shared pin remains outside the operator edit target');
  } finally {db.close();}
});
