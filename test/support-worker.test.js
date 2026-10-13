import test from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
const recoveryQueryScope = new AsyncLocalStorage();
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createControlPlaneWorker } from "../src/control-plane-worker.js";
import { createRegistrationWorker } from '../src/bot-onboarding.js';
import { registeredConfig, sealCredentials, withBotRegistry } from '../src/bot-registry.js';
import { registerSupportGroup, commitGroupCutover } from '../src/service-groups.js';
import { stalledJsonResponse } from "./helpers/stalled-response.js";
import { assertD1CompoundSelectLimit } from './helpers/d1-sql-limits.js';
import { createWebhookDatabase, resolveInvocationDatabase } from "../src/recovery-budget.js";
import { beginManualDelivery, executeManualDelivery, inspectManualDelivery, manualDeliveryStatus, stepManualDelivery, manualDeliveryText } from '../src/manual-delivery.js';
import worker, {
  extractAlbumMedia,
  normalizeForAbuseText,
  storedAlbumInputMedia,
  formatInfo,
  getWebhookBotId,
  isAlreadyTopicState,
  isMissingTopicError,
  isOwnedByBot,
  managementBotKey,
  managementBotFromKey,
  parseAdminIds,
  parseBotRegistry,
  parseRestrictionDuration,
  timingSafeEqual,
  topicTitle,
  publishManualDelivery,
  runManualDeliveryTarget,
  syncVerificationNotice,
  supportCommandList,
} from "../src/worker.js";

test('support command descriptions include Spanish and Simplified Chinese and default to English', () => {
  const locales = ['ru', 'en', 'es', 'zh'].map(locale => supportCommandList(locale).find(command => command.command === 'help').description);
  assert.match(locales[0], /пользоваться поддержкой/i);
  assert.equal(locales[1], 'How to use support');
  assert.equal(locales[2], 'Cómo usar el soporte');
  assert.equal(locales[3], '如何使用支持服务');
  assert.equal(supportCommandList().find(command => command.command === 'help').description, 'How to use support');
});

const migrationDirectory = new URL("../migrations/", import.meta.url);

test('/delete removes a confirmed customer copy before the operator original through Free ingress', async t => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    Object.assign(env, { RECOVERY_D1_PLAN: 'free', TELEGRAM_COOLDOWN_ENABLED: 'true',
      OPERATIONAL_HEALTH_ENABLED: 'true', RETENTION_ENABLED: 'true', STORAGE_GUARD_ENABLED: 'true',
      MANAGER_BOT_TOKEN: 'manager-token', MANAGER_BOT_USERNAME: 'manager_bot' });
    seedConversation(db, 'folder-links', 88001, 81);
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const send = update => countedFreeFetch(ingress, webhookRequest('folder-links', 'secret-a', update), env);
    const original = groupUpdate(880001, 81, 'Answer');
    assert.equal((await send(original)).status, 200);
    const mapping = db.get('SELECT * FROM message_mappings WHERE support_message_id=?', original.message.message_id);
    assert.ok(mapping?.user_message_id);
    const command = groupUpdate(880002, 81, '/delete@FolderLinksSupportBot');
    command.message.reply_to_message = original.message;
    const scope = { queries: 0, limit: 50 };
    const before = calls.length;
    assert.equal((await recoveryQueryScope.run(scope, () => ingress.fetch(webhookRequest('folder-links', 'secret-a', command), env))).status, 200);
    assert.ok(scope.queries <= 50);
    t.diagnostic(`Free deletion: ${scope.queries} D1 statements and ${calls.length - before} Telegram requests`);
    assert.deepEqual(calls.filter(c => c.method === 'deleteMessage').map(c => c.body), [
      { chat_id: 88001, message_id: mapping.user_message_id },
      { chat_id: Number(env.SUPPORT_GROUP_ID), message_id: original.message.message_id },
    ]);
    assert.ok(calls.some(c => c.method === 'sendMessage' && /Message deleted for the customer and in the topic/.test(c.body.text)));
    assert.equal(db.get("SELECT result FROM operator_audit WHERE action='message_delete'").result, 'success');
    assert.equal(db.get('SELECT COUNT(*) n FROM telegram_cleanup_jobs').n, 0);
    assert.equal((await send(command)).status, 200);
    assert.equal(calls.filter(c => c.method === 'deleteMessage').length, 2, 'webhook replay is deduplicated');
    assert.equal(calls.filter(c => c.method === 'copyMessage').length, 1, 'command is never delivered to the customer');
  });
});

test('/delete requires an own delivered reply in the current topic and an authorized operator', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, 'folder-links', 88002, 82);
    db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',88002,82,100,200,?)", new Date().toISOString());
    const cases = [null, { message_id: 200, from: { id: 8 } },
      { message_id: 200, from: { id: 7, is_bot: true } },
      { message_id: 200, from: { id: 7 }, sender_chat: { id: -1001234567890 } },
      { message_id: 200, from: { id: 7 }, message_thread_id: 83 },
      { message_id: 201, from: { id: 7 } }];
    let id = 880010;
    for (const reply of cases) {
      const command = groupUpdate(id++, 82, '/delete');
      if (reply) command.message.reply_to_message = reply;
      assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', command), env)).status, 200);
    }
    const unauthorized = groupUpdate(id++, 82, '/delete', 8);
    unauthorized.message.reply_to_message = { message_id: 200, from: { id: 8 } };
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', unauthorized), env)).status, 200);
    assert.equal(calls.filter(c => ['deleteMessage', 'copyMessage'].includes(c.method)).length, 0);
    assert.ok(calls.some(c => c.body.text?.includes('No confirmed customer copy')));
  });
});

for (const code of [400, 429, 503]) {
  test(`/delete keeps the original when customer deletion is unconfirmed (${code})`, async () => {
    await withFixture(call => call.method === 'deleteMessage' && call.body.chat_id === 88003
      ? { ok: false, error_code: code, description: code === 400 ? "Bad Request: message can't be deleted" : 'Temporary failure',
        ...(code === 429 ? { parameters: { retry_after: 1 } } : {}) } : null,
    async ({ env, db, calls }) => {
      env.TELEGRAM_COOLDOWN_ENABLED = 'true';
      seedConversation(db, 'folder-links', 88003, 83);
      db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',88003,83,101,201,?)", new Date().toISOString());
      const command = groupUpdate(880030 + code, 83, '/delete');
      command.message.reply_to_message = { message_id: 201, from: { id: 7 } };
      assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', command), env)).status, code === 429 ? 500 : 200);
      assert.deepEqual(calls.filter(c => c.method === 'deleteMessage').map(c => c.body.chat_id), [88003]);
      assert.equal(db.get('SELECT COUNT(*) n FROM telegram_cleanup_jobs').n, 0, 'no delayed deletion outside the operator fence');
      assert.equal(db.get("SELECT COUNT(*) n FROM operator_audit WHERE action='message_delete' AND result='success'").n, 0);
      if (code !== 429) assert.ok(calls.some(c => c.body.text?.includes('Deletion for the customer was not confirmed')));
    });
  });
}

test('/delete reports partial deletion and safely retries an already missing customer copy', async () => {
  let retry = false;
  await withFixture(call => {
    if (call.method !== 'deleteMessage') return null;
    if (retry && call.body.chat_id === 88004) return { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' };
    if (!retry && call.body.chat_id < 0) return { ok: false, error_code: 403, description: 'Forbidden: no delete rights' };
  }, async ({ env, db, calls }) => {
    seedConversation(db, 'folder-links', 88004, 84);
    db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',88004,84,102,202,?)", new Date().toISOString());
    const command = groupUpdate(880040, 84, '/delete');
    command.message.reply_to_message = { message_id: 202, from: { id: 7 } };
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', command), env)).status, 200);
    assert.ok(calls.some(c => c.body.text?.includes('deletion of the topic original was not confirmed')));
    assert.equal(db.get("SELECT result FROM operator_audit WHERE action='message_delete'").result, 'partial');
    retry = true;
    command.update_id++; command.message.message_id++;
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', command), env)).status, 200);
    assert.ok(calls.some(c => c.body.text?.includes('Message deleted for the customer and in the topic')));
    assert.equal(db.get("SELECT result FROM operator_audit WHERE action='message_delete' ORDER BY id DESC LIMIT 1").result, 'success');
    assert.equal(db.get('SELECT COUNT(*) n FROM message_mappings').n, 1);
  });
});

test('/delete retries a lost confirmation without duplicating its audit', async () => {
  let failNotice = true;
  await withFixture(call => call.method === 'sendMessage' && call.body.text?.includes('Message deleted for the customer') && failNotice
    ? { ok: false, error_code: 503, description: 'Temporary failure' } : null,
  async ({ env, db, calls, fetchMock }) => {
    seedConversation(db, 'folder-links', 88005, 85);
    db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',88005,85,103,203,?)", new Date().toISOString());
    const command = groupUpdate(880050, 85, '/delete');
    command.message.reply_to_message = { message_id: 203, from: { id: 7 } };
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const send = () => countedFreeFetch(ingress, webhookRequest('folder-links', 'secret-a', command), env);
    assert.equal((await send()).status, 500);
    failNotice = false;
    assert.equal((await send()).status, 200);
    assert.equal(db.get("SELECT COUNT(*) n FROM operator_audit WHERE action='message_delete'").n, 1);
    assert.equal(db.get('SELECT COUNT(*) n FROM support_operator_execution_locks').n, 0);
    assert.equal(calls.filter(c => c.method === 'copyMessage').length, 0);
  });
});

test('/delete does not treat an uncertain not-found response as confirmed deletion', async () => {
  await withFixture(call => call.method === 'deleteMessage'
    ? { ok: false, error_code: 503, description: 'message to delete not found' } : null,
  async ({ env, db, calls }) => {
    seedConversation(db, 'folder-links', 88006, 86);
    db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',88006,86,104,204,?)", new Date().toISOString());
    const command = groupUpdate(880060, 86, '/delete');
    command.message.reply_to_message = { message_id: 204, from: { id: 7 } };
    assert.equal((await countedFreeFetch(worker, webhookRequest('folder-links', 'secret-a', command), env)).status, 200);
    assert.deepEqual(calls.filter(c => c.method === 'deleteMessage').map(c => c.body.chat_id), [88006]);
    assert.equal(db.get("SELECT COUNT(*) n FROM operator_audit WHERE action='message_delete'").n, 0);
  });
});

test('/delete without a username is owned by one service and benign retries do not report outages', async () => {
  await withFixture(call => call.method === 'deleteMessage'
    ? { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' } : null,
  async ({ env, db, calls, fetchMock }) => {
    Object.assign(env, { RECOVERY_D1_PLAN: 'free', TELEGRAM_COOLDOWN_ENABLED: 'true',
      OPERATIONAL_HEALTH_ENABLED: 'true', MANAGER_BOT_TOKEN: 'manager-token', MANAGER_BOT_USERNAME: 'manager_bot' });
    seedConversation(db, 'folder-links', 88011, 92);
    db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',88011,92,110,210,?)", new Date().toISOString());
    const command = groupUpdate(880110, 92, '/delete');
    command.message.reply_to_message = { message_id: 210, from: { id: 7 } };
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    assert.equal((await countedFreeFetch(ingress, webhookRequest('folder-links', 'secret-a', command), env)).status, 200);
    assert.equal((await countedFreeFetch(ingress, webhookRequest('image-compress', 'secret-b', command), env)).status, 200);
    assert.equal(calls.filter(c => c.method === 'deleteMessage').length, 2);
    assert.equal(db.get("SELECT result FROM operator_audit WHERE action='message_delete'").result, 'success');
    assert.equal(db.get('SELECT COUNT(*) n FROM operational_signals').n, 0);
    assert.equal(db.get("SELECT COUNT(*) n FROM statistics_facts WHERE kind='telegram'").n, 0);
  });
});

for (const failure of ['timeout', 'invalid-json', 'lost-fence']) {
  test(`/delete preserves the topic original after ${failure}`, async () => {
    await withFixture(null, async ({ env, db, calls, fetchMock }) => {
      Object.assign(env, { RECOVERY_D1_PLAN: 'free', TELEGRAM_TIMEOUT_MS: '20', TELEGRAM_COOLDOWN_ENABLED: 'true' });
      seedConversation(db, 'folder-links', 88008, 88);
      db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',88008,88,106,206,?)", new Date().toISOString());
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/deleteMessage')) {
          const body = JSON.parse(init.body);
          calls.push({ method: 'deleteMessage', body });
          if (failure === 'timeout') return stalledJsonResponse(init.signal);
          if (failure === 'invalid-json') return new Response('not-json', { status: 200 });
          db.run("UPDATE support_operator_execution_locks SET owner_token='other-owner'");
          return new Response(JSON.stringify({ ok: true, result: true }));
        }
        return fetchMock(url, init);
      };
      const command = groupUpdate(880080, 88, '/delete');
      command.message.reply_to_message = { message_id: 206, from: { id: 7 } };
      const response = await countedFreeFetch(worker, webhookRequest('folder-links', 'secret-a', command), env);
      assert.equal(response.status, failure === 'lost-fence' ? 500 : 200);
      assert.deepEqual(calls.filter(c => c.method === 'deleteMessage').map(c => c.body.chat_id), [88008]);
      assert.equal(db.get("SELECT COUNT(*) n FROM operator_audit WHERE action='message_delete'").n, 0);
      assert.equal(db.get('SELECT COUNT(*) n FROM telegram_cleanup_jobs').n, 0);
    });
  });
}

test('/delete selects only the replied album item and fences off a replaced topic mapping', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, 'folder-links', 88009, 89);
    for (const [customer, original] of [[107, 207], [108, 208]]) {
      db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',88009,89,?,?,?)", customer, original, new Date().toISOString());
    }
    const command = groupUpdate(880090, 89, '/delete');
    command.message.reply_to_message = { message_id: 207, from: { id: 7 }, media_group_id: 'album' };
    assert.equal((await countedFreeFetch(worker, webhookRequest('folder-links', 'secret-a', command), env)).status, 200);
    assert.deepEqual(calls.filter(c => c.method === 'deleteMessage').map(c => c.body.message_id), [107, 207]);
    db.run("UPDATE conversations SET thread_id=90 WHERE user_id=88009");
    command.update_id++; command.message.message_id++; command.message.message_thread_id=90;
    assert.equal((await countedFreeFetch(worker, webhookRequest('folder-links', 'secret-a', command), env)).status, 200);
    assert.equal(calls.filter(c => c.method === 'deleteMessage').length, 2);
  });
});

for (const [plan, total] of [['free', 50], ['paid', 1000]]) {
  test(`${plan} /delete preserves its audit budget during slow requests and heartbeats`, async () => {
    await withFixture(async call => {
      if (call.method === 'deleteMessage') await new Promise(resolve => setTimeout(resolve, 160));
    }, async ({ env, db, fetchMock }) => {
      Object.assign(env, { RECOVERY_D1_PLAN: plan, OPERATOR_EXECUTION_RENEW_MS: '20',
        TELEGRAM_COOLDOWN_ENABLED: 'true', OPERATIONAL_HEALTH_ENABLED: 'true' });
      seedConversation(db, 'folder-links', 88010, 91);
      db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',88010,91,109,209,?)", new Date().toISOString());
      const command = groupUpdate(880100, 91, '/delete');
      command.message.reply_to_message = { message_id: 209, from: { id: 7 } };
      const ingress = createControlPlaneWorker(undefined, fetchMock);
      const scope = { queries: 0, sqls: [], limit: total };
      const budget = createWebhookDatabase(db, plan);
      Object.assign(budget, { telegramCooldownEnabled: true, telegramCooldowns: {} });
      assert.equal((await recoveryQueryScope.run(scope, async () => {
        const work = plan === 'free' ? 44 : 990;
        for (let index = 0; index < work - 24; index++) await budget.prepare('SELECT 1').all();
        return ingress.fetch(webhookRequest('folder-links', 'secret-a', command), { ...env, SUPPORT_DB: budget });
      })).status, 200);
      assert.ok(scope.queries <= total);
      assert.ok(scope.sqls.filter(sql => sql.startsWith('UPDATE support_operator_execution_locks SET lease_expires_at')).length > 2);
      assert.equal(db.get("SELECT result FROM operator_audit WHERE action='message_delete'").result, 'success');
      assert.equal(db.get('SELECT COUNT(*) n FROM support_operator_execution_locks').n, 0);
    });
  });
}

test('new topics, native reopening and conversation cards retain the deletion warning', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: 'ru' }]);
    await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(880050, 88005)), env);
    const conversation = db.get('SELECT * FROM conversations WHERE user_id=88005');
    const panel = calls.find(c => c.method === 'sendMessage' && c.body.message_thread_id === conversation.thread_id);
    assert.match(panel.body.text, /^⚠️ Обычное удаление/);
    assert.match(panel.body.text, /\/delete@FolderLinksSupportBot/);
    assert.ok(calls.some(c => c.method === 'pinChatMessage' && c.body.message_id === conversation.panel_message_id));
    const reopened = groupUpdate(880051, conversation.thread_id, '');
    reopened.message.forum_topic_reopened = {};
    await worker.fetch(webhookRequest('folder-links', 'secret-a', reopened), env);
    assert.ok(calls.some(c => c.method === 'editMessageText' && c.body.message_id === conversation.panel_message_id && c.body.text.includes('Обычное удаление')));
    await worker.fetch(webhookRequest('folder-links', 'secret-a', groupUpdate(880052, conversation.thread_id, '/menu')), env);
    assert.match(calls.filter(c => c.method === 'editMessageText').at(-1).body.text, /\/delete/);
  });
});

test('confirmed customer delivery sends one manager DM and records its Telegram receipt', async () => {
  await withFixture(null, async ({env,db,calls}) => {
    env.MANAGER_BOT_TOKEN='manager-token';
    env.BOT_REGISTRY=JSON.stringify([{...registryValue[0],locale:'ru'}]);
    const update=privateUpdate(882001,882);
    assert.equal((await worker.fetch(webhookRequest('folder-links','secret-a',update),env)).status,200);
    const notices=calls.filter(call=>call.token==='manager-token'&&call.method==='sendMessage');
    assert.equal(notices.length,1);
    assert.equal(notices[0].body.chat_id,7);
    assert.match(notices[0].body.text,/New conversation/);
    assert.ok(notices[0].body.reply_markup.inline_keyboard[0][0].url.includes('/'));
    const receipt=db.get("SELECT status,telegram_message_id FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=882");
    assert.equal(receipt.status,'sent'); assert.ok(receipt.telegram_message_id>0);
    assert.equal((await worker.fetch(webhookRequest('folder-links','secret-a',update),env)).status,200);
    assert.equal(calls.filter(call=>call.token==='manager-token'&&call.method==='sendMessage').length,1);
  });
});

test('Free first contact remains delivered when manager Telegram fails, and Cron keeps the uncertain notice', async (t) => {
  await withFixture(call=>call.token==='manager-token'&&call.method==='sendMessage'
    ? {ok:false,error_code:503,description:'upstream unavailable',httpStatus:503}:null, async ({env,db,calls}) => {
    env.MANAGER_BOT_TOKEN='manager-token';
    env.BOT_REGISTRY=JSON.stringify([registryValue[0]]);
    env.RECOVERY_D1_PLAN='free';
    const scope={queries:0};
    const response=await recoveryQueryScope.run(scope,()=>worker.fetch(webhookRequest('folder-links','secret-a',privateUpdate(882101,883)),env));
    assert.equal(response.status,200);
    assert.ok(scope.queries<=50,`Free webhook used ${scope.queries} D1 statements`);
    assert.equal(calls.filter(call=>call.method==='forwardMessage'&&call.body.from_chat_id===883).length,1);
    assert.equal(db.get("SELECT COUNT(*) n FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=883").n,0,
      'Free webhook defers optional notice work after delivery');
    let maxCron=0;
    for(let i=0;i<20;i++) maxCron=Math.max(maxCron,await runCountedRecovery({},env));
    const notice=db.get("SELECT status FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=883");
    assert.equal(notice.status,'uncertain');
    assert.equal(calls.filter(call=>call.token==='manager-token'&&call.method==='sendMessage').length,1);
    t.diagnostic(`Free first-contact D1 statements: ${scope.queries}; highest Cron invocation: ${maxCron}`);
  });
});

test('service group cutover preserves the old topic and routes returning users to a new one', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const oldGroup = Number(env.SUPPORT_GROUP_ID);
    const newGroup = -1009876543210;
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(881001, 881)), env)).status, 200);
    const oldTopic = db.get("SELECT * FROM conversations WHERE bot_id='folder-links' AND user_id=881");
    assert.equal(Number(oldTopic.support_group_id), oldGroup);

    await registerSupportGroup(db, newGroup, { forumVerifiedAt: new Date().toISOString() });
    await commitGroupCutover(db, 'folder-links', newGroup, null);
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(881002, 881)), env)).status, 200);
    const active = db.get("SELECT * FROM conversations WHERE bot_id='folder-links' AND user_id=881");
    const history = db.get('SELECT * FROM service_topic_history WHERE conversation_id=?', oldTopic.id);
    assert.equal(Number(active.support_group_id), newGroup);
    assert.notEqual(active.id, oldTopic.id);
    assert.equal(Number(history.support_group_id), oldGroup);
    assert.equal(Number(history.replacement_thread_id), active.thread_id);
    assert.deepEqual(calls.filter(call => call.method === 'createForumTopic').map(call => call.body.chat_id), [oldGroup, newGroup]);
    assert.deepEqual(calls.filter(call => call.method === 'forwardMessage' && call.body.from_chat_id === 881).map(call => call.body.chat_id), [oldGroup, newGroup]);

    const oldReply = groupUpdate(881003, oldTopic.thread_id, 'Old topic reply');
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', oldReply), env)).status, 200);
    assert.equal(calls.some(call => call.method === 'copyMessage' && call.body.message_id === oldReply.message.message_id), false);
    assert.ok(calls.some(call => call.method === 'sendMessage' && Number(call.body.chat_id) === oldGroup && call.body.message_thread_id === oldTopic.thread_id && /archived|архивная/.test(call.body.text)));
    const oldButton = callbackUpdate(881005, oldTopic.thread_id, 'um:tp:close:stale');
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', oldButton), env)).status, 200);
    assert.equal(calls.some(call => call.method === 'closeForumTopic' && Number(call.body.chat_id) === oldGroup), false);

    const newReply = groupUpdate(881004, active.thread_id, 'Current topic reply');
    newReply.message.chat.id = newGroup;
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', newReply), env)).status, 200);
    assert.ok(calls.some(call => call.method === 'copyMessage' && call.body.chat_id === 881 && call.body.message_id === newReply.message.message_id));
  });
});

test('old General buttons and commands redirect after the manager menu takes over', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.MANAGER_BOT_TOKEN = 'manager-token';
    env.MANAGER_BOT_USERNAME = 'manager_bot';
    const groupId = Number(env.SUPPORT_GROUP_ID);
    await registerSupportGroup(db, groupId);
    db.run("UPDATE support_groups SET menu_message_id=777,menu_state='ready' WHERE group_id=?", groupId);
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a',
      callbackUpdate(881041, 1, 'um:o:add')), env)).status, 200);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM support_operator_flows').n, 0);
    assert.ok(calls.some(call => call.method === 'editMessageText'
      && call.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url === 'https://t.me/manager_bot?start=menu'));
    const before = calls.length;
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a',
      groupUpdate(881042, 1, '/operators')), env)).status, 200);
    assert.equal(calls.length, before, 'an unaddressed General command belongs to the manager');
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a',
      groupUpdate(881044, 1, '/operators@FolderLinksSupportBot')), env)).status, 200);
    assert.ok(calls.some(call => call.method === 'sendMessage' && Number(call.body.chat_id) === groupId
      && call.body.text.includes('https://t.me/manager_bot?start=menu')));
    assert.equal(db.get('SELECT COUNT(*) AS n FROM support_operator_flows').n, 0);
    seedConversation(db, 'folder-links', 8842, 88);
    const reply = groupUpdate(881043, 88, 'Answer in the active topic');
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', reply), env)).status, 200);
    assert.ok(calls.some(call => call.method === 'copyMessage' && Number(call.body.chat_id) === 8842
      && call.body.message_id === reply.message.message_id));
  });
});

test('manager takeover stops both service webhooks from owning General commands', async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.MANAGER_BOT_TOKEN = 'manager-token';
    env.MANAGER_BOT_USERNAME = 'manager_bot';
    const groupId = Number(env.SUPPORT_GROUP_ID);
    await registerSupportGroup(db, groupId);
    db.run("UPDATE support_groups SET menu_message_id=777,menu_state='ready' WHERE group_id=?", groupId);
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const command = groupUpdate(881045, 1, '/operators');
    assert.equal((await ingress.fetch(webhookRequest('folder-links', 'secret-a', command), env)).status, 200);
    assert.equal((await ingress.fetch(webhookRequest('image-compress', 'secret-b', command), env)).status, 200);
    assert.equal(calls.length, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM support_operator_flows').n, 0);
    assert.equal((await ingress.fetch(webhookRequest('folder-links', 'secret-a',
      groupUpdate(881046, 1, '/operators@FolderLinksSupportBot')), env)).status, 200);
    assert.equal(calls.filter(call => call.method === 'sendMessage'
      && call.body.text?.includes('https://t.me/manager_bot?start=menu')).length, 1);
  });
});

test('service bot leaves closing a customer topic to the manager after cutover', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.MANAGER_BOT_TOKEN = 'manager-token';
    env.MANAGER_BOT_USERNAME = 'manager_bot';
    seedConversation(db, 'folder-links', 8811, 71);
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a',
      groupUpdate(881048, 71, '/close')), env)).status, 200);
    assert.equal(calls.filter(call => call.method === 'closeForumTopic').length, 0);
    assert.equal(db.get("SELECT status FROM conversations WHERE bot_id='folder-links' AND user_id=8811").status, 'open');
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a',
      groupUpdate(881049, 71, '/close@FolderLinksSupportBot')), env)).status, 200);
    assert.ok(calls.some(call => call.method === 'sendMessage' && call.body.text?.includes('/close@manager_bot')));
    const oldButton = callbackUpdate(881050, 71, 'um:tp:close:outdated');
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', oldButton), env)).status, 200);
    assert.equal(calls.filter(call => call.method === 'closeForumTopic').length, 0);
    assert.equal(db.get("SELECT status FROM conversations WHERE bot_id='folder-links' AND user_id=8811").status, 'open');
  });
});

test('a missing manager never promotes the first service bot without an explicit legacy owner', async () => {
  await withFixture(null, async ({ env, calls, fetchMock }) => {
    env.BOT_REGISTRY = JSON.stringify(registryValue.map(({ groupCommandOwner, ...config }) => config));
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const update = groupUpdate(881047, 1, '/menu');
    assert.equal((await ingress.fetch(webhookRequest('folder-links', 'secret-a', update), env)).status, 200);
    assert.equal((await ingress.fetch(webhookRequest('image-compress', 'secret-b', update), env)).status, 200);
    assert.equal(calls.length, 0);
  });
});

test('customer reply after cutover creates a manager notice with the new topic link', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const newGroup = -1009876543210;
    env.MANAGER_BOT_TOKEN = 'manager-token';
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(881051, 890)), env)).status, 200);
    assert.equal(db.get("SELECT status FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=890 AND kind='new'").status, 'sent');
    await registerSupportGroup(db, newGroup, { forumVerifiedAt: new Date().toISOString() });
    await commitGroupCutover(db, 'folder-links', newGroup, null);
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(881052, 890)), env)).status, 200);
    const current = db.get("SELECT support_group_id,thread_id FROM conversations WHERE bot_id='folder-links' AND user_id=890");
    assert.equal(Number(current.support_group_id), newGroup);
    const notice = db.get("SELECT group_id,thread_id FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=890 AND kind='transfer'");
    assert.equal(Number(notice?.group_id), newGroup);
    assert.equal(Number(notice?.thread_id), current.thread_id);
    for (let i = 0; i < 20 && !db.get("SELECT telegram_message_id FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=890 AND kind='transfer'").telegram_message_id; i++)
      await runCountedRecovery({}, env);
    assert.ok(calls.some(call => call.token === 'manager-token' && call.method === 'sendMessage'
      && call.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url?.includes(`/${current.thread_id}`)));
  });
});

test('Cron refresh keeps each recipient language when a service topic link moves', async () => {
  const locales = ['en', 'ru', 'es', 'zh'];
  const openTopic = { en: 'Open topic', ru: 'Открыть тему', es: 'Abrir tema', zh: '打开话题' };
  for (const [index, managerLocale] of locales.entries()) {
    const serviceLocale = locales[(index + 1) % locales.length];
    await withFixture(null, async ({ env, db, calls }) => {
      const userId = 890 + index;
      const newGroup = -1009876543210;
      env.MANAGER_BOT_TOKEN = 'manager-token';
      env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: serviceLocale }, registryValue[1]]);
      db.run(`INSERT INTO manager_operator_preferences(operator_id,language,updated_at) VALUES(7,?,?)
        ON CONFLICT(operator_id) DO UPDATE SET language=excluded.language,updated_at=excluded.updated_at`, managerLocale, new Date().toISOString());
      assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(881500 + index * 10, userId)), env)).status, 200);
      const notice = db.get("SELECT telegram_message_id FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=? AND kind='new'", userId);
      assert.ok(notice?.telegram_message_id);
      const sentCard = calls.find(call => call.token === 'manager-token' && call.method === 'sendMessage'
        && Number(call.body.chat_id) === 7);
      assert.ok(sentCard, `${managerLocale}: expected sent card`);
      assert.equal(sentCard.body.reply_markup.inline_keyboard[0][0].text, openTopic[managerLocale]);

      await registerSupportGroup(db, newGroup, { forumVerifiedAt: new Date().toISOString() });
      await commitGroupCutover(db, 'folder-links', newGroup, null);
      assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(881501 + index * 10, userId)), env)).status, 200);
      const current = db.get("SELECT thread_id FROM conversations WHERE bot_id='folder-links' AND user_id=?", userId);
      for (let attempt = 0; attempt < 20 && db.get("SELECT error_code FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=? AND kind='new'", userId).error_code; attempt++)
        await runCountedRecovery({}, env);
      const refresh = calls.find(call => call.token === 'manager-token' && call.method === 'editMessageReplyMarkup'
        && Number(call.body.chat_id) === 7 && Number(call.body.message_id) === Number(notice.telegram_message_id));
      assert.ok(refresh, `${managerLocale}/${serviceLocale}: expected route refresh`);
      assert.equal(refresh.body.reply_markup.inline_keyboard[0][0].text, openTopic[managerLocale]);
      assert.ok(refresh.body.reply_markup.inline_keyboard[0][0].url.endsWith(`/${current.thread_id}`));
    });
  }
});

test('old topic reply immediately after cutover opens a safe destination and never reaches the client', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const oldGroup = Number(env.SUPPORT_GROUP_ID);
    const newGroup = -1009876543210;
    env.MANAGER_BOT_TOKEN = 'manager-token';
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(881101, 891)), env)).status, 200);
    const oldTopic = db.get("SELECT * FROM conversations WHERE bot_id='folder-links' AND user_id=891");
    await registerSupportGroup(db, newGroup, { forumVerifiedAt: new Date().toISOString() });
    await commitGroupCutover(db, 'folder-links', newGroup, null);

    const oldReply = groupUpdate(881102, oldTopic.thread_id, 'Reply sent in old group');
    env.RECOVERY_D1_PLAN = 'free';
    const scope = { queries: 0 };
    assert.equal((await recoveryQueryScope.run(scope, () => worker.fetch(webhookRequest('folder-links', 'secret-a', oldReply), env))).status, 200);
    assert.ok(scope.queries <= 50, `Old-topic redirect used ${scope.queries} D1 statements`);
    const active = db.get("SELECT * FROM conversations WHERE bot_id='folder-links' AND user_id=891");
    assert.equal(Number(active.support_group_id), newGroup);
    assert.equal(calls.filter(call => call.method === 'createForumTopic' && call.body.chat_id === newGroup).length, 1);
    assert.equal(calls.some(call => call.method === 'copyMessage' && call.body.message_id === oldReply.message.message_id), false);
    const notice = calls.find(call => call.method === 'sendMessage' && Number(call.body.chat_id) === oldGroup
      && call.body.message_thread_id === oldTopic.thread_id && /архивная|archived/.test(call.body.text));
    assert.ok(notice);
    assert.match(notice.body.text, new RegExp(String(active.thread_id)));
    const transfer = db.get("SELECT group_id,thread_id FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=891 AND kind='transfer'");
    assert.equal(Number(transfer.group_id), newGroup);
    assert.equal(Number(transfer.thread_id), active.thread_id);
    assert.ok(db.get("SELECT COUNT(*) n FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=891 AND error_code='link_refresh_pending'").n > 0);
    for (let i = 0; i < 20 && db.get("SELECT COUNT(*) n FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=891 AND error_code='link_refresh_pending'").n; i++)
      await runCountedRecovery({}, env);
    assert.equal(db.get("SELECT COUNT(*) n FROM service_notification_outbox WHERE bot_id='folder-links' AND user_id=891 AND error_code='link_refresh_pending'").n, 0);
    assert.ok(calls.some(call => call.token === 'manager-token' && call.method === 'editMessageReplyMarkup'
      && call.body.reply_markup.inline_keyboard[0][0].url.endsWith(`/${active.thread_id}`)));

    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', groupUpdate(881103, oldTopic.thread_id, 'Again')), env)).status, 200);
    assert.equal(calls.filter(call => call.method === 'createForumTopic' && call.body.chat_id === newGroup).length, 1);
  });
});

test('old topic button immediately after cutover only redirects to a newly created topic', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const newGroup = -1009876543210;
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(881201, 892)), env)).status, 200);
    const oldTopic = db.get("SELECT * FROM conversations WHERE bot_id='folder-links' AND user_id=892");
    await registerSupportGroup(db, newGroup, { forumVerifiedAt: new Date().toISOString() });
    await commitGroupCutover(db, 'folder-links', newGroup, null);
    const oldButton = callbackUpdate(881202, oldTopic.thread_id, 'um:tp:close:stale');
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', oldButton), env)).status, 200);
    const active = db.get("SELECT * FROM conversations WHERE bot_id='folder-links' AND user_id=892");
    assert.equal(Number(active.support_group_id), newGroup);
    assert.equal(calls.some(call => call.method === 'closeForumTopic'), false);
    assert.ok(calls.some(call => call.method === 'editMessageText' && /архивная|archived/.test(call.body.text)
      && call.body.text.includes(String(active.thread_id))));
  });
});

test('missing topic-creation permission after cutover saves the returning customer message for recovery', async () => {
  const newGroup = -1009876543210;
  let accessRestored = false;
  await withFixture(call => {
    if (!accessRestored && call.method === 'createForumTopic' && Number(call.body.chat_id) === newGroup)
      return { ok: false, error_code: 403, description: 'Forbidden: not enough rights to manage topics' };
  }, async ({ env, db, calls }) => {
    env.MANAGER_BOT_TOKEN = 'manager-token';
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(881301, 893)), env)).status, 200);
    await registerSupportGroup(db, newGroup, { forumVerifiedAt: new Date().toISOString() });
    await commitGroupCutover(db, 'folder-links', newGroup, null);
    const update = privateUpdate(881302, 893);
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', update), env)).status, 200);
    const queued = db.get("SELECT * FROM pending_messages WHERE bot_id='folder-links' AND update_id=881302");
    assert.equal(queued.failure_code, 'support_group_unavailable');
    assert.equal(queued.delivered_at, null);
    assert.ok(queued.failure_alerted_at);
    assert.equal(calls.filter(call => call.method === 'forwardMessage' && call.body.message_id === update.message.message_id).length, 0);
    accessRestored = true;
    for (let i = 0; i < 45 && !db.get('SELECT delivered_at FROM pending_messages WHERE id=?', queued.id).delivered_at; i++)
      await runCountedRecovery({}, env);
    assert.ok(db.get('SELECT delivered_at FROM pending_messages WHERE id=?', queued.id).delivered_at);
    const active = db.get("SELECT support_group_id FROM conversations WHERE bot_id='folder-links' AND user_id=893");
    assert.equal(Number(active.support_group_id), newGroup);
    assert.equal(calls.filter(call => call.method === 'copyMessage' && call.body.message_id === update.message.message_id
      && Number(call.body.chat_id) === newGroup).length, 1);
  });
});
const migration = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");

class D1Statement {
  constructor(owner, sql, params = []) {
    this.owner = owner;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new D1Statement(this.owner, this.sql, params);
  }

  first() {
    this.owner.checkFailure(this.sql);
    return this.owner.sqlite.prepare(this.sql).get(...this.params);
  }

  all() {
    this.owner.checkFailure(this.sql);
    return { results: this.owner.sqlite.prepare(this.sql).all(...this.params) };
  }

  run() {
    this.owner.checkFailure(this.sql);
    const before = this.owner.sqlite.prepare('SELECT total_changes() AS n').get().n;
    this.owner.sqlite.prepare(this.sql).run(...this.params);
    // Cloudflare D1 reports trigger/cascade changes too, unlike sqlite changes().
    return { meta: { changes: Number(this.owner.sqlite.prepare('SELECT total_changes() AS n').get().n - before) } };
  }
}

class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec(migration);
    this.failures = [];
  }

  prepare(sql) {
    return new D1Statement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  failOnce(fragment) {
    this.failures.push(fragment);
  }

  checkFailure(sql) {
    assertD1CompoundSelectLimit(sql);
    const scope = recoveryQueryScope.getStore();
    scope?.sqls?.push(sql);
    if (scope && ++scope.queries > (scope.limit ?? 50)) throw new Error("D1 Free invocation query limit exceeded");
    const index = this.failures.findIndex((fragment) => sql.includes(fragment));
    if (index !== -1) {
      this.failures.splice(index, 1);
      throw new Error(`Injected D1 failure for ${sql}`);
    }
  }

  get(sql, ...params) {
    return this.sqlite.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.sqlite.prepare(sql).all(...params);
  }

  run(sql, ...params) {
    return this.sqlite.prepare(sql).run(...params);
  }

  close() {
    this.sqlite.close();
  }
}



test('registered bot: real Free ingress delivers both directions and exposes General setup navigation', async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = 'free';
    env.BOT_ONBOARDING_ENABLED = 'true'; env.BOT_REGISTRY_KEY = 'ab'.repeat(32);
    env.TELEGRAM_COOLDOWN_ENABLED = 'true'; env.OPERATIONAL_HEALTH_ENABLED = 'true';
    env.RETENTION_ENABLED = 'true'; env.STORAGE_GUARD_ENABLED = 'true';
    const config = registeredConfig({ id: 988776, username: 'registered_bot' }, 'Registered', 'REG');
    const token = '988776:' + 'A'.repeat(35); const secret = 'registered-secret';
    db.run("INSERT INTO registered_bots(bot_id,telegram_id,config_json,credentials,status,owner_id,created_at,updated_at) VALUES(?,?,?,?,'active',7,'now','now')",
      config.id, 988776, JSON.stringify(config), await sealCredentials(env, config.id, { token, webhookSecret: secret }));
    const ingress = createRegistrationWorker(createControlPlaneWorker(undefined, fetchMock), fetchMock);
    for (const user of [9881, 7]) {
      const update = privateUpdate(988100 + user, user);
      assert.equal((await countedFreeFetch(ingress, webhookRequest(config.id, secret, update), env)).status, 200);
      const conversation = db.get('SELECT * FROM conversations WHERE bot_id=? AND user_id=?', config.id, user);
      assert.ok(conversation?.thread_id);
      assert.ok(calls.some(call => call.token === token && call.method === 'forwardMessage' && call.body.from_chat_id === user));
      assert.equal((await countedFreeFetch(ingress, webhookRequest(config.id, secret, update), env)).status, 200);
      assert.equal(calls.filter(call => call.token === token && call.method === 'forwardMessage' && call.body.from_chat_id === user).length, 1);
      const reply = groupUpdate(999100 + user, conversation.thread_id, 'We can help');
      assert.equal((await countedFreeFetch(ingress, webhookRequest(config.id, secret, reply), env)).status, 200);
      assert.ok(calls.some(call => call.token === token && call.method === 'copyMessage' && call.body.chat_id === user));
    }
    const menu = groupUpdate(999999, 1, '/bots');
    assert.equal((await countedFreeFetch(ingress, webhookRequest('folder-links', 'secret-a', menu), env)).status, 200);
    assert.ok(calls.some(call => call.method === 'sendMessage' && call.body.reply_markup?.inline_keyboard?.flat().some(b => b.url?.endsWith('?start=addbot'))));
    const scope = { queries: 0, limit: 45 };
    await recoveryQueryScope.run(scope, () => ingress.scheduled({}, env, null));
    assert.ok(scope.queries <= 45);
    const loaded = await withBotRegistry(env);
    const status = await manualDeliveryStatus(loaded, { actorId: 7, groupId: env.SUPPORT_GROUP_ID, threadId: 1, botId: config.id });
    assert.ok(status);
  });
});

test('registered bot: CAPTCHA uses dynamic credentials through the real verification route on Free', async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = 'free'; env.BOT_ONBOARDING_ENABLED = 'true'; env.BOT_REGISTRY_KEY = 'ab'.repeat(32);
    env.TELEGRAM_COOLDOWN_ENABLED = 'true'; env.RETENTION_ENABLED = 'true'; env.STORAGE_GUARD_ENABLED = 'true';
    env.TURNSTILE_SITE_KEY = 'site-key'; env.TURNSTILE_SECRET_KEY = 'secret-key';
    const config = { ...registeredConfig({ id: 988776, username: 'registered_bot' }, 'Registered', 'REG'), verification_mode: 'always' };
    const token = '988776:' + 'A'.repeat(35); const secret = 'registered-secret';
    db.run("INSERT INTO registered_bots(bot_id,telegram_id,config_json,credentials,status,owner_id,created_at,updated_at) VALUES(?,?,?,?,'active',7,'now','now')",
      config.id, 988776, JSON.stringify(config), await sealCredentials(env, config.id, { token, webhookSecret: secret }));
    const ingress = createRegistrationWorker(createControlPlaneWorker(undefined, fetchMock), fetchMock);
    const update = privateUpdate(988112, 9882);
    assert.equal((await countedFreeFetch(ingress, webhookRequest(config.id, secret, update), env)).status, 200);
    const challenge = db.get('SELECT * FROM verification_challenges WHERE bot_id=?', config.id);
    assert.ok(challenge?.notice_message_id);
    const verify = new Request(`https://support.example.workers.dev/verify/${verificationToken(calls)}`, { method: 'POST', body: new URLSearchParams({ 'cf-turnstile-response': 'proof' }) });
    const ctx = { exports: { VerificationStatus: { async sync(id, legacy) {
      const scope = { queries: 0, limit: 45 };
      await recoveryQueryScope.run(scope, async () => syncVerificationNotice(await withBotRegistry(env, 'recovery'), id, legacy));
    } } } };
    const scope = { queries: 0, limit: 50 };
    const response = await recoveryQueryScope.run(scope, () => ingress.fetch(verify, env, ctx));
    assert.equal(response.status, 200);
    assert.equal(db.get('SELECT status FROM verification_challenges WHERE id=?', challenge.id).status, 'passed');
    assert.ok(calls.some(call => call.token === token && call.method === 'editMessageText' && call.body.message_id === challenge.notice_message_id));
  });
});

test('CAPTCHA page and rejected proof follow the selected service language', async () => {
  const labels = { ru: ['Подтвердите, что вы человек', 'Проверка не пройдена'],
    en: ['Verify that you are human', 'Verification failed'],
    es: ['Confirma que eres una persona', 'La verificación no se completó'],
    zh: ['请确认你是真人', '验证未通过'] };
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    await withFixture(call => call.method === 'siteverify' ? { success: false } : null, async ({ env, calls }) => {
      env.TURNSTILE_SITE_KEY = 'site-key'; env.TURNSTILE_SECRET_KEY = 'secret-key';
      env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale, verification_mode: 'always' }]);
      assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(889912, 889912)), env)).status, 200);
      const url = `https://support.example.workers.dev/verify/${verificationToken(calls)}`;
      const page = await worker.fetch(new Request(url), env);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(html.includes(labels[locale][0]));
      assert.ok(html.includes(`data-language="${locale}"`));
      const rejected = await worker.fetch(new Request(url, { method: 'POST',
        body: new URLSearchParams({ 'cf-turnstile-response': 'bad-proof' }) }), env);
      assert.equal(rejected.status, 403);
      const error = await rejected.text();
      assert.ok(error.includes(labels[locale][1]));
      if (locale !== 'ru') assert.doesNotMatch(error, /[А-Яа-яЁё]/);
    });
  }
});

test('resolved CAPTCHA HTTP errors use the service language and retain protocol status/headers', async () => {
  const expected = {
    en: { expired: 'Verification link has expired.', retry: 'Please try again later.', unavailable: 'Verification is temporarily unavailable.', noKey: 'Verification is unavailable.' },
    ru: { expired: 'Срок действия ссылки для проверки истёк.', retry: 'Попробуйте ещё раз позже.', unavailable: 'Проверка временно недоступна.', noKey: 'Проверка недоступна.' },
    es: { expired: 'El enlace de verificación ha caducado.', retry: 'Inténtalo de nuevo más tarde.', unavailable: 'La verificación no está disponible temporalmente.', noKey: 'La verificación no está disponible.' },
    zh: { expired: '验证链接已过期。', retry: '请稍后重试。', unavailable: '验证暂时不可用。', noKey: '验证不可用。' },
  };
  const issueLink = async (env, calls, userId) => {
    env.TURNSTILE_SITE_KEY = 'site-key';
    env.TURNSTILE_SECRET_KEY = 'secret-key';
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: env.TEST_LOCALE, verification_mode: 'always' }]);
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(889920 + userId, userId)), env)).status, 200);
    return `https://support.example.workers.dev/verify/${verificationToken(calls)}`;
  };
  const assertResponse = async (response, status, text, locale) => {
    assert.equal(response.status, status);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(await response.text(), text);
    if (locale !== 'ru') assert.doesNotMatch(text, /[А-Яа-яЁё]/u, `${locale} response leaked Russian`);
  };
  for (const locale of ['en', 'ru', 'es', 'zh']) {
    await withFixture(null, async ({ env, db, calls }) => {
      env.TEST_LOCALE = locale;
      const url = await issueLink(env, calls, 9910);
      db.run("UPDATE verification_challenges SET status='expired' WHERE user_id=?", 9910);
      await assertResponse(await worker.fetch(new Request(url), env), 410, expected[locale].expired, locale);
    });
    await withFixture(null, async ({ env, db, calls }) => {
      env.TEST_LOCALE = locale;
      const url = await issueLink(env, calls, 9920);
      env.VERIFY_LIMITER = { limit: async ({ key }) => ({ success: !key.startsWith('verify-user:') }) };
      await assertResponse(await worker.fetch(new Request(url), env), 429, expected[locale].retry, locale);
    });
    await withFixture(null, async ({ env, db, calls }) => {
      env.TEST_LOCALE = locale;
      const url = await issueLink(env, calls, 9930);
      env.VERIFY_LIMITER = { limit: async ({ key }) => {
        if (key.startsWith('verify-user:')) throw new Error('limiter unavailable');
        return { success: true };
      } };
      await assertResponse(await worker.fetch(new Request(url), env), 503, expected[locale].unavailable, locale);
    });
    await withFixture(null, async ({ env, calls }) => {
      env.TEST_LOCALE = locale;
      const url = await issueLink(env, calls, 9940);
      delete env.TURNSTILE_SITE_KEY;
      await assertResponse(await worker.fetch(new Request(url), env), 503, expected[locale].noKey, locale);
    });
  }
});

function setBotTexts(db, botId, welcome = "", auto = "") {
  db.run("INSERT INTO bot_message_settings(bot_id, welcome_text, auto_reply_text, revision, updated_by, updated_at) VALUES(?, ?, ?, ?, 7, ?) ON CONFLICT(bot_id) DO UPDATE SET welcome_text = excluded.welcome_text, auto_reply_text = excluded.auto_reply_text, revision = excluded.revision",
    botId, welcome, auto, crypto.randomUUID(), new Date().toISOString());
}
function autoReplyCalls(calls, text = "Received") {
  return calls.filter(call => call.method === "sendMessage" && call.body.text === text && call.body.chat_id > 0);
}

function verificationStatusContext(env) {
  return { exports: { VerificationStatus: {
    async sync(id, legacy) {
      const scope = { queries: 0, limit: 45 };
      await recoveryQueryScope.run(scope, async () => {
        const db = await resolveInvocationDatabase(env.SUPPORT_DB, env, 'recovery');
        if (db.storageMode !== 'reset') await syncVerificationNotice({ ...env, SUPPORT_DB: db }, id, legacy);
      });
      assert.ok(scope.queries <= 45);
    },
  } } };
}
async function prepareCaptcha(fixture, userId = 9921) {
  const { env, calls, db } = fixture;
  env.RECOVERY_D1_PLAN = 'free';
  env.TELEGRAM_COOLDOWN_ENABLED = 'true';
  env.OPERATIONAL_HEALTH_ENABLED = 'true';
  env.RETENTION_ENABLED = 'true';
  env.STORAGE_GUARD_ENABLED = 'true';
  env.TURNSTILE_SITE_KEY = 'site-key';
  env.TURNSTILE_SECRET_KEY = 'secret-key';
  env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: 'ru', verification_mode: 'always' }]);
  const response = await countedFreeFetch(worker, webhookRequest('folder-links', 'secret-a', privateUpdate(userId * 10, userId)), env);
  assert.equal(response.status, 200);
  const challenge = db.get('SELECT * FROM verification_challenges WHERE user_id=?', userId);
  assert.ok(challenge.notice_message_id, 'Persist the actual prompt ID');
  const url = `https://support.example.workers.dev/verify/${verificationToken(calls)}`;
  return { challenge, url, post: () => new Request(url, { method: 'POST', body: new URLSearchParams({ 'cf-turnstile-response': 'proof' }) }), ctx: verificationStatusContext(env) };
}

test('verification status: busy delivery still confirms success in Russian and removes the CAPTCHA button immediately', async () => {
  await withFixture(null, async fixture => {
    const { env, db, calls } = fixture;
    const { challenge, post, ctx, url } = await prepareCaptcha(fixture);
    db.run('INSERT INTO pending_flush_locks(bot_id,user_id,owner_token,lease_expires_at,created_at) VALUES(?,?,?,?,?)', challenge.bot_id, challenge.user_id, 'other-worker', new Date(Date.now()+60_000).toISOString(), new Date().toISOString());
    const scope = { queries: 0 };
    const response = await recoveryQueryScope.run(scope, () => worker.fetch(post(), env, ctx));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const text = await response.text();
    assert.match(text, /✅ Проверка пройдена/);
    assert.doesNotMatch(text, /retry|доставлен|delivery|409/i);
    assert.ok(scope.queries <= 50);
    const edits = calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === challenge.user_id);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].body.message_id, challenge.notice_message_id);
    assert.deepEqual(edits[0].body.reply_markup.inline_keyboard, []);
    assert.ok(db.get('SELECT notice_resolved_at FROM verification_challenges').notice_resolved_at);
    assert.equal(db.get('SELECT flushed_at FROM verification_challenges').flushed_at, null);
    const siteverifyCount = calls.filter(call => call.method === 'siteverify').length;
    assert.equal((await worker.fetch(new Request(url), env, ctx)).status, 200);
    assert.equal(calls.filter(call => call.method === 'siteverify').length, siteverifyCount);
    assert.equal(calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === challenge.user_id).length, 1);
    assert.equal(calls.filter(call => call.method === 'copyMessage').length, 0);
    assert.equal(db.get('SELECT owner_token FROM pending_flush_locks').owner_token, 'other-worker');
  });
});

test('verification status: Telegram edit timeout does not fail passed CAPTCHA and Cron retries even after queue completion', async () => {
  let editFails = true;
  await withFixture(call => {
    if (call.method === 'editMessageText' && call.body.chat_id === 9921 && editFails) return { ok:false,error_code:500,description:'Internal Server Error' };
  }, async fixture => {
    const { env, db, calls } = fixture;
    const { post, ctx, challenge } = await prepareCaptcha(fixture);
    assert.equal((await worker.fetch(post(), env, ctx)).status, 200);
    assert.equal(db.get('SELECT status FROM verification_challenges').status, 'passed');
    assert.equal(db.get('SELECT notice_resolved_at FROM verification_challenges').notice_resolved_at, null);
    db.run('UPDATE verification_challenges SET flushed_at=?', new Date().toISOString());
    db.run('UPDATE verification_challenges SET notice_retry_at=?', new Date(Date.now()-1_000).toISOString());
    editFails = false;
    await runRecoveryCycle({}, env);
    assert.ok(db.get('SELECT notice_resolved_at FROM verification_challenges').notice_resolved_at);
    assert.ok(calls.filter(call => call.method === 'editMessageText' && call.body.message_id === challenge.notice_message_id).length >= 2);
    assert.equal(calls.filter(call => call.method === 'sendMessage' && call.body.text === '✅ Проверка пройдена.').length, 0);
  });
});

test('verification status: a failing notice does not starve another user and unknown sends are not repeated', async () => {
  await withFixture(call => {
    if (call.method === 'editMessageText' && call.body.chat_id === 9921) return { ok:false,error_code:400,description:'Bad Request: message to edit not found' };
    if (call.method === 'sendMessage' && call.body.text === '✅ Проверка пройдена.' && call.body.chat_id === 9921) return { ok:false,error_code:500,description:'Internal Server Error' };
  }, async fixture => {
    const { env, db, calls } = fixture;
    const { challenge, ctx } = await prepareCaptcha(fixture);
    const now = new Date().toISOString();
    db.run("UPDATE verification_challenges SET status='passed',verified_at=?,flushed_at=?", now, now);
    db.run('UPDATE user_abuse_state SET verification_required=0');
    db.run("INSERT INTO verification_challenges(bot_id,user_id,token_hash,status,created_at,expires_at,verified_at,flushed_at,notice_message_id) VALUES('folder-links',9922,'next-notice','passed',?,?,?,?,10001)", now, now, now, now);
    await assert.rejects(ctx.exports.VerificationStatus.sync(challenge.id));
    assert.ok(db.get('SELECT notice_resolution_started_at FROM verification_challenges WHERE id=?', challenge.id).notice_resolution_started_at);
    await runRecoveryCycle({}, env);
    assert.ok(db.get("SELECT notice_resolved_at FROM verification_challenges WHERE user_id=9922").notice_resolved_at);
    assert.equal(calls.filter(call => call.method === 'sendMessage' && call.body.text === '✅ Проверка пройдена.' && call.body.chat_id === 9921).length, 1);
    // A retryable edit failure also yields its place in the queue until retry_at.
    db.run('UPDATE verification_challenges SET notice_resolution_started_at=NULL,notice_retry_at=? WHERE id=?', new Date(Date.now()+300_000).toISOString(), challenge.id);
    const edits = calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === 9921).length;
    await runRecoveryCycle({}, env);
    assert.equal(calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === 9921).length, edits);
  });
});

test('verification status: delivery failures after verification do not ask the user to repeat CAPTCHA', async () => {
  await withFixture(call => {
    if (call.method === 'copyMessage') return { ok:false,error_code:429,description:'Too Many Requests',parameters:{retry_after:10} };
  }, async fixture => {
    const { env, db } = fixture;
    const { post, ctx } = await prepareCaptcha(fixture);
    const response = await worker.fetch(post(), env, ctx);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Проверка пройдена/);
    assert.equal(db.get('SELECT status FROM verification_challenges').status, 'passed');
    assert.ok(db.get('SELECT notice_resolved_at FROM verification_challenges').notice_resolved_at);
    assert.ok(db.get('SELECT COUNT(*) n FROM pending_messages WHERE delivered_at IS NULL').n > 0);
  });
});

test('verification status: failed or newer CAPTCHA, disabled bot and reset do not produce stale success notices', async () => {
  await withFixture(call => call.method === 'siteverify' ? { success:false } : null, async fixture => {
    const { env, db, calls } = fixture;
    const { post, ctx, challenge } = await prepareCaptcha(fixture);
    assert.equal((await worker.fetch(post(), env, ctx)).status, 403);
    assert.equal(calls.filter(call => call.method === 'editMessageText').length, 0);
    db.run("UPDATE verification_challenges SET status='passed',verified_at=?", new Date().toISOString());
    await ctx.exports.VerificationStatus.sync(challenge.id, true); // still verification_required
    db.run('UPDATE user_abuse_state SET verification_required=0');
    db.run("INSERT INTO verification_challenges(bot_id,user_id,token_hash,status,created_at,expires_at) VALUES('folder-links',?,'newer','pending',?,?)", challenge.user_id, new Date().toISOString(), new Date(Date.now()+60_000).toISOString());
    await ctx.exports.VerificationStatus.sync(challenge.id, true);
    db.run("UPDATE verification_challenges SET status='expired' WHERE token_hash='newer'");
    db.run("UPDATE bots SET enabled=0 WHERE id='folder-links'");
    await ctx.exports.VerificationStatus.sync(challenge.id, true);
    db.run("UPDATE bots SET enabled=1 WHERE id='folder-links'");
    db.run("UPDATE storage_control SET mode='reset',generation=generation+1");
    await ctx.exports.VerificationStatus.sync(challenge.id, true);
    assert.equal(calls.filter(call => call.method === 'editMessageText').length, 0);
  });
});

test('verification status: legacy prompt with unknown ID gets one fenced success on revisit without guessing a message to edit', async () => {
  await withFixture(null, async fixture => {
    const { env, db, calls } = fixture;
    const { challenge, ctx, url } = await prepareCaptcha(fixture);
    db.run("UPDATE verification_challenges SET status='passed',verified_at=?,flushed_at=?,notice_message_id=NULL", new Date().toISOString(), new Date().toISOString());
    db.run('UPDATE user_abuse_state SET verification_required=0');
    const oldCount = calls.length;
    await runRecoveryCycle({}, env);
    assert.equal(calls.slice(oldCount).filter(call => call.body.text === '✅ Проверка пройдена.').length, 0, 'Do not send old successes to everyone on deployment');
    await Promise.all([worker.fetch(new Request(url), env, ctx), worker.fetch(new Request(url), env, ctx)]);
    assert.equal(calls.filter(call => call.method === 'sendMessage' && call.body.text === '✅ Проверка пройдена.').length, 1);
    assert.equal(calls.filter(call => call.method === 'editMessageText' && call.body.chat_id === challenge.user_id).length, 0);
    assert.ok(db.get('SELECT notice_resolved_at FROM verification_challenges WHERE id=?', challenge.id).notice_resolved_at);
  });
});

test('verification status: an edit applied before a lost completion write is retried idempotently', async () => {
  let edits = 0;
  await withFixture(call => {
    if (call.method === 'editMessageText' && call.body.chat_id === 9921 && ++edits > 1) return {ok:false,error_code:400,description:'Bad Request: message is not modified'};
  }, async fixture => {
    const { env, db } = fixture;
    const { ctx, challenge } = await prepareCaptcha(fixture);
    db.run("UPDATE verification_challenges SET status='passed',verified_at=?", new Date().toISOString());
    db.run('UPDATE user_abuse_state SET verification_required=0');
    db.failOnce('SET notice_resolved_at=COALESCE');
    await assert.rejects(ctx.exports.VerificationStatus.sync(challenge.id));
    await ctx.exports.VerificationStatus.sync(challenge.id);
    assert.equal(edits, 2);
    assert.ok(db.get('SELECT notice_resolved_at FROM verification_challenges').notice_resolved_at);
  });
});

test('access alerts: real Free webhook records rate rejection once, while normal delivered messages stay quiet', async () => {
  await withFixture(null, async ({env,db}) => {
    env.BOT_REGISTRY=JSON.stringify([{...registryValue[0],risk_enabled:false}]);
    env.RETENTION_ENABLED='true';env.STORAGE_GUARD_ENABLED='true';env.TELEGRAM_COOLDOWN_ENABLED='true';
    seedConversation(db,'folder-links',9981,9981);
    const normal=privateUpdate(99810,9981);
    assert.equal((await countedFreeFetch(worker,webhookRequest('folder-links','secret-a',normal),env)).status,200);
    assert.equal(db.get('SELECT COUNT(*) n FROM user_access_events').n,0);
    env.ABUSE_BURST_LIMITER={limit:async()=>({success:false})};
    const blocked=privateUpdate(99811,9981);
    for(let i=0;i<2;i++) assert.equal((await countedFreeFetch(worker,webhookRequest('folder-links','secret-a',blocked),env)).status,200);
    const event=db.get('SELECT kind,occurrences FROM user_access_events');
    assert.equal(event.kind,'access_rate_limited');assert.equal(event.occurrences,1);
  });
});

test('access alerts: real CAPTCHA queue capacity and successful proof have distinct durable events', async () => {
  await withFixture(null, async fixture => {
    const {env,db}=fixture;
    const {post,ctx}=await prepareCaptcha(fixture,9982);
    const config=JSON.parse(env.BOT_REGISTRY)[0];env.BOT_REGISTRY=JSON.stringify([{...config,pending_message_limit:1}]);
    assert.equal((await countedFreeFetch(worker,webhookRequest('folder-links','secret-a',privateUpdate(99821,9982)),env)).status,200);
    assert.equal(db.get("SELECT COUNT(*) n FROM user_access_events WHERE kind='access_queue_full'").n,1);
    assert.equal((await worker.fetch(post(),env,ctx)).status,200);
    assert.equal(db.get("SELECT COUNT(*) n FROM user_access_events WHERE kind='verification_passed'").n,1);
  });
});

function manualFixture(env) {
  env.RECOVERY_D1_PLAN = 'free';
  env.TELEGRAM_COOLDOWN_ENABLED = 'true';
  env.OPERATIONAL_HEALTH_ENABLED = 'true';
  env.RETENTION_ENABLED = 'true';
  env.STORAGE_GUARD_ENABLED = 'true';
  const tasks = [];
  const queryCounts = [];
  const counted = async (mode, fn) => {
    const scope = { queries: 0, limit: mode === 'step' ? 45 : 50 };
    try { return await recoveryQueryScope.run(scope, fn); }
    finally { queryCounts.push(scope.queries); assert.ok(scope.queries <= scope.limit, `${mode} used ${scope.queries} queries`); }
  };
  const service = {
    status: options => counted('status', () => manualDeliveryStatus(env, options)),
    inspect: (token, observed) => counted('inspect', () => inspectManualDelivery(env, token, observed)),
    step: (token, target) => counted('step', () => stepManualDelivery(env, token, target, runManualDeliveryTarget)),
    async start(options) {
      const result = await counted('start', () => beginManualDelivery(env, options, publishManualDelivery));
      if (result.started) tasks.push(counted('run', () => executeManualDelivery(env, result.run.token, service, publishManualDelivery)));
      return result;
    },
  };
  return { service, queryCounts, ctx: { exports: { DeliveryRecovery: service } },
    drain: () => Promise.all(tasks),
    options: (requestKey, botId = null) => ({ actorId: 7, groupId: Number(env.SUPPORT_GROUP_ID), threadId: 1, uiBotId: 'folder-links', messageId: 888, requestKey, botId }) };
}
function seedManualReopen(db, userId = 7, botId = 'folder-links', threadId = 21) {
  const now = new Date().toISOString();
  seedConversation(db, botId, userId, threadId);
  db.run('UPDATE conversations SET status=\'closed\' WHERE bot_id=? AND user_id=?', botId, userId);
  db.run('INSERT INTO conversation_reopen_effects(bot_id,user_id,old_thread_id,created_at) VALUES(?,?,?,?)', botId, userId, threadId, now);
  db.run('INSERT INTO reopen_business_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES(?,?,?,?,8,?)', botId, userId, 977455440 + userId, userId, now);
}

test('manual delivery: historical operator album cannot replay after service group cutover', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const newGroup=-100999000111;
    const now=new Date().toISOString();
    db.run('INSERT INTO support_groups(group_id,created_at,updated_at) VALUES(?,?,?)',newGroup,now,now);
    db.run("INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES(?,?,'wizard',?)",'folder-links',newGroup,now);
    const result=await runManualDeliveryTarget(env,{kind:'album',botId:'folder-links',userId:7,
      direction:'support_to_user',groupId:'old-album',sourceChatId:Number(env.SUPPORT_GROUP_ID)});
    assert.equal(result.reason,'historical_topic');
    assert.equal(calls.filter(call=>call.method==='copyMessage').length,0);
  });
});

test('manual delivery: one General click restores a deleted Topic and reports actual delivery without Cron', async () => {
  await withFixture(call => {
    if (call.body.message_thread_id === 21) return { ok: false, error_code: 400, description: 'Bad Request: TOPIC_ID_INVALID' };
  }, async ({ env, db, calls, fetchMock }) => {
    env.BOT_REGISTRY = JSON.stringify([registryValue[0]]);
    seedManualReopen(db);
    const manual = manualFixture(env);
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const update = callbackUpdate(990001, 1, 'um:dl:run:a');
    const parentScope = { queries: 0 };
    const response = await recoveryQueryScope.run(parentScope, () => ingress.fetch(webhookRequest('folder-links', 'secret-a', update), env, manual.ctx));
    assert.ok(parentScope.queries <= 50);
    assert.equal(response.status, 200);
    await manual.drain();
    const run = db.get('SELECT * FROM manual_delivery_runs');
    const report = JSON.parse(run.report_json);
    assert.equal(run.status, 'finished');
    assert.ok(db.get('SELECT delivered_at FROM reopen_business_messages').delivered_at, JSON.stringify(report));
    assert.equal(report.confirmed, 1);
    assert.equal(report.remaining.total, 0);
    assert.equal(calls.filter(call => call.method === 'createForumTopic').length, 1);
    assert.equal(calls.filter(call => call.method === 'copyMessage' && call.body.message_id === 8).length, 1);
    const copies = calls.length;
    await ingress.fetch(webhookRequest('folder-links', 'secret-a', update), env, manual.ctx);
    await manual.service.start(manual.options('second'));
    await manual.drain();
    assert.equal(calls.slice(copies).filter(call => call.method === 'copyMessage').length, 0);
    assert.ok(calls.some(call => call.method === 'editMessageText' && /(?:Подтверждено доставок за время запуска|Deliveries confirmed during this run): 1/.test(call.body.text)));
  });
});

test('manual delivery: operators, private chats, foreign groups and user topics cannot start recovery', async () => {
  await withFixture(null, async ({ env, db, fetchMock }) => {
    seedOperator(db, 8);
    seedManualReopen(db);
    const manual = manualFixture(env);
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    for (const [thread, actor] of [[1, 8], [1, 9], [21, 7]]) {
      const update = callbackUpdate(991000 + thread + actor, thread, 'um:dl:run:a', actor);
      assert.equal((await ingress.fetch(webhookRequest('folder-links', 'secret-a', update), env, manual.ctx)).status, 200);
    }
    for (const change of [{ actorId: 8 }, { groupId: 7 }, { threadId: 21 }]) {
      await assert.rejects(manual.service.start({ ...manual.options('forbidden'), ...change }), /restricted/);
    }
    assert.equal(db.get('SELECT COUNT(*) n FROM manual_delivery_runs').n, 0);
    assert.equal(db.get('SELECT delivered_at FROM reopen_business_messages').delivered_at, null);
  });
});

test('manual delivery: CAPTCHA, bans, restrictions and uncertain sends remain fenced and visible', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const now = new Date().toISOString();
    for (const user of [901, 902, 903, 904]) seedManualReopen(db, user, 'folder-links', user);
    db.run('INSERT INTO user_abuse_state(bot_id,user_id,verification_required,created_at,updated_at) VALUES(\'folder-links\',901,1,?,?)', now, now);
    db.run('INSERT INTO banned_users(bot_id,user_id,banned_at) VALUES(\'folder-links\',902,?)', now);
    db.run('INSERT INTO user_abuse_state(bot_id,user_id,manual_restricted_until,created_at,updated_at) VALUES(\'folder-links\',903,?,?,?)', new Date(Date.now() + 60_000).toISOString(), now, now);
    db.run('UPDATE reopen_business_messages SET failure_code=\'telegram_delivery_outcome_unknown\' WHERE user_id=904');
    const manual = manualFixture(env);
    await manual.service.start(manual.options('fences'));
    await manual.drain();
    const report = JSON.parse(db.get('SELECT report_json FROM manual_delivery_runs').report_json);
    assert.equal(report.attempts, 0);
    assert.equal(report.confirmed, 0);
    assert.deepEqual([report.remaining.captcha, report.remaining.banned, report.remaining.restricted, report.remaining.uncertain], [1,1,1,1]);
    assert.equal(db.get('SELECT COUNT(*) n FROM reopen_business_messages').n, 4);
    assert.equal(calls.filter(call => ['copyMessage','createForumTopic','reopenForumTopic'].includes(call.method)).length, 0);
  });
});

test('manual delivery: persistent errors and Telegram cooldown are reported without clearing delivery fences', async () => {
  await withFixture(call => {
    if (call.method === 'reopenForumTopic') return { ok: false, error_code: 400, description: 'Bad Request: not enough rights' };
  }, async ({ env, db }) => {
    seedManualReopen(db);
    const manual = manualFixture(env);
    await manual.service.start(manual.options('error'));
    await manual.drain();
    const report = JSON.parse(db.get('SELECT report_json FROM manual_delivery_runs').report_json);
    assert.equal(report.confirmed, 0);
    assert.match(report.errors.join(' '), /not enough rights/);
    assert.equal(report.remaining.total, 1);
    assert.equal(db.get('SELECT delivered_at FROM reopen_business_messages').delivered_at, null);
    seedManualReopen(db, 88, 'image-compress', 88);
    db.run("INSERT INTO telegram_cooldowns(bot_key,not_before,last_method,updated_at) VALUES('service:image-compress',?,'copyMessage',?)", new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    await manual.service.start(manual.options('cooldown', 'image-compress'));
    await manual.drain();
    const latest = db.get('SELECT report_json FROM manual_delivery_runs ORDER BY rowid DESC LIMIT 1');
    assert.ok(JSON.parse(latest.report_json).outcomes.some(item => item.state === 'cooldown'));
  });
});

test('manual delivery: simultaneous clicks and Cron share leases and do not duplicate messages', async () => {
  const entered = deferred();
  const unblock = deferred();
  await withFixture(async call => {
    if (call.method === 'reopenForumTopic') { entered.resolve(); await unblock.promise; }
  }, async ({ env, db, calls }) => {
    seedManualReopen(db);
    const manual = manualFixture(env);
    const started = await manual.service.start(manual.options('first'));
    await entered.promise;
    try {
      const second = await manual.service.start(manual.options('second'));
      assert.equal(second.started, false);
      assert.equal(second.run.token, started.run.token);
      await runCountedRecovery({}, env);
    } finally { unblock.resolve(); }
    await manual.drain();
    await runRecoveryCycle({}, env);
    assert.equal(calls.filter(call => call.method === 'copyMessage' && call.body.message_id === 8).length, 1);
    assert.equal(db.get('SELECT COUNT(*) n FROM manual_delivery_runs').n, 1);
  });
});

test('manual delivery: full reset and a changed generation stop an accepted run', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedManualReopen(db);
    const manual = manualFixture(env);
    const accepted = await beginManualDelivery(env, manual.options('generation'), publishManualDelivery);
    db.run('UPDATE storage_control SET generation=generation+1');
    await executeManualDelivery(env, accepted.run.token, manual.service, publishManualDelivery);
    assert.equal(db.get('SELECT status FROM manual_delivery_runs').status, 'interrupted');
    assert.equal(calls.filter(call => call.method === 'copyMessage').length, 0);
    db.run("UPDATE storage_control SET mode='reset'");
    const next = await manual.service.start(manual.options('reset'));
    assert.equal(next.maintenance, true);
  });
});

test('manual delivery: an expired run is shown as interrupted and can be replaced', async () => {
  await withFixture(null, async ({ env, db }) => {
    const manual = manualFixture(env);
    await beginManualDelivery(env, manual.options('expired'), publishManualDelivery);
    db.run("UPDATE manual_delivery_runs SET expires_at='2020-01-01T00:00:00.000Z'");
    const status = await manual.service.status(manual.options('view'));
    assert.match(manualDeliveryText(status), /Запуск прерван/);
    await manual.service.start(manual.options('new'));
    await manual.drain();
    assert.equal(db.get("SELECT status FROM manual_delivery_runs WHERE request_key='expired'").status, 'interrupted');
    assert.equal(db.get("SELECT status FROM manual_delivery_runs WHERE request_key='new'").status, 'finished');
  });
});

test('manual delivery: selected bot drains a released pending queue and an album while other bots remain untouched', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const now = new Date().toISOString();
    const old = Date.now() - 10_000;
    seedConversation(db, 'folder-links', 911, 91);
    db.run("INSERT INTO user_abuse_state(bot_id,user_id,pending_release_required,created_at,updated_at) VALUES('folder-links',911,1,?,?)", now, now);
    db.run("INSERT INTO pending_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES('folder-links',911,9110,911,9110,?)", now);
    seedConversation(db, 'folder-links', 912, 92);
    db.run("INSERT INTO media_groups(bot_id,direction,media_group_id,source_chat_id,target_chat_id,thread_id,user_id,last_received_at,created_at) VALUES('folder-links','user_to_support','manual',912,-1001234567890,92,912,?,?)", old, now);
    for (const id of [9121, 9122]) db.run("INSERT INTO media_group_items(bot_id,direction,media_group_id,source_chat_id,message_id,media_type,file_id,received_at) VALUES('folder-links','user_to_support','manual',912,?,'photo',?,?)", id, 'file-' + id, old);
    seedManualReopen(db, 913, 'image-compress', 93);
    const manual = manualFixture(env);
    await manual.service.start(manual.options('selected', 'folder-links'));
    await manual.drain();
    const report = JSON.parse(db.get('SELECT report_json FROM manual_delivery_runs').report_json);
    assert.equal(report.confirmed, 3, JSON.stringify(report));
    assert.equal(report.remaining.total, 0);
    assert.equal(db.get("SELECT delivered_at FROM reopen_business_messages WHERE bot_id='image-compress'").delivered_at, null);
    assert.equal(calls.filter(call => call.method === 'sendMediaGroup').length, 1);
  });
});

test('manual delivery: a passed CAPTCHA queue is delivered without bypassing verification or a second send', async () => {
  await withFixture(null, async ({ env, db }) => {
    const now = new Date().toISOString();
    seedConversation(db, 'folder-links', 921, 94);
    db.run("INSERT INTO user_abuse_state(bot_id,user_id,verification_required,created_at,updated_at) VALUES('folder-links',921,0,?,?)", now, now);
    const challenge = db.run("INSERT INTO verification_challenges(bot_id,user_id,token_hash,status,created_at,expires_at,verified_at) VALUES('folder-links',921,'manual-pass','passed',?,?,?)", now, new Date(Date.now()+60_000).toISOString(), now);
    db.run("INSERT INTO pending_messages(bot_id,user_id,challenge_id,update_id,source_chat_id,source_message_id,created_at) VALUES('folder-links',921,?,9210,921,9210,?)", Number(challenge.lastInsertRowid), now);
    const manual = manualFixture(env);
    await manual.service.start(manual.options('passed'));
    await manual.drain();
    const report = JSON.parse(db.get('SELECT report_json FROM manual_delivery_runs').report_json);
    assert.equal(report.confirmed, 1, JSON.stringify(report));
    assert.equal(report.remaining.total, 0);
  });
});
test("bot messages: empty defaults keep /start silent and do not create a conversation", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const start = privateUpdate(91000, 901);
    start.message.text = "/start";
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", start), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) n FROM conversations").n, 0);
    assert.equal(calls.length, 0);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91001, 901)), env)).status, 200);
    assert.equal(calls.filter(call => call.method === "sendMessage" && call.body.chat_id === 901).length, 0);
    assert.equal(db.get("SELECT state FROM conversation_auto_replies WHERE user_id = 901").state, "disabled");
  });
});
test("bot messages: configured welcome is isolated by bot and /start never opens or reopens a case", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    setBotTexts(db, "folder-links", "Welcome A", "Received");
    const start = privateUpdate(91100, 902);
    start.message.text = "/start ref";
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", start), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", start), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", start), env)).status, 200);
    assert.equal(autoReplyCalls(calls, "Welcome A").length, 1);
    assert.equal(db.get("SELECT COUNT(*) n FROM conversations").n, 0);
    assert.equal(autoReplyCalls(calls, "Welcome A")[0].body.reply_markup, undefined);
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91101, 902)), env);
    const conv = db.get("SELECT * FROM conversations WHERE user_id = 902");
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(91102, conv.thread_id, "/close")), env);
    start.update_id = 91103; start.message.message_id += 10;
    await worker.fetch(webhookRequest("folder-links", "secret-a", start), env);
    assert.equal(db.get("SELECT status FROM conversations WHERE user_id = 902").status, "closed");
    assert.equal(autoReplyCalls(calls, "Welcome A").length, 2);
    assert.equal(autoReplyCalls(calls).length, 1);
  });
});
test("bot messages: auto-reply only on first delivery and first delivery after each real closure", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], antispam_enabled: false }]);
    setBotTexts(db, "folder-links", "", "Received");
    const send = update => worker.fetch(webhookRequest("folder-links", "secret-a", update), env);
    const first = privateUpdate(91200, 903);
    assert.equal((await send(first)).status, 200);
    assert.equal(autoReplyCalls(calls).length, 1);
    const firstForward = calls.findIndex(call => call.method === "forwardMessage");
    assert.ok(firstForward < calls.findIndex(call => call.body.text === "Received"));
    assert.equal((await send(first)).status, 200);
    assert.equal((await send(privateUpdate(91201, 903))).status, 200);
    assert.equal(autoReplyCalls(calls).length, 1);
    const conv = db.get("SELECT * FROM conversations WHERE user_id = 903");
    assert.equal((await send(groupUpdate(91202, conv.thread_id, "/close"))).status, 200);
    assert.equal(autoReplyCalls(calls).length, 1);
    assert.equal((await send(privateUpdate(91203, 903))).status, 200);
    assert.equal(autoReplyCalls(calls).length, 2);
    await send(groupUpdate(91204, conv.thread_id, "/close"));
    await send(groupUpdate(91205, conv.thread_id, "/open"));
    assert.equal(autoReplyCalls(calls).length, 2);
    assert.equal((await send(privateUpdate(91206, 903))).status, 200);
    assert.equal(autoReplyCalls(calls).length, 3);
    assert.ok(autoReplyCalls(calls).every(call => call.body.reply_markup === undefined));
    await send({ update_id: 91207, edited_message: { ...first.message, text: "Edited" } });
    await runRecoveryCycle({}, env, null);
    assert.equal(autoReplyCalls(calls).length, 3);
  });
});
test("bot messages: enabling auto-reply does not acknowledge an existing open conversation", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], antispam_enabled: false }]);
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91300, 904)), env);
    setBotTexts(db, "folder-links", "", "Received");
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91301, 904)), env);
    assert.equal(autoReplyCalls(calls).length, 0);
    const conv = db.get("SELECT * FROM conversations WHERE user_id = 904");
    const closed = groupUpdate(91302, conv.thread_id, undefined);
    closed.message.forum_topic_closed = {};
    await worker.fetch(webhookRequest("folder-links", "secret-a", closed), env);
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91303, 904)), env);
    assert.equal(autoReplyCalls(calls).length, 1);
  });
});
for (const description of ["Bad Request: message thread not found", "Bad Request: TOPIC_DELETED", "Bad Request: TOPIC_ID_INVALID"])
for (const staleProvision of [false, true]) test(`deleted Topic: Free ingress restores delivery with stale provision=${staleProvision}; ${description}`, async () => {
  let missing = false;
  await withFixture(call => {
    if (missing && call.body.message_thread_id === 51) {
      return { ok: false, error_code: 400, description };
    }
  }, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = "free";
    env.TELEGRAM_COOLDOWN_ENABLED = "true";
    env.OPERATIONAL_HEALTH_ENABLED = "true";
    env.RETENTION_ENABLED = "true";
    env.STORAGE_GUARD_ENABLED = "true";
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const send = async update => {
      let response;
      for (let i = 0; i < 8; i++) {
        response = await countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", update), env);
        if (response.status === 200) return response;
      }
      assert.fail(`Update did not complete: ${response.status}; conversation=${JSON.stringify(db.get("SELECT * FROM conversations WHERE user_id=905"))}`);
    };
    await send(privateUpdate(91410, 905));
    if (staleProvision) seedCompletedProvision(db, "folder-links", 905, 51);
    missing = true;
    await send(privateUpdate(91411, 905));
    await send(privateUpdate(91412, 905));
    assert.equal(db.get("SELECT thread_id FROM conversations WHERE user_id=905").thread_id, 52);
    assert.equal(calls.filter(call => call.method === "createForumTopic").length, 2);
    for (const id of [91411, 91412]) {
      assert.equal(db.get("SELECT thread_id FROM message_mappings WHERE user_message_id=?", id)?.thread_id, 52, `Message ${id} must reach the new Topic`);
    }
  });
});

test("deleted Topic: another deletion during repair keeps the source retryable", async () => {
  let missing = false;
  await withFixture(call => {
    if (missing && call.method === "forwardMessage" && call.body.message_thread_id < 53) {
      return { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
    }
  }, async ({ env, db }) => {
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91420, 905)), env);
    missing = true;
    const update = privateUpdate(91421, 905);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(db.get("SELECT thread_id FROM message_mappings WHERE user_message_id=91421").thread_id, 53);
  });
});

function seedCompletedProvision(db, botId, userId, threadId) {
  const now = new Date().toISOString();
  db.run("INSERT OR REPLACE INTO conversation_provision_attempts(bot_id,user_id,started_at,request_started_at,completed_at,thread_id) VALUES(?,?,?,?,?,?)", botId, userId, now, now, now, threadId);
}

test("deleted Topic: queued album retires an obsolete completed provisioning result on Free", async () => {
  await withFixture(call => {
    if (call.body.message_thread_id === 55) return { ok: false, error_code: 400, description: "Bad Request: TOPIC_DELETED" };
  }, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = "free";
    env.TELEGRAM_COOLDOWN_ENABLED = "true";
    env.OPERATIONAL_HEALTH_ENABLED = "true";
    env.RETENTION_ENABLED = "true";
    env.STORAGE_GUARD_ENABLED = "true";
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    seedConversation(db, "folder-links", 906, 55);
    seedCompletedProvision(db, "folder-links", 906, 55);
    for (const id of [91430, 91431]) {
      const update = privateUpdate(id, 906);
      delete update.message.text;
      update.message.media_group_id = "deleted-topic-album";
      update.message.photo = [{ file_id: "photo-" + id }];
      for (let retry = 0; retry < 5; retry++) {
        if ((await countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", update), env)).status === 200) break;
      }
    }
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.filter(call => call.method === "createForumTopic").length, 1);
    const thread = db.get("SELECT thread_id FROM conversations WHERE user_id=906").thread_id;
    assert.notEqual(thread, 55);
    for (const id of [91430, 91431]) assert.equal(db.get("SELECT thread_id FROM message_mappings WHERE user_message_id=?", id)?.thread_id, thread);
  });
});

const setupReminderCalls = calls => calls.filter(call => call.method === "sendMessage" && /^⚙️ (Настройте сообщения бота|Configure messages for)/.test(call.body.text || ""));

test("bot setup: new enabled bots receive one General reminder with an authorized settings button", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = "free";
    env.TELEGRAM_COOLDOWN_ENABLED = "true";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }]);
    await runRecoveryCycle({}, env, null);
    let notices = setupReminderCalls(calls);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].body.chat_id, Number(env.SUPPORT_GROUP_ID));
    assert.equal(notices[0].body.message_thread_id, undefined);
    assert.match(notices[0].body.text, /приветствие.*подтверждение/s);
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }, { ...registryValue[1], enabled: false }]);
    await runRecoveryCycle({}, env, null);
    assert.equal(setupReminderCalls(calls).length, 1);
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }, registryValue[1]]);
    await runRecoveryCycle({}, env, null);
    assert.equal(setupReminderCalls(calls).length, 2);
    env.BOT_REGISTRY = JSON.stringify([registryValue[1], { ...registryValue[0], locale: "ru" }]);
    await runRecoveryCycle({}, env, null);
    notices = setupReminderCalls(calls);
    assert.equal(notices.length, 2, "Registry reordering and another Cron do not repeat notices");
    const callback = notices[1].body.reply_markup.inline_keyboard[0][0].callback_data;
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const send = update => countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", update), env);
    assert.equal((await send(callbackUpdate(91440, 1, callback, 8))).status, 200);
    assert.equal(db.get("SELECT COUNT(*) n FROM bot_message_flows").n, 0);
    assert.equal((await send(callbackUpdate(91441, 1, callback))).status, 200);
    assert.ok(calls.some(call => ["sendMessage", "editMessageText"].includes(call.method) && call.body.text.startsWith("Image Compress\n\nПриветствие:")));
    assert.equal(db.get("SELECT COUNT(*) n FROM bot_message_settings").n, 0);
  });
});

test("bot setup: configured bots are skipped and partial settings identify the missing text", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    setBotTexts(db, "folder-links", "Welcome", "Received");
    setBotTexts(db, "image-compress", "Welcome", "");
    await runRecoveryCycle({}, env, null);
    assert.equal(db.get("SELECT state FROM bot_setup_notices WHERE bot_id='folder-links'").state, "skipped");
    assert.equal(setupReminderCalls(calls).length, 1);
    const text = setupReminderCalls(calls)[0].body.text;
    assert.match(text, /acknowledgement/);
    assert.doesNotMatch(text, /\/start welcome/);
  });
});

for (const uncertain of [false, true]) test(`bot setup: rejected reminders retry, uncertain reminders do not duplicate; uncertain=${uncertain}`, async () => {
  let failures = 1;
  await withFixture(call => {
    if (/^⚙️ Configure messages for/.test(call.body.text || "") && failures-- > 0) {
      return { ok: false, error_code: uncertain ? 502 : 429, description: uncertain ? "response lost" : "Too Many Requests", parameters: { retry_after: 1 } };
    }
  }, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([registryValue[0]]);
    await runRecoveryCycle({}, env, null);
    await runRecoveryCycle({}, env, null);
    assert.equal(setupReminderCalls(calls).length, uncertain ? 1 : 2);
    assert.equal(db.get("SELECT state FROM bot_setup_notices").state, uncertain ? "started" : "sent");
  });
});

test("bot messages: deleting and recreating an open Topic does not repeat the auto-reply", async () => {
  let missing = false;
  await withFixture(call => {
    if (missing && (call.method === "forwardMessage" || call.method === "reopenForumTopic") && call.body.message_thread_id === 51) {
      return { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
    }
  }, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], antispam_enabled: false }]);
    setBotTexts(db, "folder-links", "", "Received");
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91400, 905)), env);
    assert.equal(autoReplyCalls(calls).length, 1);
    missing = true;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91401, 905)), env)).status, 200);
    assert.equal(db.get("SELECT thread_id FROM conversations WHERE user_id = 905").thread_id, 52);
    assert.equal(autoReplyCalls(calls).length, 1);
  });
});
test("bot messages: uncertain auto-reply is not repeated by retries or Cron", async () => {
  await withFixture(call => call.body.text === "Received" ? { ok: false, error_code: 502, description: "upstream response lost" } : null, async ({ env, db, calls }) => {
    setBotTexts(db, "folder-links", "", "Received");
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91500, 906)), env);
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91501, 906)), env);
    await runRecoveryCycle({}, env, null);
    assert.equal(autoReplyCalls(calls).length, 1);
    assert.equal(db.get("SELECT state FROM conversation_auto_replies WHERE user_id = 906").state, "started");
    assert.equal(calls.filter(call => call.method === "forwardMessage").length, 2);
  });
});
test("bot messages: primary administrator previews, saves and clears texts through real General ingress", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const key = managementBotKey(parseBotRegistry(env.BOT_REGISTRY), "image-compress");
    const send = update => countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", update), env);
    assert.equal((await send(groupUpdate(91600, 1, "/messages"))).status, 200);
    assert.equal((await send(callbackUpdate(91601, 1, "um:m:edit:" + key + ":w"))).status, 200);
    assert.equal((await send(groupUpdate(91602, 1, "Привет! Опишите проблему."))).status, 200);
    assert.equal(db.get("SELECT COUNT(*) n FROM bot_message_settings").n, 0, "preview is not a save");
    let flow = db.get("SELECT * FROM bot_message_flows WHERE owner_id = 7");
    assert.equal(flow.stage, "confirm");
    assert.equal((await send(callbackUpdate(91603, 1, "um:m:save:" + flow.nonce))).status, 200);
    assert.equal(db.get("SELECT welcome_text FROM bot_message_settings WHERE bot_id = 'image-compress'").welcome_text, "Привет! Опишите проблему.");
    assert.equal(db.get("SELECT COUNT(*) n FROM bot_message_settings WHERE bot_id = 'folder-links'").n, 0);
    assert.equal((await send(callbackUpdate(91604, 1, "um:m:clear:" + key + ":w"))).status, 200);
    flow = db.get("SELECT * FROM bot_message_flows WHERE owner_id = 7");
    assert.equal((await send(callbackUpdate(91605, 1, "um:m:save:" + flow.nonce))).status, 200);
    assert.equal(db.get("SELECT welcome_text FROM bot_message_settings WHERE bot_id = 'image-compress'").welcome_text, "");
    assert.ok(!calls.some(call => call.method === "sendMessage" && call.body.chat_id > 0), "editing never messages a customer");
  });
});
test("bot messages: stale previews, non-primary actors, other topics and oversized drafts cannot change settings", async () => {
  await withFixture(null, async ({ env, db }) => {
    const key = managementBotKey(parseBotRegistry(env.BOT_REGISTRY), "folder-links");
    const send = update => worker.fetch(webhookRequest("folder-links", "secret-a", update), env);
    await send(callbackUpdate(91700, 1, "um:m:edit:" + key + ":a", 8));
    assert.equal(db.get("SELECT COUNT(*) n FROM bot_message_flows").n, 0);
    await send(callbackUpdate(91701, 1, "um:m:edit:" + key + ":a"));
    await send(groupUpdate(91702, 1, "x".repeat(3501)));
    let flow = db.get("SELECT * FROM bot_message_flows WHERE owner_id = 7");
    assert.equal(flow.stage, "text");
    await send(groupUpdate(91703, 1, "Received"));
    flow = db.get("SELECT * FROM bot_message_flows WHERE owner_id = 7");
    setBotTexts(db, "folder-links", "", "Newer setting");
    await send(callbackUpdate(91704, 1, "um:m:save:" + flow.nonce));
    assert.equal(db.get("SELECT auto_reply_text FROM bot_message_settings WHERE bot_id = 'folder-links'").auto_reply_text, "Newer setting");
    await send(callbackUpdate(91705, 51, "um:m:save:" + flow.nonce));
    assert.equal(db.get("SELECT auto_reply_text FROM bot_message_settings WHERE bot_id = 'folder-links'").auto_reply_text, "Newer setting");
  });
});




test("bot messages: album delivery and CAPTCHA release each acknowledge only once", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    setBotTexts(db, "folder-links", "", "Received");
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], antispam_enabled: false }]);
    for (let i = 0; i < 3; i++) {
      const update = privateUpdate(91800 + i, 907);
      delete update.message.text;
      update.message.media_group_id = "welcome-album";
      update.message.photo = [{ file_id: "photo-" + i }];
      assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    await runRecoveryCycle({}, env, null);
    assert.equal(autoReplyCalls(calls).length, 1);
    assert.ok(calls.findIndex(call => call.method === "sendMediaGroup") < calls.findIndex(call => call.body.text === "Received"));
  });
  await withFixture(null, async ({ env, db, calls }) => {
    setBotTexts(db, "folder-links", "", "Received");
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91810, 908)), env);
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91811, 908)), env);
    assert.equal(autoReplyCalls(calls).length, 0);
    const token = verificationToken(calls);
    assert.ok(token, "CAPTCHA button remains available");
    const verify = () => new Request("https://support.example.workers.dev/verify/" + token, {
      method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof",
    });
    assert.equal((await worker.fetch(verify(), env)).status, 200);
    await worker.fetch(verify(), env);
    await runRecoveryCycle({}, env, null);
    assert.equal(autoReplyCalls(calls).length, 1);
  });
});
test("bot messages: failed delivery has no acknowledgement; a known rejected auto-reply retries safely", async () => {
  let failed = true;
  await withFixture(call => {
    if (failed && call.method === "forwardMessage") return { ok: false, error_code: 403, description: "Forbidden" };
  }, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], antispam_enabled: false }]);
    setBotTexts(db, "folder-links", "", "Received");
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91900, 909)), env);
    assert.equal(autoReplyCalls(calls).length, 0);
    failed = false;
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91901, 909)), env);
    assert.equal(autoReplyCalls(calls).length, 1);
  });
  let reject = true;
  await withFixture(call => {
    if (reject && call.body.text === "Received") { reject = false; return { ok: false, error_code: 429, parameters: { retry_after: 1 } }; }
  }, async ({ env, db, calls }) => {
    setBotTexts(db, "folder-links", "", "Received");
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(91910, 910)), env);
    assert.equal(db.get("SELECT state FROM conversation_auto_replies WHERE user_id = 910").state, "ready");
    await runRecoveryCycle({}, env, null);
    assert.equal(db.get("SELECT state FROM conversation_auto_replies WHERE user_id = 910").state, "sent");
    assert.equal(autoReplyCalls(calls).length, 2, "one explicit rejection and one successful send");
    assert.equal(calls.filter(call => call.method === "forwardMessage").length, 1);
  });
});

test("removed service bot preserves inbound message and delivers it once after group access returns", async () => {
  let accessRestored = false;
  await withFixture((call) => {
    if (!accessRestored && ["forwardMessage", "copyMessage", "sendMessage"].includes(call.method)
        && Number(call.body.chat_id) === -1001234567890)
      return { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the supergroup chat" };
  }, async ({ env, db, calls }) => {
    env.MANAGER_BOT_TOKEN = "manager-token";
    seedConversation(db, "folder-links", 91950, 950);
    const update = privateUpdate(91950, 91950);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    const queued = db.get("SELECT * FROM pending_messages WHERE bot_id='folder-links' AND update_id=91950");
    assert.equal(queued.failure_code, "support_group_unavailable");
    assert.equal(queued.delivered_at, null);
    assert.ok(queued.failure_alerted_at);
    assert.equal(calls.filter(call => call.token === "manager-token" && call.body.chat_id === 7).length, 1);
    assert.equal(calls.some(call => call.body.chat_id === 91950 && /could not be delivered|Не удалось доставить/.test(call.body.text || "")), false);
    accessRestored = true;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    for (let i = 0; i < 45 && !db.get("SELECT delivered_at FROM pending_messages WHERE id=?", queued.id).delivered_at; i++) await runCountedRecovery({}, env);
    assert.ok(db.get("SELECT delivered_at FROM pending_messages WHERE id=?", queued.id).delivered_at);
    assert.equal(calls.filter(call => call.method === "forwardMessage").length, 1);
    assert.equal(calls.filter(call => call.method === "copyMessage" && call.body.message_id === 91950).length, 1);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_mappings WHERE bot_id='folder-links' AND user_id=91950 AND user_message_id=91950").n, 1);
    for (let i = 0; i < 20; i++) await runCountedRecovery({}, env);
    assert.equal(calls.filter(call => call.method === "copyMessage" && call.body.message_id === 91950).length, 1);
  });
});

test("operator album in a new group ignores matching message IDs mapped in the old group", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const oldGroup = -1001234567890;
    const newGroup = -100999000111;
    const now = new Date().toISOString();
    db.run("INSERT INTO support_groups(group_id,created_at,updated_at) VALUES(?,?,?)", newGroup, now, now);
    db.run("INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES(? ,?,'wizard',?)", "folder-links", newGroup, now);
    seedConversation(db, "folder-links", 91960, 960);
    db.run("UPDATE conversations SET support_group_id=? WHERE bot_id='folder-links' AND user_id=91960", newGroup);
    db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,support_group_id,user_message_id,support_message_id,created_at) VALUES('folder-links',91960,960,?,12345,96960,?)", oldGroup, now);
    const update = groupUpdate(91960, 960, "");
    update.message.chat.id = newGroup;
    update.message.message_id = 96960;
    delete update.message.text;
    update.message.media_group_id = "new-group-album";
    update.message.photo = [{ file_id: "new-group-photo" }];
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter(call => call.method === "copyMessage" && call.body.from_chat_id === newGroup && call.body.message_id === 96960).length, 1);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_mappings WHERE bot_id='folder-links' AND support_group_id=? AND support_message_id=96960", newGroup).n, 1);
  });
});

test("reactions in a routed group use that service and historical private reactions touch the mapped group", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const oldGroup = -1001234567890;
    const newGroup = -100999000222;
    const now = new Date().toISOString();
    db.run("INSERT INTO support_groups(group_id,created_at,updated_at) VALUES(?,?,?)", newGroup, now, now);
    db.run("INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES(? ,?,'wizard',?)", "image-compress", newGroup, now);
    seedConversation(db, "image-compress", 91970, 970);
    db.run("UPDATE conversations SET support_group_id=? WHERE bot_id='image-compress' AND user_id=91970", newGroup);
    db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,support_group_id,user_message_id,support_message_id,created_at) VALUES('image-compress',91970,970,?,111,222,?)", newGroup, now);
    db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,support_group_id,user_message_id,support_message_id,created_at) VALUES('image-compress',91970,971,?,112,223,?)", oldGroup, now);
    db.run("INSERT INTO reaction_settings(bot_id,enabled,capability_verified,updated_at,verified_at) VALUES('image-compress',1,1,?,?)", now, now);
    env.RETENTION_ENABLED = "true";
    db.run("DELETE FROM storage_topics WHERE bot_id='image-compress'");
    const groupReaction = reactionUpdate(91970, newGroup, 222, 7, [{ type: "emoji", emoji: "👍" }]);
    groupReaction.message_reaction.chat.type = "supergroup";
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", groupReaction), env)).status, 200);
    assert.equal(calls.filter(call => call.method === "setMessageReaction" && call.token === "token-b" && call.body.chat_id === 91970).length, 1);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", reactionUpdate(91971, 91970, 112, 91970, [{ type: "emoji", emoji: "👀" }])), env)).status, 200);
    assert.equal(calls.filter(call => call.method === "setMessageReaction" && call.body.chat_id === oldGroup && call.body.message_id === 223).length, 1);
    assert.ok(db.get("SELECT id FROM storage_topics WHERE bot_id='image-compress' AND support_group_id=? AND thread_id=971", oldGroup));
    assert.equal(db.get("SELECT id FROM storage_topics WHERE bot_id='image-compress' AND support_group_id=? AND thread_id=971", newGroup), undefined);
  });
});
test("bot navigation: command scopes follow app roles, dashboard is pinned once, removed operators lose commands", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }]);
    db.run("INSERT INTO support_operators(user_id, first_name, added_by, added_by_name, added_at) VALUES(8, 'Operator', 7, 'Primary', ?)", new Date().toISOString());
    await runRecoveryCycle({}, env, null);
    const commandCalls = calls.filter(call => call.method === "setMyCommands");
    const primary = commandCalls.find(call => call.body.scope.user_id === 7);
    const operator = commandCalls.find(call => call.body.scope.user_id === 8);
    assert.ok(primary.body.commands.some(command => command.command === "messages" && command.description.includes("приветствия")));
    assert.ok(operator.body.commands.some(command => command.command === "menu"));
    assert.ok(!operator.body.commands.some(command => command.command === "messages" || command.command === "storage"));
    const primaryPrivate = commandCalls.find(call => call.body.scope.type === 'chat' && call.body.scope.chat_id === 7);
    assert.deepEqual(primaryPrivate.body.commands.map(command => command.command), ['addbot', 'cancel']);
    assert.ok(commandCalls.filter(call => call.body.scope.type !== "chat_member" && call !== primaryPrivate).every(call => call.body.commands.length === 0));
    const dashboards = calls.filter(call => call.method === "sendMessage" && call.body.text.startsWith("Управление поддержкой\n"));
    assert.equal(dashboards.length, 1);
    assert.ok(calls.some(call => call.method === "pinChatMessage" && call.body.message_id === db.get("SELECT dashboard_message_id FROM bot_ui_state").dashboard_message_id));
    const count = calls.length;
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.length, count, "unchanged menus and dashboard do not generate Telegram traffic");
    db.run("UPDATE support_operators SET active = 0 WHERE user_id = 8");
    await runRecoveryCycle({}, env, null);
    assert.ok(calls.slice(count).some(call => call.method === "setMyCommands" && call.body.scope.user_id === 8 && call.body.commands.length === 0));
  });
});
test("bot navigation: a ready manager menu removes legacy General and private commands from the service bot", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }]);
    await runRecoveryCycle({}, env, null);
    const before = calls.length;
    const now = new Date().toISOString();
    db.run("INSERT INTO support_groups(group_id,menu_message_id,menu_state,created_at,updated_at) VALUES(?,336,'ready',?,?)",
      Number(env.SUPPORT_GROUP_ID), now, now);
    db.run("INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES('folder-links',?,'legacy',?)",
      Number(env.SUPPORT_GROUP_ID), now);
    env.MANAGER_BOT_TOKEN = "manager-token";
    env.MANAGER_BOT_USERNAME = "manager_bot";
    db.run("UPDATE recovery_scheduler SET next_job=33 WHERE id=1");
    await runCountedRecovery({}, env);
    const updated = calls.slice(before).filter(call => call.method === "setMyCommands");
    const primary = updated.find(call => call.body.scope.type === "chat_member" && call.body.scope.user_id === 7);
    assert.ok(primary);
    assert.deepEqual(primary.body.commands.map(command => command.command), ['delete'], 'only customer message deletion remains in the service bot menu');
    const manager = updated.find(call => call.token === 'manager-token' && call.body.scope.type === 'chat');
    assert.deepEqual(manager?.body.commands.map(command => command.command), ['menu', 'case', 'close', 'open', 'status']);
    const primaryPrivate = updated.find(call => call.body.scope.type === "chat" && call.body.scope.chat_id === 7);
    assert.deepEqual(primaryPrivate?.body.commands, []);
    assert.equal(calls.slice(before).filter(call => call.method === "sendMessage" && call.body.text?.startsWith("Управление поддержкой\n")).length, 0);
  });
});
test('one manager command list replaces both service bot lists in a shared group', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const groupId = Number(env.SUPPORT_GROUP_ID), stamp = new Date().toISOString();
    db.run('INSERT INTO support_groups(group_id,menu_message_id,menu_state,created_at,updated_at) VALUES(?,777,\'ready\',?,?)',
      groupId, stamp, stamp);
    for (const config of registryValue) db.run(`INSERT INTO service_group_routes(bot_id,group_id,source,updated_at)
      VALUES(?,?,'legacy',?)`, config.id, groupId, stamp);
    env.MANAGER_BOT_TOKEN = 'manager-token';
    env.MANAGER_BOT_USERNAME = 'manager_bot';
    await runRecoveryCycle({}, env, null);
    const menus = calls.filter(call => call.method === 'setMyCommands'
      && call.body.scope.type === 'chat_member' && Number(call.body.scope.chat_id) === groupId);
    assert.ok(menus.some(call => call.token === 'token-a' && call.body.commands.length === 1 && call.body.commands[0].command === 'delete'));
    assert.ok(menus.some(call => call.token === 'token-b' && call.body.commands.length === 1 && call.body.commands[0].command === 'delete'));
    const managerMenus = calls.filter(call => call.token === 'manager-token' && call.method === 'setMyCommands'
      && call.body.scope.type === 'chat' && Number(call.body.scope.chat_id) === groupId);
    assert.equal(managerMenus.length, 1);
    assert.deepEqual(managerMenus[0].body.commands.map(command => command.command), ['menu', 'case', 'close', 'open', 'status']);
  });
});

test('manager publishes separate private slash menus for the primary and operators', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.MANAGER_BOT_TOKEN = 'manager-token';
    env.MANAGER_BOT_USERNAME = 'manager_bot';
    const stamp = new Date().toISOString();
    db.run("INSERT INTO support_groups(group_id,menu_message_id,menu_state,created_at,updated_at) VALUES(?,777,'ready',?,?)",
      Number(env.SUPPORT_GROUP_ID), stamp, stamp);
    db.run("INSERT INTO service_group_routes(bot_id,group_id,source,updated_at) VALUES('folder-links',?,'legacy',?)",
      Number(env.SUPPORT_GROUP_ID), stamp);
    db.run("INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at) VALUES(8,'Operator',1,7,'Primary',?)", stamp);
    for (let index = 0; index < 4; index++) await runRecoveryCycle({}, env, null);
    const managerMenus = calls.filter(call => call.token === 'manager-token' && call.method === 'setMyCommands');
    const privateFallback = managerMenus.find(call => call.body.scope.type === 'all_private_chats');
    const primary = managerMenus.find(call => call.body.scope.type === 'chat' && call.body.scope.chat_id === 7);
    const operator = managerMenus.find(call => call.body.scope.type === 'chat' && call.body.scope.chat_id === 8);
    assert.deepEqual(privateFallback?.body.commands.map(item => item.command), ['start']);
    assert.ok(primary?.body.commands.some(item => item.command === 'storage'));
    assert.ok(primary?.body.commands.some(item => item.command === 'alerts'));
    assert.ok(primary?.body.commands.some(item => item.command === 'addbot'));
    assert.ok(operator?.body.commands.some(item => item.command === 'mine'));
    assert.ok(!operator?.body.commands.some(item => item.command === 'addbot'));
    assert.ok(operator?.body.commands.some(item => item.command === 'reactions'));
    assert.ok(!operator?.body.commands.some(item => ['all', 'urgentall', 'metrics', 'health', 'storage', 'alerts'].includes(item.command)));
    assert.ok(!primary?.body.commands.some(item => item.command === 'user'), 'button search does not require /user');
    db.run('UPDATE support_operators SET active=0 WHERE user_id=8');
    await runRecoveryCycle({}, env, null);
    assert.ok(calls.some(call => call.token === 'manager-token' && call.method === 'deleteMyCommands'
      && call.body.scope.type === 'chat' && call.body.scope.chat_id === 8 && !call.body.language_code));
    assert.equal(db.get("SELECT COUNT(*) AS count FROM bot_command_scopes WHERE bot_id='__manager__' AND scope_json=?",
      JSON.stringify({ type: 'chat', chat_id: 8 })).count, 0);
    db.run("INSERT INTO support_operators(user_id,first_name,active,added_by,added_by_name,added_at) VALUES(9,'New operator',1,7,'Primary',?)", stamp);
    await runRecoveryCycle({}, env, null);
    assert.ok(calls.some(call => call.token === 'manager-token' && call.method === 'setMyCommands'
      && call.body.scope.type === 'chat' && call.body.scope.chat_id === 9
      && call.body.commands.some(item => item.command === 'mine')));
  });
});
test("bot navigation: a command selected from the owner bot menu works in another bot's Topic", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "image-compress", 911, 919);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(91920, 919, "/menu@FolderLinksSupportBot")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", groupUpdate(91920, 919, "/menu@FolderLinksSupportBot")), env)).status, 200);
    assert.ok(calls.some(call => call.method === "sendMessage" && call.body.message_thread_id === 919 && call.token === "token-b"));
    assert.equal(calls.filter(call => call.method === "sendMessage" && call.body.message_thread_id === 919).length, 1,
      "the addressed service bot forwards the command only once");
    assert.ok(!calls.some(call => call.method === "copyMessage"), "navigation never becomes a reply to the customer");
    calls.length = 0;
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(91921, 919, "A reply")), env);
    assert.equal(calls.length, 0, "ordinary replies retain original bot ownership rules");
  });
});
test("bot messages: Free ingress preserves first-message delivery and eventually sends one configured acknowledgement", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.TELEGRAM_COOLDOWN_ENABLED = "true";
    env.OPERATIONAL_HEALTH_ENABLED = "true";
    env.RETENTION_ENABLED = "true";
    env.STORAGE_GUARD_ENABLED = "true";
    setBotTexts(db, "folder-links", "", "Received");
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const update = privateUpdate(91930, 912);
    let response;
    for (let i = 0; i < 5; i++) {
      response = await countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", update), env);
      if (response.status === 200) break;
    }
    assert.equal(response.status, 200);
    assert.equal(autoReplyCalls(calls).length, 1, "acknowledgement should normally arrive during the webhook, without waiting for Cron");
    await runRecoveryCycle({}, env, null);
    assert.equal(autoReplyCalls(calls).length, 1);
    assert.equal(calls.filter(call => call.method === "forwardMessage").length, 1);
  });
});




test("bot navigation: concurrent cold /menu calls create one dashboard through real Free ingress", async () => {
  const started = deferred();
  const release = deferred();
  let first = true;
  await withFixture(async call => {
    if (first && call.method === "sendMessage" && call.body.text.startsWith("Support management\n")) {
      first = false; started.resolve(); await release.promise;
    }
  }, async ({ env, db, calls, fetchMock }) => {
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const send = update => countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", update), env);
    const a = send(groupUpdate(92000, 1, "/menu"));
    await started.promise;
    try {
      assert.equal((await send(groupUpdate(92001, 1, "/menu"))).status, 200);
    } finally { release.resolve(); }
    assert.equal((await a).status, 200);
    assert.equal(calls.filter(call => call.method === "sendMessage" && call.body.text.startsWith("Support management\n")).length, 2);
    assert.equal(calls.filter(call=>call.method==="pinChatMessage").length,1);
    assert.notEqual(db.get("SELECT message_id FROM operator_ui_sessions WHERE operator_id=7").message_id,db.get("SELECT dashboard_message_id FROM bot_ui_state").dashboard_message_id);
    assert.ok(db.get("SELECT dashboard_message_id FROM bot_ui_state WHERE bot_id='folder-links'").dashboard_message_id);
  });
});
test("bot messages: overlapping user messages claim one auto-reply while all messages are delivered", async () => {
  const started = deferred();
  const release = deferred();
  await withFixture(async call => {
    if (call.body.text === "Received") { started.resolve(); await release.promise; }
  }, async ({ env, db, calls }) => {
    setBotTexts(db, "folder-links", "", "Received");
    const a = worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(92010, 913)), env);
    await started.promise;
    try {
      assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(92011, 913)), env)).status, 200);
    } finally { release.resolve(); }
    assert.equal((await a).status, 200);
    assert.equal(autoReplyCalls(calls).length, 1);
    assert.equal(calls.filter(call => call.method === "forwardMessage").length, 2);
  });
});
test("bot navigation: General accepts a registered secondary bot's command and leaving the editor suspends its input", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.GENERAL_OWNER_GRACE_MS = "0";
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const send = update => countedFreeFetch(ingress, webhookRequest("image-compress", "secret-b", update), env);
    assert.equal((await send(groupUpdate(92020, 1, "/bots@ImageCompressSupportBot"))).status, 200);
    assert.ok(calls.some(call => call.body.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith("um:n:bot:"))));
    const key = managementBotKey(parseBotRegistry(env.BOT_REGISTRY), "image-compress");
    assert.equal((await send(callbackUpdate(92021, 1, "um:m:edit:" + key + ":a"))).status, 200);
    assert.ok(db.get("SELECT * FROM bot_message_flows WHERE owner_id=7"));
    assert.equal((await send(callbackUpdate(92022, 1, "um:n:bots"))).status, 200);
    assert.equal(db.get("SELECT suspended FROM bot_message_flows WHERE owner_id=7").suspended, 1);
    await send(groupUpdate(92023, 1, "Ordinary group conversation"));
    assert.equal(db.get("SELECT COUNT(*) n FROM bot_message_settings").n, 0);
  });
});


const registryValue = [
  {
    id: "folder-links",
    displayName: "Folder Links",
    topicPrefix: "Folder Links",
    tokenBinding: "BOT_FOLDER_LINKS_TOKEN",
    webhookSecretBinding: "BOT_FOLDER_LINKS_WEBHOOK_SECRET",
    username: "FolderLinksSupportBot",
    enabled: true,
    groupCommandOwner: true,
  },
  {
    id: "image-compress",
    displayName: "Image Compress",
    topicPrefix: "Image Compress",
    tokenBinding: "BOT_IMAGE_COMPRESS_TOKEN",
    webhookSecretBinding: "BOT_IMAGE_COMPRESS_WEBHOOK_SECRET",
    username: "ImageCompressSupportBot",
    enabled: true,
  },
];

// Independent Bot API catalog fixture, retrieved 2026-09-14 from ReactionTypeEmoji.
const standardReactionCatalog = [
  "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢",
  "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳",
  "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓",
  "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈",
  "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿",
  "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀",
  "😡",
];

function defaultTelegramReply(method, body, state) {
  if (method === "createForumTopic") return { ok: true, result: { message_thread_id: ++state.threadId } };
  if (method === "forwardMessage") {
    return { ok: true, result: { message_id: ++state.messageId, ...(body.message_thread_id ? { message_thread_id: body.message_thread_id } : {}) } };
  }
  if (method === "copyMessage") return { ok: true, result: { message_id: ++state.messageId } };
  if (method === "copyMessages") return { ok: true, result: body.message_ids.map(() => ({ message_id: ++state.messageId })) };
  if (method === "sendMessage") {
    return { ok: true, result: { chat: { id: Number(body.chat_id) }, message_id: ++state.messageId, ...(body.message_thread_id ? { message_thread_id: body.message_thread_id } : {}) } };
  }
  if (method === "sendMediaGroup") {
    return {
      ok: true,
      result: body.media.map(() => ({ message_id: ++state.messageId, ...(body.message_thread_id ? { message_thread_id: body.message_thread_id } : {}) })),
    };
  }
  if (method === "setMessageReaction") {
    assert.ok(Array.isArray(body.reaction));
    assert.ok(body.reaction.length <= 1);
    if (body.reaction.length === 1) {
      assert.equal(body.reaction[0].type, "emoji");
      assert.ok(standardReactionCatalog.includes(body.reaction[0].emoji));
    }
    return { ok: true, result: true };
  }
  if (method === "getMe") return { ok: true, result: { id: 9001 } };
  if (method === "getChatMember") return { ok: true, result: { status: "administrator", can_manage_topics: true } };
  return { ok: true, result: true };
}

function makeFixture(handler) {
  const db = new TestD1();
  const calls = [];
  const state = { threadId: 50, messageId: 1000 };
  const limitCalls = [];
  const limiter = (name) => ({ limit: async ({ key }) => { limitCalls.push({ name, key }); return { success: true }; } });
  const env = {
    SUPPORT_DB: db,
    SUPPORT_GROUP_ID: "-1001234567890",
    BOT_REGISTRY: JSON.stringify(registryValue),
    BOT_FOLDER_LINKS_TOKEN: "token-a",
    BOT_FOLDER_LINKS_WEBHOOK_SECRET: "secret-a",
    BOT_IMAGE_COMPRESS_TOKEN: "token-b",
    BOT_IMAGE_COMPRESS_WEBHOOK_SECRET: "secret-b",
    ADMIN_IDS: "7",
    // Business/failure-injection scenarios may span more than one Free turn.
    // Dedicated ingress tests below exercise Free retries and eventual delivery.
    RECOVERY_D1_PLAN: "paid",
    ALBUM_SETTLE_MS: "10",
    PUBLIC_BASE_URL: "https://support.example.workers.dev",
    ABUSE_BURST_LIMITER: limiter("burst"),
    ABUSE_MINUTE_LIMITER: limiter("minute"),
    ABUSE_ABSOLUTE_LIMITER: limiter("absolute"),
    VERIFY_LIMITER: limiter("verify"),
    REACTION_LIMITER: limiter("reaction"),
  };
  const fetchMock = async (url, options) => {
    if (String(url) === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      const call = { token: null, method: "siteverify", body: String(options.body) };
      calls.push(call);
      const custom = await handler?.(call, calls, state);
      const answer = custom || { success: true, action: "support_verify", hostname: "support.example.workers.dev" };
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }
    const match = String(url).match(/\/bot([^/]+)\/([^/?]+)$/);
    assert.ok(match, `unexpected Telegram URL: ${url}`);
    const [, token, method] = match;
    const body = JSON.parse(options.body);
    const call = { token, method, body };
    calls.push(call);
    const custom = await handler?.(call, calls, state);
    const answer = custom || defaultTelegramReply(method, body, state);
    const status = answer.httpStatus || (answer.ok ? 200 : Number(answer.error_code) || 400);
    const payload = { ...answer };
    delete payload.httpStatus;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { db, calls, env, fetchMock, state, limitCalls };
}

async function withFixture(handler, callback) {
  const fixture = makeFixture(handler);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fixture.fetchMock;
  try {
    return await callback(fixture);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.db.close();
  }
}

async function runCountedRecovery(event, env) {
  const scope = { queries: 0 };
  await recoveryQueryScope.run(scope, () => worker.scheduled(event, { ...env, RECOVERY_D1_PLAN: "free" }, null));
  assert.ok(scope.queries <= 45, `Recovery used ${scope.queries} D1 statements`);
  return scope.queries;
}

// Existing scenario tests cover a full fair sweep, now split across invocations.
async function runRecoveryCycle(event, env, ctx) {
  const run = async () => {
    const jobs = JSON.parse(env.BOT_REGISTRY).filter((bot) => bot.enabled).length * 17 + 3;
    for (let i = 0; i < jobs; i++) {
      await runCountedRecovery(event, env);
    }
  };
  if (ctx?.waitUntil) ctx.waitUntil(run());
  else await run();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function webhookRequest(botId, secret, update) {
  return new Request(`https://support.example.workers.dev/tg/${botId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify(update),
  });
}

function privateUpdate(updateId, userId, messageId = updateId) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: userId, type: "private" },
      from: { id: userId, first_name: "Alex", username: `user${userId}` },
      text: "hello",
    },
  };
}

function groupUpdate(updateId, threadId, text, fromId = 7) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 5000,
      message_thread_id: threadId,
      chat: { id: -1001234567890, type: "supergroup" },
      from: { id: fromId, first_name: "Operator" },
      text,
    },
  };
}

function callbackUpdate(updateId, threadId, data, fromId = 7) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: fromId, first_name: "Operator" },
      data,
      message: {
        message_id: updateId + 6000,
        message_thread_id: threadId,
        chat: { id: -1001234567890, type: "supergroup" },
      },
    },
  };
}

function reactionUpdate(updateId, chat, messageId, userId, newReaction, oldReaction = []) {
  return {
    update_id: updateId,
    message_reaction: {
      chat: { id: chat, type: chat === -1001234567890 ? "supergroup" : "private" },
      message_id: messageId,
      user: { id: userId, first_name: userId === 7 ? "Operator" : "Alex", is_bot: false },
      date: Math.floor(Date.now() / 1000),
      old_reaction: oldReaction,
      new_reaction: newReaction,
    },
  };
}

async function startReactionProbe(fixture, id = 'image-compress') {
  const { env, db, fetchMock } = fixture;
  env.RECOVERY_D1_PLAN = 'free';
  env.BOT_ONBOARDING_ENABLED = 'true'; env.BOT_REGISTRY_KEY = 'ab'.repeat(32);
  env.TELEGRAM_COOLDOWN_ENABLED = 'true'; env.OPERATIONAL_HEALTH_ENABLED = 'true';
  env.RETENTION_ENABLED = 'true'; env.STORAGE_GUARD_ENABLED = 'true';
  const ingress = createRegistrationWorker(createControlPlaneWorker(undefined, fetchMock), fetchMock);
  const key = managementBotKey(registryValue, id);
  const send = (update, botId = 'folder-links', secret = 'secret-a') => countedFreeFetch(ingress, webhookRequest(botId, secret, update), env);
  assert.equal((await send(callbackUpdate(310000, 1, `um:r:test:${key}`))).status, 200);
  const waiting = db.get('SELECT * FROM reaction_checks WHERE bot_id = ?', id);
  assert.equal(waiting.state, 'waiting');
  const update = privateUpdate(310001, 7); update.message.text = `/start rx_${waiting.nonce}`;
  assert.equal((await send(update, id, id === 'folder-links' ? 'secret-a' : 'secret-b')).status, 200);
  const row = db.get('SELECT * FROM reaction_checks WHERE bot_id = ?', id);
  assert.equal(row.state, 'ready');
  return { send, row, key, ingress };
}

test('reaction check: both directions automatically enable after verified Free ingress', async () => {
  await withFixture(null, async fixture => {
    const { db, calls } = fixture;
    const { send, row, key } = await startReactionProbe(fixture);
    assert.equal(calls.filter(c => c.method === 'setWebhook').every(c => c.body.allowed_updates.includes('managed_bot')), true);
    assert.deepEqual(calls.filter(c => c.method === 'setWebhook').map(c => c.token).sort(), ['token-a', 'token-b']);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM conversations').n, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM user_abuse_state').n, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM message_mappings').n, 0);
    assert.equal(calls.some(c => ['createForumTopic', 'forwardMessage', 'copyMessage'].includes(c.method)), false);
    assert.equal(calls.filter(c => c.method === 'sendMessage' && c.token === 'token-b').length, 2);
    const emoji = value => value ? [{ type: 'emoji', emoji: value }] : [];
    // A step cannot be skipped, and the selected non-owner's group update is
    // not evidence that the normal command-owner reaction route works.
    await send(reactionUpdate(310002, row.group_id, row.group_message_id, 7, emoji('👀')));
    await send(reactionUpdate(310003, row.group_id, row.group_message_id, 7, emoji('👍')), 'image-compress', 'secret-b');
    assert.equal(db.get('SELECT support_step FROM reaction_checks').support_step, 0);
    for (const [index, value] of ['👍', '👀', null].entries()) {
      const event = reactionUpdate(310010 + index, row.group_id, row.group_message_id, 7, emoji(value), index ? emoji(['👍', '👀'][index - 1]) : []);
      assert.equal((await send(event)).status, 200);
      assert.equal((await send(event)).status, 200);
    }
    let settings = db.get('SELECT * FROM reaction_settings WHERE bot_id = ?', row.bot_id);
    assert.equal(settings.support_to_user_verified, 1);
    assert.equal(settings.support_to_user_enabled, 0);
    assert.equal(settings.user_to_support_verified, null);
    assert.equal(settings.enabled, 0);
    assert.equal(calls.filter(c => c.method === 'setMessageReaction').length, 3);
    assert.equal((await send(callbackUpdate(310020, 1, `um:r:set:${key}:on:0`))).status, 200);
    settings = db.get('SELECT * FROM reaction_settings WHERE bot_id = ?', row.bot_id);
    assert.equal(settings.support_to_user_enabled, 1);
    assert.equal(settings.user_to_support_enabled, 0);
    assert.equal((await send(callbackUpdate(310021, 1, `um:r:set:${key}:on:1`))).status, 200);
    assert.equal(db.get('SELECT user_to_support_enabled FROM reaction_settings WHERE bot_id = ?', row.bot_id).user_to_support_enabled, 0);
    for (const [index, value] of ['👍', '👀', null].entries()) {
      const event = reactionUpdate(310030 + index, 7, row.private_message_id, 7, emoji(value), index ? emoji(['👍', '👀'][index - 1]) : []);
      assert.equal((await send(event, row.bot_id, 'secret-b')).status, 200);
    }
    settings = db.get('SELECT * FROM reaction_settings WHERE bot_id = ?', row.bot_id);
    assert.equal(settings.user_to_support_verified, 1);
    assert.equal(settings.user_to_support_enabled, 1);
    assert.equal(settings.support_to_user_enabled, 1);
    assert.equal(settings.enabled, 1);
    assert.equal(calls.filter(c => c.method === 'setMessageReaction').length, 6);
    assert.equal(calls.filter(c => c.method === 'setMessageReaction').every(c => c.token === 'token-b'), true);
    assert.ok(calls.some(c => c.method === 'editMessageText' && /verified \(3\/3\)/.test(c.body.text)));
    for (const call of calls) for (const button of call.body.reply_markup?.inline_keyboard?.flat() || []) {
      if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    }
  });
});

test('reaction check: only primary General can start, primary DM can open, stale/foreign probe buttons cannot close', async () => {
  await withFixture(null, async fixture => {
    const { env, db } = fixture;
    const key = managementBotKey(registryValue, 'image-compress');
    for (const [id, thread, actor] of [[312001, 1, 8], [312002, 50, 7]]) {
      await worker.fetch(webhookRequest('folder-links', 'secret-a', callbackUpdate(id, thread, `um:r:test:${key}`, actor)), env);
    }
    assert.equal(db.get('SELECT COUNT(*) AS n FROM reaction_checks').n, 0);
    const { send, row } = await startReactionProbe(fixture);
    const forged = callbackUpdate(312005, 1, `rx:stop:${row.nonce}`);
    assert.equal((await send(forged, row.bot_id, 'secret-b')).status, 200);
    assert.equal(db.get('SELECT state FROM reaction_checks').state, 'ready');
    forged.update_id++; forged.callback_query.message.message_id = row.group_message_id; forged.callback_query.from.id = 8;
    assert.equal((await send(forged, row.bot_id, 'secret-b')).status, 200);
    assert.equal(db.get('SELECT state FROM reaction_checks').state, 'ready');
    const open = privateUpdate(312009, 8); open.message.text = `/start rx_${row.nonce}`;
    await send(open, row.bot_id, 'secret-b');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM conversations').n, 0);
    forged.update_id++; forged.callback_query.from.id = 7;
    await send(forged, row.bot_id, 'secret-b');
    assert.equal(db.get('SELECT state FROM reaction_checks').state, 'closed');
    await send(reactionUpdate(312020, row.group_id, row.group_message_id, 7, [{ type: 'emoji', emoji: '👍' }]));
    assert.equal(db.get('SELECT support_step FROM reaction_checks').support_step, 0);
  });
});

test('reaction check: timeout, unavailable Telegram and bot-origin events never pass the gate', async () => {
  await withFixture(call => call.method === 'setMessageReaction' ? { ok: false, error_code: 400, description: 'REACTION_INVALID' } : null, async fixture => {
    const { db, calls } = fixture;
    const { send, row } = await startReactionProbe(fixture);
    const event = reactionUpdate(313001, row.group_id, row.group_message_id, 7, [{ type: 'emoji', emoji: '👍' }]);
    await send(event);
    assert.equal(db.get('SELECT support_step FROM reaction_checks').support_step, 0);
    assert.equal(db.get('SELECT support_error FROM reaction_checks').support_error, 'telegram_unconfirmed');
    assert.equal(db.get('SELECT support_to_user_verified FROM reaction_settings WHERE bot_id = ?', row.bot_id).support_to_user_verified, null);
    event.update_id++; event.message_reaction.user.is_bot = true;
    await send(event);
    assert.equal(calls.filter(c => c.method === 'setMessageReaction').length, 1);
    db.run("UPDATE reaction_checks SET expires_at = '2000-01-01T00:00:00.000Z'");
    event.update_id++; event.message_reaction.user.is_bot = false;
    await send(event);
    assert.equal(calls.filter(c => c.method === 'setMessageReaction').length, 1);
    const refresh = callbackUpdate(313004, 1, `rx:refresh:${row.nonce}`);
    refresh.callback_query.message.message_id = row.group_message_id;
    await send(refresh, row.bot_id, 'secret-b');
    assert.ok(calls.some(c => c.method === 'editMessageText' && /not confirmed/.test(c.body.text)));
  });
});

test('reaction check: duplicate open and restart fence old messages; settings off preserves an active test subscription', async () => {
  await withFixture(null, async fixture => {
    const { db, calls } = fixture;
    const { send, row, key } = await startReactionProbe(fixture);
    const open = privateUpdate(314001, 7); open.message.text = `/start rx_${row.nonce}`;
    await send(open, row.bot_id, 'secret-b');
    assert.equal(calls.filter(c => c.method === 'sendMessage' && c.token === 'token-b').length, 2);
    await send(callbackUpdate(314002, 1, `um:r:set:${key}:off`));
    assert.ok(calls.filter(c => c.method === 'setWebhook').slice(-2).every(c => c.body.allowed_updates.includes('message_reaction') && c.body.allowed_updates.includes('managed_bot')));
    await send(callbackUpdate(314003, 1, `um:r:stop:${key}:${row.nonce}`));
    assert.equal(db.get('SELECT state FROM reaction_checks').state, 'closed');
    await send(callbackUpdate(314004, 1, `um:r:test:${key}`));
    assert.notEqual(db.get('SELECT nonce FROM reaction_checks').nonce, row.nonce);
    await send(callbackUpdate(314005, 1, `um:r:stop:${key}:${row.nonce}`));
    assert.equal(db.get('SELECT state FROM reaction_checks').state, 'waiting');
    await send(reactionUpdate(314006, row.group_id, row.group_message_id, 7, [{ type: 'emoji', emoji: '👍' }]));
    assert.equal(db.get('SELECT support_step FROM reaction_checks').support_step, 0);
  });
});

test('reaction check: uncertain probe send is not repeated automatically', async () => {
  let fail = true;
  await withFixture((call, calls, state) => {
    if (fail && call.method === 'sendMessage' && call.token === 'token-b' && call.body.text.includes('Preparing')) {
      fail = false; return { ok: false, error_code: 503, httpStatus: 503, description: 'Unknown send outcome' };
    }
  }, async ({ env, db, calls }) => {
    const key = managementBotKey(registryValue, 'image-compress');
    await worker.fetch(webhookRequest('folder-links', 'secret-a', callbackUpdate(315001, 1, `um:r:test:${key}`)), env);
    const row = db.get('SELECT * FROM reaction_checks');
    const open = privateUpdate(315002, 7); open.message.text = `/start rx_${row.nonce}`;
    await worker.fetch(webhookRequest(row.bot_id, 'secret-b', open), env);
    assert.equal(db.get('SELECT state FROM reaction_checks').state, 'failed');
    open.update_id++;
    await worker.fetch(webhookRequest(row.bot_id, 'secret-b', open), env);
    assert.equal(calls.filter(c => c.method === 'sendMessage' && c.token === 'token-b' && c.body.text.includes('Preparing')).length, 1);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM conversations').n, 0);
  });
});

test('reaction directions: one verified direction mirrors only its permitted side', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, 'image-compress', 1600, 86);
    db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('image-compress',1600,86,200,300,?)", new Date().toISOString());
    db.run("INSERT INTO reaction_settings(bot_id,enabled,capability_verified,support_to_user_verified,support_to_user_enabled,updated_at) VALUES('image-compress',1,0,1,1,?)", new Date().toISOString());
    const emoji = [{ type: 'emoji', emoji: '👍' }];
    await worker.fetch(webhookRequest('image-compress', 'secret-b', reactionUpdate(316001, 1600, 200, 1600, emoji)), env);
    assert.equal(calls.some(c => c.method === 'setMessageReaction'), false);
    await worker.fetch(webhookRequest('folder-links', 'secret-a', reactionUpdate(316002, -1001234567890, 300, 7, emoji)), env);
    assert.equal(calls.filter(c => c.method === 'setMessageReaction').length, 1);
    assert.equal(calls.find(c => c.method === 'setMessageReaction').body.chat_id, 1600);
  });
});

test('reaction check: D1 proof failure retries the idempotent reaction and does not skip a step', async () => {
  await withFixture(null, async fixture => {
    const { db, calls } = fixture;
    const { send, row } = await startReactionProbe(fixture);
    db.failOnce('INSERT INTO reaction_settings(bot_id, enabled, support_to_user_enabled');
    const event = reactionUpdate(317001, row.group_id, row.group_message_id, 7, [{ type: 'emoji', emoji: '👍' }]);
    assert.equal((await send(event)).status, 500);
    assert.equal(db.get('SELECT support_step FROM reaction_checks').support_step, 0);
    assert.equal(db.get('SELECT lease_token FROM reaction_checks').lease_token, null);
    assert.equal((await send(event)).status, 200);
    assert.equal(db.get('SELECT support_step FROM reaction_checks').support_step, 1);
    assert.equal(calls.filter(c => c.method === 'setMessageReaction').length, 2);
    assert.equal(db.get('SELECT support_to_user_verified FROM reaction_settings WHERE bot_id = ?', row.bot_id).support_to_user_verified, null);
  });
});

test('reaction check: concurrent steps serialize and disabled target cannot earn a capability', async () => {
  const started = deferred(); const unblock = deferred(); let pause = true;
  await withFixture(async call => {
    if (call.method === 'setMessageReaction' && pause) { pause = false; started.resolve(); await unblock.promise; }
  }, async fixture => {
    const { db } = fixture;
    const { send, row } = await startReactionProbe(fixture);
    const first = send(reactionUpdate(318001, row.group_id, row.group_message_id, 7, [{ type: 'emoji', emoji: '👍' }]));
    await started.promise;
    const second = reactionUpdate(318002, row.group_id, row.group_message_id, 7, [{ type: 'emoji', emoji: '👀' }], [{ type: 'emoji', emoji: '👍' }]);
    try { assert.equal((await send(second)).status, 500); } finally { unblock.resolve(); }
    assert.equal((await first).status, 200);
    assert.equal((await send(second)).status, 200);
    assert.equal(db.get('SELECT support_step FROM reaction_checks').support_step, 2);
    db.run('UPDATE bots SET enabled = 0 WHERE id = ?', row.bot_id);
    await send(reactionUpdate(318003, row.group_id, row.group_message_id, 7, [], [{ type: 'emoji', emoji: '👀' }]));
    assert.equal(db.get('SELECT support_step FROM reaction_checks').support_step, 2);
    assert.equal(db.get('SELECT support_to_user_verified FROM reaction_settings WHERE bot_id = ?', row.bot_id).support_to_user_verified, null);
  });
});

for (const plan of ["free", "paid"]) test(`Telegram cooldown: ${plan} retries after restart without marking an unsent message uncertain`, async () => {
  let reject = true;
  await withFixture((call) => {
    if (reject && call.method === "forwardMessage") {
      reject = false;
      return { ok: false, error_code: 429, parameters: { retry_after: 3600 }, description: "Flood control" };
    }
  }, async ({ db, env, calls }) => {
    env.RECOVERY_D1_PLAN = plan;
    env.TELEGRAM_COOLDOWN_ENABLED = "true";
    seedConversation(db, "folder-links", 7800, 780);
    const update = privateUpdate(78001, 7800);
    for (let retry = 0; retry < 5 && reject; retry++) await worker.fetch(webhookRequest("folder-links", "secret-a", update), env, {});
    assert.equal(reject, false);
    assert.ok(db.get("SELECT not_before FROM telegram_cooldowns WHERE bot_key = 'service:folder-links'"));
    const before = calls.length;
    const paused = await worker.fetch(webhookRequest("folder-links", "secret-a", update), env, {});
    assert.equal(paused.status, 503);
    assert.equal(calls.length, before);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_delivery_attempts WHERE failure_code = 'telegram_delivery_outcome_unknown'").n, 0);
    db.run("UPDATE telegram_cooldowns SET not_before = '2000-01-01T00:00:00.000Z'");
    for (let retry = 0; retry < 10 && !db.get("SELECT id FROM message_mappings WHERE bot_id = 'folder-links' AND user_message_id = 78001"); retry++) {
      await worker.fetch(webhookRequest("folder-links", "secret-a", update), env, {});
    }
    assert.ok(db.get("SELECT id FROM message_mappings WHERE bot_id = 'folder-links' AND user_message_id = 78001"));
    assert.equal(calls.filter((call) => call.method === "forwardMessage").length, 2);
  });
});

for (const plan of ['free', 'paid']) test(`operational features: ${plan} preserves delivery and exposes storage during reset`, async () => {
  await withFixture(null, async ({ db, env, calls }) => {
    Object.assign(env, { RECOVERY_D1_PLAN: plan, RETENTION_ENABLED: 'true', TELEGRAM_COOLDOWN_ENABLED: 'true', OPERATIONAL_HEALTH_ENABLED: 'true' });
    seedConversation(db, 'folder-links', 7900, 790);
    const update = privateUpdate(79001, 7900);
    for (let n = 0; n < 12 && !db.get("SELECT id FROM message_mappings WHERE user_message_id = 79001"); n++) {
      const response = await worker.fetch(webhookRequest('folder-links', 'secret-a', update), env, {});
      assert.ok([200, 503].includes(response.status), `unexpected response ${response.status}`);
    }
    assert.ok(db.get('SELECT id FROM message_mappings WHERE user_message_id = 79001'));
    assert.equal(calls.filter((call) => call.method === 'forwardMessage').length, 1);
    assert.equal(db.get("SELECT activity_known FROM storage_topics WHERE user_id = 7900").activity_known, 1);
    db.run("UPDATE storage_control SET mode = 'reset', generation = 1");
    const before = calls.length;
    const blocked = await worker.fetch(webhookRequest('folder-links', 'secret-a', privateUpdate(79002, 7900)), env, {});
    assert.equal(blocked.status, 503);
    assert.equal(calls.length, before);
    const panel = await worker.fetch(webhookRequest('folder-links', 'secret-a', groupUpdate(79003, undefined, '/storage')), env, {});
    assert.equal(panel.status, 200);
    assert.ok(calls.some((call) => call.method === 'sendMessage' && /Full cleanup/.test(call.body.text)));
  });
});

for (const plan of ['free', 'paid']) test(`operational features: ${plan} first contact, operator reply and old-message reaction remain functional`, async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    Object.assign(env, { RECOVERY_D1_PLAN: plan, RETENTION_ENABLED: 'true', STORAGE_GUARD_ENABLED: 'true', TELEGRAM_COOLDOWN_ENABLED: 'true', OPERATIONAL_HEALTH_ENABLED: 'true' });
    const inbound = privateUpdate(79101, 7910);
    for (let n = 0; n < 12 && !db.get('SELECT id FROM message_mappings WHERE user_message_id = 79101'); n++) {
      const response = await worker.fetch(webhookRequest('folder-links', 'secret-a', inbound), env, {});
      assert.ok([200, 503].includes(response.status));
    }
    const conversation = db.get('SELECT * FROM conversations WHERE user_id = 7910');
    assert.ok(conversation);
    assert.ok(db.get('SELECT id FROM message_mappings WHERE user_message_id = 79101'));
    assert.equal(calls.filter((call) => call.method === 'createForumTopic').length, 1);
    const outgoing = groupUpdate(79102, conversation.thread_id, 'Reply');
    for (let n = 0; n < 12 && !db.get('SELECT id FROM message_mappings WHERE support_message_id = ?', outgoing.message.message_id); n++) {
      const response = await worker.fetch(webhookRequest('folder-links', 'secret-a', outgoing), env, {});
      assert.ok([200, 503].includes(response.status));
    }
    assert.ok(db.get('SELECT id FROM message_mappings WHERE support_message_id = ?', outgoing.message.message_id));
    const timestamp = new Date().toISOString();
    db.run("INSERT INTO reaction_settings(bot_id,enabled,capability_verified,updated_at,verified_at) VALUES ('folder-links',1,1,?,?)", timestamp, timestamp);
    db.run("UPDATE storage_topics SET state = 'missing_confirmed', last_activity = '2020-01-01T00:00:00.000Z'");
    const reaction = reactionUpdate(79103, 7910, 79101, 7910, [{ type: 'emoji', emoji: '👍' }]);
    const response = await worker.fetch(webhookRequest('folder-links', 'secret-a', reaction), env, {});
    assert.equal(response.status, 200);
    assert.equal(db.get('SELECT state FROM storage_topics WHERE user_id = 7910').state, 'present');
    assert.equal(calls.filter((call) => call.method === 'setMessageReaction').length, 1);
  });
});

for (const plan of ['free', 'paid']) for (const replyToOperator of [false, true])
for (const outgoingType of ['text', 'photo', 'album'])
test(`reopen latency: ${plan} operator-first ${outgoingType}, reply=${replyToOperator}, delivers without Cron`, async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = plan;
    env.TELEGRAM_COOLDOWN_ENABLED = 'true';
    env.OPERATIONAL_HEALTH_ENABLED = 'true';
    env.RETENTION_ENABLED = 'true';
    env.STORAGE_GUARD_ENABLED = 'true';
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: 'ru' }]);
    const receiptText = 'Обращение передано в поддержку.';
    setBotTexts(db, 'folder-links', '', receiptText);
    seedConversation(db, 'folder-links', 62101, 221);
    db.run("UPDATE conversations SET status='closed', panel_message_id=999, last_message_at=? WHERE user_id=62101", new Date(Date.now() - 2 * 86400000).toISOString());
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const send = async update => {
      const scope = { queries: 0, limit: plan === 'free' ? 50 : 1000 };
      const response = await recoveryQueryScope.run(scope, () => ingress.fetch(webhookRequest('folder-links', 'secret-a', update), env));
      assert.ok(scope.queries <= scope.limit);
      return response;
    };
    const outgoing = groupUpdate(62100, 221, 'Following up');
    if (outgoingType !== 'text') {
      delete outgoing.message.text;
      outgoing.message.photo = [{ file_id: 'operator-photo' }];
      if (outgoingType === 'album') outgoing.message.media_group_id = 'operator-first-album';
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await send(outgoing);
      assert.ok([200, 503].includes(response.status));
      if (response.ok) break;
      await runRecoveryCycle({}, env, null);
    }
    const outgoingMapping = db.get('SELECT user_message_id FROM message_mappings WHERE support_message_id=?', outgoing.message.message_id);
    assert.ok(outgoingMapping);
    assert.equal(autoReplyCalls(calls, receiptText).length, 0, 'An operator follow-up must not acknowledge an inbound message');
    const update = privateUpdate(62101, 62101);
    if (replyToOperator) update.message.reply_to_message = { message_id: outgoingMapping.user_message_id };
    for (let i = 0; i < 5; i++) {
      const before = calls.length;
      const response = await send(update);
      const effects = calls.slice(before);
      // A successful routing probe must be followed by delivery in that turn.
      if (effects.some(c => c.method === 'sendMessage' && c.body.text === '🔎')) {
        assert.ok(effects.some(c => c.method === 'copyMessage' && c.body.message_id === 62101));
      }
      assert.ok([200, 503].includes(response.status));
      if (response.ok) break;
    }
    assert.ok(db.get('SELECT delivered_at FROM reopen_business_messages WHERE user_id=62101')?.delivered_at);
    assert.ok(db.get('SELECT completed_at FROM conversation_reopen_effects WHERE user_id=62101')?.completed_at);
    assert.equal(db.get('SELECT state FROM processed_updates WHERE update_id=62101')?.state, 'completed');
    const receipt = db.get('SELECT state, source_message_id, sent_at FROM conversation_auto_replies WHERE user_id=62101');
    assert.equal(receipt.state, 'disabled', 'An operator-first conversation must stay silent when the user replies');
    assert.equal(receipt.sent_at, null);
    assert.equal((await send(update)).status, 200);
    const delivered = calls.filter(c => c.method === 'copyMessage' && c.body.message_id === 62101);
    assert.equal(delivered.length, 1);
    const receipts = autoReplyCalls(calls, receiptText);
    assert.equal(receipts.length, 0, 'An operator-first conversation must not emit a configured receipt on delivery or replay');
    if (replyToOperator) assert.equal(delivered[0].body.reply_parameters.message_id, outgoing.message.message_id);
    assert.equal(calls.filter(c => c.method === 'reopenForumTopic').length, 1);
    const markers = calls.filter(c => c.method === 'sendMessage' && c.body.text === '🔄 Пользователь возобновил обращение.');
    assert.equal(markers.length, 1);
    const probes = calls.filter(c => c.method === 'sendMessage' && c.body.text === '🔎');
    assert.equal(probes.length, 1);
    assert.equal(probes[0].body.disable_notification, true);
    const markerId = db.get('SELECT marker_message_id FROM conversation_reopen_effects WHERE user_id=62101').marker_message_id;
    assert.equal(calls.some(c => c.method === 'deleteMessage' && c.body.message_id === markerId), false);
    assert.equal(db.get('SELECT COUNT(*) n FROM abuse_decision_locks').n, 0);
    await runRecoveryCycle({}, env, null);
    assert.equal(autoReplyCalls(calls, receiptText).length, 0, 'Cron must not send a delayed receipt either');
    // Silence belongs to this cycle, not to this user forever.
    const closed = groupUpdate(62102, 221, '');
    delete closed.message.text;
    closed.message.forum_topic_closed = {};
    assert.equal((await send(closed)).status, 200);
    assert.equal(db.get('SELECT state FROM conversation_auto_replies WHERE user_id=62101').state, 'waiting');
    const next = privateUpdate(62103, 62101);
    for (let attempt = 0; attempt < 5; attempt++) if ((await send(next)).ok) break;
    await runRecoveryCycle({}, env, null);
    assert.equal(autoReplyCalls(calls, receiptText).length, 1, 'A later user-first cycle still gets its configured receipt');
  });
});

for (const uncertain of [false, true]) test(`operator-first receipt: an unconfirmed outgoing message does not suppress a new user request; uncertain=${uncertain}`, async () => {
  await withFixture(call => {
    if (call.method === 'copyMessage' && call.body.chat_id === 62104) {
      return { ok: false, error_code: uncertain ? 502 : 403, description: uncertain ? 'response lost' : 'Forbidden: user is deactivated' };
    }
  }, async ({ env, db, calls }) => {
    seedConversation(db, 'folder-links', 62104, 222);
    db.run("UPDATE conversations SET status='closed' WHERE user_id=62104");
    setBotTexts(db, 'folder-links', '', 'Received');
    const outgoing = groupUpdate(62104, 222, 'Following up');
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', outgoing), env)).status, 200);
    assert.equal(db.get('SELECT state FROM conversation_auto_replies WHERE user_id=62104').state, 'waiting');
    const incoming = privateUpdate(62105, 62104);
    assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', incoming), env)).status, 200);
    assert.equal(autoReplyCalls(calls).length, 1);
  });
});

function seedConversation(db, botId, userId, threadId) {
  db.run(
    "INSERT INTO conversations (bot_id, user_id, username, first_name, support_group_id, thread_id, status, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)",
    botId,
    userId,
    `user${userId}`,
    "Alex",
    -1001234567890,
    threadId,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

function seedOperator(db, userId, options = {}) {
  const addedAt = options.addedAt || new Date().toISOString();
  db.run(
    "INSERT INTO support_operators (user_id, first_name, last_name, username, active, added_by, added_by_name, added_at, removed_by, removed_by_name, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)",
    userId,
    options.firstName || `Operator ${userId}`,
    options.lastName || null,
    options.username || `operator${userId}`,
    options.active === false ? 0 : 1,
    options.addedBy || 7,
    options.addedByName || "Operator",
    addedAt,
  );
}

function teamFlow(db, ownerId = 7) {
  return db.get("SELECT * FROM support_operator_flows WHERE owner_id = ?", ownerId);
}

async function beginOperatorAdd(env, updateBase = 40_000, actorId = 7) {
  const response = await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(updateBase, 1, "um:o:add", actorId)), env);
  assert.equal(response.status, 200);
}

async function addOperatorById(env, db, userId, updateBase = 40_000) {
  await beginOperatorAdd(env, updateBase);
  const selected = await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(updateBase + 1, 1, String(userId))), env);
  assert.equal(selected.status, 200);
  const flow = teamFlow(db);
  assert.equal(flow?.candidate_id, userId);
  const confirmed = await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(updateBase + 2, 1, `um:o:confirm:${flow.flow_nonce}`)), env);
  assert.equal(confirmed.status, 200);
  return flow;
}

async function beginOperatorRemoval(env, db, userId, updateBase = 41_000) {
  const response = await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(updateBase, 1, `um:o:rm:${userId}:0`)), env);
  assert.equal(response.status, 200);
  const flow = teamFlow(db);
  assert.equal(flow?.action, "remove");
  assert.equal(flow?.candidate_id, userId);
  return flow;
}

async function confirmOperatorFlow(env, flow, updateId = 41_001, actorId = 7, expectedStatus = 200) {
  const response = await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(updateId, 1, `um:o:confirm:${flow.flow_nonce}`, actorId)), env);
  assert.equal(response.status, expectedStatus);
  return response;
}

function verificationUrls(calls) {
  return calls
    .filter((call) => call.method === "sendMessage")
    .map((call) => call.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url)
    .filter(Boolean);
}

function verificationToken(calls, index = 0) {
  const url = verificationUrls(calls)[index];
  assert.ok(url, `missing verification URL at index ${index}`);
  return url.match(/\/verify\/([A-Za-z0-9_-]+)/)[1];
}

function pendingActionCallback(db, verb = "confirm", extra = null, operatorId = 7) {
  const pending = db.get("SELECT flow_nonce FROM operator_pending_actions WHERE operator_id = ?", operatorId);
  assert.ok(pending?.flow_nonce, "missing pending action nonce");
  return `um:pa:${verb}${extra === null ? "" : `:${extra}`}:${pending.flow_nonce}`;
}

test("pure routing helpers enforce registry and secret invariants", () => {
  const [bot] = parseBotRegistry(JSON.stringify(registryValue));
  assert.equal(bot.tokenBinding, "BOT_FOLDER_LINKS_TOKEN");
  assert.equal("token" in bot, false);
  assert.equal(getWebhookBotId(new URL("https://example.test/tg/folder-links")), "folder-links");
  assert.equal(getWebhookBotId(new URL("https://example.test/tg/folder-links/extra")), null);
  assert.equal(timingSafeEqual("folder-secret", "image-secret"), false);
  assert.equal(timingSafeEqual("folder-secret", "folder-secret"), true);
  assert.throws(() => parseBotRegistry(JSON.stringify([
    registryValue[0],
    { ...registryValue[1], tokenBinding: " BOT_FOLDER_LINKS_TOKEN " },
  ])), /unique token/);
  assert.throws(() => parseBotRegistry(JSON.stringify([{ ...registryValue[0], token: "secret" }])), /never secret values/);
  assert.throws(() => parseBotRegistry(JSON.stringify([{ ...registryValue[0], locale: "de" }])), /locale must be ru, en, es, or zh/);
  for (const locale of ['en', 'ru', 'es', 'zh'])
    assert.equal(parseBotRegistry(JSON.stringify([{ ...registryValue[0], locale }]))[0].locale, locale);
  assert.deepEqual([...parseAdminIds("7")], ["7"]);
  assert.throws(() => parseAdminIds("7; 8,9"), /exactly one primary operator/);
  assert.throws(() => parseAdminIds(""), /exactly one primary operator/);
  assert.throws(() => parseAdminIds("7,admin"), /invalid Telegram user id/);
});

test("topic and info output preserve service identity", () => {
  const [bot] = parseBotRegistry(JSON.stringify(registryValue));
  assert.equal(topicTitle(bot, { id: 42, first_name: "Alex", username: "alex" }), "[Folder Links] Alex @alex");
  assert.equal(isOwnedByBot({ bot_id: "folder-links" }, "image-compress"), false);
  assert.match(formatInfo({ user_id: 42, username: "alex", thread_id: 55, status: "open" }, bot), /Service: Folder Links/);
  assert.deepEqual(extractAlbumMedia({ photo: [{ file_id: "small" }, { file_id: "large" }], caption: "x" }), { type: "photo", media: "large", caption: "x", captionEntities: [], hasSpoiler: false });
  assert.equal(isAlreadyTopicState("Bad Request: topic is already closed", "closed"), true);
  assert.equal(isAlreadyTopicState("Bad Request: TOPIC_NOT_MODIFIED", "open"), true);
});

test("wrong per-bot webhook secret is rejected before Telegram or D1 side effects", async () => {
  await withFixture(null, async ({ env, calls, db }) => {
    const result = await worker.fetch(webhookRequest("folder-links", "secret-b", privateUpdate(1, 42)), env);
    assert.equal(result.status, 403);
    assert.equal(calls.length, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM processed_updates").count, 0);
  });
});

test("a disabled bot ACKs without requiring its secrets", async () => {
  await withFixture(null, async ({ env }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], enabled: false }]);
    delete env.BOT_FOLDER_LINKS_TOKEN;
    delete env.BOT_FOLDER_LINKS_WEBHOOK_SECRET;
    const result = await worker.fetch(webhookRequest("folder-links", "anything", privateUpdate(1, 42)), env);
    assert.equal(result.status, 200);
  });
});

test("a D1 emergency disable is isolated to one bot", async () => {
  await withFixture(null, async ({ env, db }) => {
    db.run("INSERT INTO bots (id, display_name, topic_prefix, enabled, created_at) VALUES (?, ?, ?, 0, ?)", "folder-links", "Folder Links", "Folder Links", new Date().toISOString());
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(3, 42)), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", privateUpdate(3, 42)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM conversations WHERE bot_id = 'image-compress'").count, 1);
  });
});

test("invalid webhook-secret characters fail configuration before D1 side effects", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_FOLDER_LINKS_WEBHOOK_SECRET = "not valid!";
    const result = await worker.fetch(webhookRequest("folder-links", "not valid!", privateUpdate(2, 42)), env);
    assert.equal(result.status, 500);
    assert.equal(calls.length, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM processed_updates").count, 0);
  });
});

test("same user and update_id are isolated by bot while same-bot replay is deduplicated", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const update = privateUpdate(100, 42);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", update), env)).status, 200);
    const conversations = db.all("SELECT bot_id, user_id, thread_id FROM conversations ORDER BY bot_id");
    assert.equal(conversations.length, 2);
    assert.notEqual(conversations[0].thread_id, conversations[1].thread_id);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM processed_updates WHERE update_id = 100").count, 2);
    const callCount = calls.length;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.length, callCount);
  });
});

test("duplicate General command is answered only by groupCommandOwner", async () => {
  await withFixture(null, async ({ env, calls }) => {
    const updateA = groupUpdate(200, undefined, "/bots@FolderLinksSupportBot");
    const updateB = { ...updateA, update_id: 201 };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", updateA), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", updateB), env)).status, 200);
    const replies = calls.filter((call) => call.method === "sendMessage");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].token, "token-a");
  });
});

test("group duplicate is ignored by non-owner and reply uses the owner bot token", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    const groupMessage = groupUpdate(300, 55, "answer");
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", groupMessage), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", { ...groupMessage, update_id: 301 }), env)).status, 200);
    const copies = calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === 42);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].token, "token-a");
  });
});

test("creating a topic after the primary operator's first private message does not emit an access warning", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const start = privateUpdate(310, 7);
    start.message.text = "I need support";
    assert.equal((await countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", start), env)).status, 200);
    const conversation = db.get("SELECT * FROM conversations WHERE bot_id = 'folder-links' AND user_id = 7");
    assert.ok(conversation);
    const created = groupUpdate(311, conversation.thread_id, undefined, 9001);
    created.message.from.is_bot = true;
    created.message.forum_topic_created = { name: "Folder Links · Alex", icon_color: 7322096 };
    calls.length = 0;
    assert.equal((await countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", created), env)).status, 200);
    assert.deepEqual(calls, [], "Telegram's topic-created event is not an operator action");
    const reply = groupUpdate(312, conversation.thread_id, "Operator test reply", 7);
    assert.equal((await countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", reply), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === 7).length, 1);
  });
});

test("group service events are neither operator commands nor replies", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    seedConversation(db, "folder-links", 42, 55);
    let updateId = 313;
    for (const actor of [7, 8, 9001]) {
      for (const event of ["forum_topic_created", "forum_topic_edited", "pinned_message", "message_auto_delete_timer_changed", "new_chat_members", "left_chat_member", "video_chat_started"]) {
        const update = groupUpdate(updateId++, 55, undefined, actor);
        update.message.from.is_bot = actor === 9001;
        update.message[event] = event === "new_chat_members" ? [{ id: 9, is_bot: false, first_name: "New member" }] : {};
        calls.length = 0;
        assert.equal((await countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", update), env)).status, 200);
        assert.deepEqual(calls, [], `service event ${event}, actor ${actor}`);
      }
    }
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_delivery_attempts").n, 0);
  });
});

test("both webhook entrypoints ignore service events before database access and still authenticate them", async () => {
  await withFixture(null, async ({ env, calls, fetchMock }) => {
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    for (const entrypoint of [worker, ingress]) {
      for (const update of [
        { ...privateUpdate(334, 7), message: { ...privateUpdate(334, 7).message, text: undefined, write_access_allowed: {} } },
        { ...groupUpdate(335, 1, undefined), message: { ...groupUpdate(335, 1, undefined).message, pinned_message: { message_id: 1 } } },
      ]) {
        const noDatabaseEnv = { ...env, SUPPORT_DB: null };
        assert.equal((await entrypoint.fetch(webhookRequest("folder-links", "wrong-secret", update), noDatabaseEnv)).status, 403);
        assert.equal((await entrypoint.fetch(webhookRequest("folder-links", "secret-a", update), noDatabaseEnv)).status, 200);
        assert.deepEqual(calls, []);
      }
    }
  });
});

test("a media reply to a service event still reaches the user", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    seedConversation(db, "folder-links", 42, 55);
    const update = groupUpdate(336, 55, undefined, 7);
    update.message.photo = [{ file_id: "photo-file", file_unique_id: "photo-unique", width: 10, height: 10 }];
    update.message.reply_to_message = { message_id: 54, forum_topic_created: { name: "Topic", icon_color: 7322096 } };
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    assert.equal((await countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === 42).length, 1);
  });
});

test("strict ADMIN_IDS blocks a group administrator who is not allowlisted", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(325, 55, "answer", 8)), env)).status, 200);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 42), false);
    assert.equal(calls.some((call) => call.method === "sendMessage" && /no longer have access/.test(call.body.text)), true);
  });
});

test("operator screens are available in General, linked from home, localized, and redirected out of user Topics", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8, { firstName: "Maria", lastName: "Helper", username: "maria_help" });
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3300, 1, "/operators")), env)).status, 200);
    let screen = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1);
    assert.match(screen.body.text, /Operators/);
    assert.match(screen.body.text, /Primary operator/);
    assert.match(screen.body.text, /Maria Helper.*@maria_help.*8/s);
    assert.equal(screen.body.reply_markup.inline_keyboard.flat().some((button) => /Add operator/.test(button.text)), true);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3301, 1, "/users")), env)).status, 200);
    screen = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1);
    assert.equal(screen.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "um:o:home:0"), false);
    await worker.fetch(webhookRequest('folder-links','secret-a',callbackUpdate(3304,1,'um:n:home')),env);
    screen = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1);
    assert.equal(screen.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "um:o:home:0"), true);

    seedConversation(db, "folder-links", 3300, 170);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3302, 170, "/operators")), env)).status, 200);
    assert.match(calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1).body.text, /only in General/);

    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }, registryValue[1]]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3303, 1, "/operators")), env)).status, 200);
    screen = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1);
    assert.match(screen.body.text, /Операторы/);
    assert.match(screen.body.text, /Главный оператор/);
    assert.equal(screen.body.reply_markup.inline_keyboard.flat().some((button) => /Добавить оператора/.test(button.text)), true);
  });
});

test("the primary operator adds a normal group member by Telegram ID with explicit confirmation and global access", async () => {
  await withFixture((call) => {
    if (call.method === "getChatMember" && call.body.user_id === 8) {
      return { ok: true, result: { status: "member", user: { id: 8, first_name: "Maria", last_name: "Helper", username: "maria_help", is_bot: false } } };
    }
    return null;
  }, async ({ env, db, calls }) => {
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3310, 1, "um:o:add")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3311, 1, "8")), env)).status, 200);
    const pending = teamFlow(db);
    assert.equal(pending.stage, "confirm");
    assert.equal(pending.candidate_id, 8);
    const confirmation = calls.filter((call) => call.method === "sendMessage").at(-1);
    assert.match(confirmation.body.text, /Maria Helper/);
    assert.match(confirmation.body.text, /@maria_help/);
    assert.match(confirmation.body.text, /Telegram ID: 8/);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operators WHERE user_id = 8").count, 0);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3312, 1, `um:o:confirm:${pending.flow_nonce}`)), env)).status, 200);
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id = 8").active, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operator_audit WHERE action = 'operator_added' AND target_operator_id = 8").count, 1);

    seedConversation(db, "folder-links", 3310, 171);
    seedConversation(db, "image-compress", 3311, 172);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3313, 171, "folder answer", 8)), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", groupUpdate(3314, 172, "image answer", 8)), env)).status, 200);
    assert.equal(calls.some((call) => call.token === "token-a" && call.method === "copyMessage" && call.body.chat_id === 3310), true);
    assert.equal(calls.some((call) => call.token === "token-b" && call.method === "copyMessage" && call.body.chat_id === 3311), true);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3315, 171, "um:tp:info", 8)), env)).status, 200);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3316, 1, `um:o:confirm:${pending.flow_nonce}`)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operators WHERE user_id = 8").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operator_audit WHERE action = 'operator_added' AND target_operator_id = 8").count, 1);
    assert.equal(calls.some((call) => ["promoteChatMember", "banChatMember", "restrictChatMember"].includes(call.method)), false);
  });
});

test("an operator-add flow only accepts candidate input in General", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 3400, 190);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3400, 1, "um:o:add")), env)).status, 200);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3401, 190, "8")), env)).status, 200);

    assert.equal(teamFlow(db).stage, "candidate");
    assert.equal(teamFlow(db).candidate_id, null);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 3400), false);
    const notice = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1);
    assert.match(notice.body.text, /in General/);
    assert.equal(notice.body.message_thread_id, 190);
  });
});

test("reply-based candidate selection works while hidden forwards, bots, non-members, primary, and existing operators are rejected", async () => {
  await withFixture((call) => {
    if (call.method !== "getChatMember") return null;
    if (call.body.user_id === 9) return { ok: true, result: { status: "member", user: { id: 9, first_name: "Reply", last_name: "Candidate", username: "reply_user", is_bot: false } } };
    if (call.body.user_id === 10) return { ok: true, result: { status: "member", user: { id: 10, first_name: "Robot", is_bot: true } } };
    if (call.body.user_id === 11) return { ok: true, result: { status: "left", user: { id: 11, first_name: "Gone", is_bot: false } } };
    if (call.body.user_id === 12) return { ok: true, result: { status: "member", user: { id: 12, first_name: "Existing", is_bot: false } } };
    return null;
  }, async ({ env, db, calls }) => {
    seedOperator(db, 12, { firstName: "Existing" });
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3320, 1, "um:o:add")), env)).status, 200);
    const reply = groupUpdate(3321, 1, "candidate message");
    reply.message.reply_to_message = { from: { id: 9, first_name: "Reply", last_name: "Candidate", username: "reply_user", is_bot: false } };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reply), env)).status, 200);
    assert.equal(teamFlow(db).candidate_id, 9);
    assert.equal(teamFlow(db).stage, "confirm");

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3322, 1, "um:o:add")), env)).status, 200);
    const hidden = groupUpdate(3323, 1, "forwarded");
    hidden.message.forward_sender_name = "Hidden User";
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", hidden), env)).status, 200);
    assert.match(calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1).body.text, /hid the forwarded author/);
    assert.equal(teamFlow(db).stage, "candidate");

    for (const [updateId, candidateId, expected] of [[3324, 10, /bot cannot/i], [3325, 11, /not a member/i], [3326, 7, /primary operator/i], [3327, 12, /already an operator/i]]) {
      assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(updateId, 1, String(candidateId))), env)).status, 200);
      assert.match(calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1).body.text, expected);
      assert.equal(teamFlow(db).stage, "candidate");
    }
  });
});

test("additional operators get a read-only team directory and Telegram admins are not trusted automatically", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8, { firstName: "Read Only" });
    seedConversation(db, "folder-links", 3330, 173);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3330, 1, "/operators", 8)), env)).status, 200);
    let screen = calls.filter((call) => call.method === "sendMessage").at(-1);
    assert.match(screen.body.text, /Operators/);
    assert.equal(screen.body.reply_markup.inline_keyboard.flat().some((button) => /Add operator/.test(button.text)), false);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3331, 1, "um:o:card:8:0", 8)), env)).status, 200);
    let edit = calls.filter((call) => call.method === "editMessageText").at(-1);
    assert.equal(edit.body.reply_markup.inline_keyboard.flat().some((button) => /Remove operator/.test(button.text)), false);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3332, 1, "um:o:add", 8)), env)).status, 200);
    edit = calls.filter((call) => call.method === "editMessageText").at(-1);
    assert.match(edit.body.text, /Only the primary operator/);

    const before = calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === 3330).length;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3333, 173, "admin answer", 99)), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === 3330).length, before);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3334, 1, "/operators", 99)), env)).status, 200);
    assert.match(calls.filter((call) => call.method === "sendMessage").at(-1).body.text, /no longer have access/);
  });
});

test("stale and concurrent add confirmations cannot select the wrong candidate or create duplicates", async () => {
  await withFixture((call) => {
    if (call.method === "getChatMember" && [8, 9].includes(call.body.user_id)) {
      return { ok: true, result: { status: "member", user: { id: call.body.user_id, first_name: `Candidate ${call.body.user_id}`, username: `candidate${call.body.user_id}`, is_bot: false } } };
    }
    return null;
  }, async ({ env, db }) => {
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3340, 1, "um:o:add")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3341, 1, "8")), env)).status, 200);
    const oldNonce = teamFlow(db).flow_nonce;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3342, 1, "um:o:add")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3343, 1, "9")), env)).status, 200);
    const currentNonce = teamFlow(db).flow_nonce;
    assert.notEqual(currentNonce, oldNonce);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3344, 1, `um:o:confirm:${oldNonce}`)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operators").count, 0);

    const results = await Promise.all([
      worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3345, 1, `um:o:confirm:${currentNonce}`)), env),
      worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3346, 1, `um:o:confirm:${currentNonce}`)), env),
    ]);
    assert.equal(results.every((response) => response.status === 200), true);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operators WHERE user_id = 9 AND active = 1").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operators WHERE user_id = 8").count, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operator_audit WHERE action = 'operator_added'").count, 1);
  });
});

test("removal is confirmed, preserves history, cancels pending work, revokes old buttons, and never changes Telegram membership", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8, { firstName: "Former", lastName: "Operator", username: "former_op" });
    seedConversation(db, "folder-links", 3350, 174);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3350, 174, "/ban", 8)), env)).status, 200);
    const oldPending = db.get("SELECT flow_nonce FROM operator_pending_actions WHERE operator_id = 8");
    assert.ok(oldPending?.flow_nonce);
    db.run("INSERT INTO support_operator_flows (owner_id, owner_name, action, stage, chat_id, thread_id, flow_nonce, list_page, created_at, expires_at) VALUES (8, 'Former Operator', 'add', 'candidate', ?, 1, 'former-flow', 0, ?, ?)", -1001234567890, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3351, 1, "um:o:rm:7:0")), env)).status, 200);
    assert.equal(teamFlow(db)?.candidate_id ?? null, null);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3352, 1, "um:o:rm:8:0")), env)).status, 200);
    const removal = teamFlow(db);
    assert.equal(removal.action, "remove");
    assert.equal(removal.stage, "confirm");
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id = 8").active, 1);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3353, 1, `um:o:confirm:${removal.flow_nonce}`)), env)).status, 200);
    const historical = db.get("SELECT active, removed_at, removed_by FROM support_operators WHERE user_id = 8");
    assert.equal(historical.active, 0);
    assert.ok(historical.removed_at);
    assert.equal(historical.removed_by, 7);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM operator_pending_actions WHERE operator_id = 8").count, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operator_flows WHERE owner_id = 8").count, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operator_audit WHERE action = 'operator_removed' AND target_operator_id = 8").count, 1);

    const deliveredBefore = calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === 3350).length;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3354, 174, "former answer", 8)), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3355, 174, `um:pa:confirm:${oldPending.flow_nonce}`, 8)), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === 3350).length, deliveredBefore);
    assert.equal(calls.some((call) => ["banChatMember", "unbanChatMember", "promoteChatMember", "restrictChatMember"].includes(call.method)), false);
  });
});

test("operator authorization fails closed on a store error while the configured primary remains authoritative", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8);
    seedConversation(db, "folder-links", 3360, 175);
    seedConversation(db, "folder-links", 3361, 176);
    db.failOnce("SELECT 1 FROM support_operators");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3360, 175, "operator answer", 8)), env)).status, 200);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 3360), false);

    db.failOnce("SELECT 1 FROM support_operators");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3361, 176, "primary answer", 7)), env)).status, 200);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 3361), true);
  });
});

test("changing ADMIN_IDS transfers primary ownership, revokes the former owner, and preserves added operators", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3370, 1, "/operators", 7)), env)).status, 200);
    seedOperator(db, 8, { firstName: "Persistent" });
    seedOperator(db, 7, { firstName: "Old Primary" });
    env.ADMIN_IDS = "9";
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3371, 1, "/operators", 9)), env)).status, 200);
    assert.equal(db.get("SELECT user_id FROM support_primary_operator_state WHERE id = 1").user_id, 9);
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id = 7").active, 0);
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id = 8").active, 1);

    seedConversation(db, "folder-links", 3370, 177);
    seedConversation(db, "folder-links", 3371, 178);
    seedConversation(db, "folder-links", 3372, 179);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3372, 177, "old owner", 7)), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3373, 178, "persistent operator", 8)), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3374, 179, "new owner", 9)), env)).status, 200);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 3370), false);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 3371), true);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 3372), true);
  });
});

test("operator audit, self-check, and pagination retain useful team information", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    for (let id = 20; id <= 26; id++) seedOperator(db, id, { firstName: `Team ${id}`, addedAt: new Date(Date.now() + id * 1000).toISOString() });
    const now = new Date().toISOString();
    db.run("INSERT INTO support_operator_audit (actor_id, actor_name, target_operator_id, target_name, target_username, action, result, created_at) VALUES (7, 'Owner', 20, 'Team 20', 'team20', 'operator_added', 'success', ?)", now);
    db.run("INSERT INTO support_operator_audit (actor_id, actor_name, target_operator_id, target_name, target_username, action, result, created_at) VALUES (7, 'Owner', 21, 'Team 21', 'team21', 'operator_removed', 'success', ?)", now);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3380, 1, "/operators")), env)).status, 200);
    let screen = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1);
    assert.match(screen.body.text, /Team 20/);
    assert.doesNotMatch(screen.body.text, /Team 26/);
    assert.equal(screen.body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "um:o:home:1"), true);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(3381, 1, "um:o:home:1")), env)).status, 200);
    let edit = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1);
    assert.match(edit.body.text, /Team 26/);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3382, 1, "/audit")), env)).status, 200);
    screen = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1);
    assert.match(screen.body.text, /Operator added/);
    assert.match(screen.body.text, /Operator removed/);
    assert.match(screen.body.text, /operator=20; name=Team 20; username=@team20/);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(3383, 1, "/selfcheck")), env)).status, 200);
    screen = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1);
    assert.match(screen.body.text, /Primary operator found in the group/);
    assert.ok(screen.body.reply_markup.inline_keyboard.flat().some(button=>button.callback_data?.startsWith('um:w:ready:')));
  });
});

test("a removed operator cannot finish an already queued support album", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const infoLogs = [];
    const originalLog = console.log;
    console.log = (line) => infoLogs.push(String(line));
    seedOperator(db, 8);
    seedConversation(db, "folder-links", 3390, 180);
    env.ALBUM_SETTLE_MS = "40";
    const update = groupUpdate(3390, 180, "album", 8);
    delete update.message.text;
    update.message.media_group_id = "revoked-operator-album";
    update.message.photo = [{ file_id: "revoked-photo" }];
    try {
      const pending = worker.fetch(webhookRequest("folder-links", "secret-a", update), env);
      for (let attempt = 0; attempt < 50 && !db.get("SELECT 1 FROM media_groups WHERE media_group_id = 'revoked-operator-album'"); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      db.run("UPDATE support_operators SET active = 0, removed_at = ? WHERE user_id = 8", new Date().toISOString());
      assert.equal((await pending).status, 200);
    } finally {
      console.log = originalLog;
    }
    assert.equal(calls.some((call) => (call.method === "copyMessage" || call.method === "sendMediaGroup") && call.body.chat_id === 3390), false);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM media_groups WHERE media_group_id = 'revoked-operator-album'").count, 0);
    assert.equal(infoLogs.some((line) => line.includes('"event":"operator_reply_delivered"')), false);
  });
});

test("operator acceptance 01: initial configuration requires exactly one primary operator", () => {
  assert.deepEqual([...parseAdminIds("7")], ["7"]);
  assert.throws(() => parseAdminIds(""), /exactly one/);
  assert.throws(() => parseAdminIds("7,8"), /exactly one/);
});

test("operator acceptance 02: the primary operator opens operators in General", async () => {
  await withFixture(null, async ({ env, calls }) => {
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_020, 1, "/operators")), env)).status, 200);
    assert.match(calls.filter((call) => call.method === "sendMessage").at(-1).body.text, /Operators/);
  });
});

test("operator acceptance 03: the screen shows the primary and additional operators", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8, { firstName: "Anna", username: "anna" });
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_030, 1, "/operators")), env);
    const text = calls.filter((call) => call.method === "sendMessage").at(-1).body.text;
    assert.match(text, /Primary operator/);
    assert.match(text, /Anna · @anna · 8/);
  });
});

test("operator acceptance 04: primary home links to operator management", async () => {
  await withFixture(null, async ({ env, calls }) => {
    await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(40_040, 1, "um:n:home")), env);
    const buttons = calls.filter((call) => call.method === "sendMessage").at(-1).body.reply_markup.inline_keyboard.flat();
    assert.equal(buttons.some((button) => button.callback_data === "um:o:home:0"), true);
  });
});

test("operator acceptance 05: the primary selects a candidate by replying to their message", async () => {
  await withFixture((call) => call.method === "getChatMember" && call.body.user_id === 8
    ? { ok: true, result: { status: "member", user: { id: 8, first_name: "Reply", is_bot: false } } }
    : null, async ({ env, db }) => {
    await beginOperatorAdd(env, 40_050);
    const update = groupUpdate(40_051, 1, "candidate");
    update.message.reply_to_message = { from: { id: 8, first_name: "Reply", is_bot: false } };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(teamFlow(db).candidate_id, 8);
  });
});

test("operator acceptance 06: the primary selects a candidate by Telegram ID", async () => {
  await withFixture(null, async ({ env, db }) => {
    await beginOperatorAdd(env, 40_060);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_061, 1, "8")), env);
    assert.equal(teamFlow(db).candidate_id, 8);
  });
});

test("operator acceptance 07: a hidden forwarded author cannot be selected", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    await beginOperatorAdd(env, 40_070);
    const promptId = db.get('SELECT message_id FROM operator_ui_sessions WHERE operator_id=7').message_id;
    const update = groupUpdate(40_071, 1, "forwarded");
    update.message.forward_sender_name = "Hidden";
    await worker.fetch(webhookRequest("folder-links", "secret-a", update), env);
    assert.equal(teamFlow(db).stage, "candidate");
    const screen = lastWorkspaceScreen(calls);
    assert.match(screen.body.text, /hid the forwarded author/);
    assert.equal(screen.body.message_id, promptId, 'validation feedback stays in the input window');
  });
});

test("operator acceptance 08: confirmation identifies the selected candidate", async () => {
  await withFixture((call) => call.method === "getChatMember" && call.body.user_id === 8
    ? { ok: true, result: { status: "member", user: { id: 8, first_name: "Anna", last_name: "Petrova", username: "anna", is_bot: false } } }
    : null, async ({ env, calls }) => {
    await beginOperatorAdd(env, 40_080);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_081, 1, "8")), env);
    const text = calls.filter((call) => call.method === "sendMessage").at(-1).body.text;
    assert.match(text, /Anna Petrova/);
    assert.match(text, /@anna/);
    assert.match(text, /Telegram ID: 8/);
  });
});

test("operator acceptance 09: adding an operator requires confirmation", async () => {
  await withFixture(null, async ({ env, db }) => {
    await beginOperatorAdd(env, 40_090);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_091, 1, "8")), env);
    assert.equal(teamFlow(db).stage, "confirm");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operators WHERE user_id = 8").count, 0);
  });
});

test("operator acceptance 10: a confirmed operator can reply and use topic panels immediately", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    await addOperatorById(env, db, 8, 40_100);
    seedConversation(db, "folder-links", 4_010, 181);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_103, 181, "answer", 8)), env);
    await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(40_104, 181, "um:tp:info", 8)), env);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 4_010), true);
    assert.equal(calls.some((call) => ["sendMessage", "editMessageText"].includes(call.method)), true);
  });
});

test("operator acceptance 11: an additional operator cannot change the team", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8);
    seedOperator(db, 9);
    await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(40_110, 1, "um:o:add", 8)), env);
    await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(40_111, 1, "um:o:rm:9:0", 8)), env);
    assert.equal(teamFlow(db, 8), undefined);
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id = 9").active, 1);
    assert.match(calls.filter((call) => call.method === "editMessageText").at(-1).body.text, /Only the primary operator/);
  });
});

test("operator acceptance 12: an additional operator sees a read-only directory", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_120, 1, "/operators", 8)), env);
    const buttons = calls.filter((call) => call.method === "sendMessage").at(-1).body.reply_markup.inline_keyboard.flat();
    assert.equal(buttons.some((button) => /Add operator|Remove operator/.test(button.text)), false);
  });
});

test("operator acceptance 13: a Telegram administrator is not automatically a Desk operator", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 4_013, 182);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_130, 182, "admin reply", 99)), env);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 4_013), false);
  });
});

test("operator acceptance 14: a regular member gains Desk access without Telegram promotion", async () => {
  await withFixture((call) => call.method === "getChatMember" && call.body.user_id === 8
    ? { ok: true, result: { status: "member", user: { id: 8, first_name: "Member", is_bot: false } } }
    : null, async ({ env, db, calls }) => {
    await addOperatorById(env, db, 8, 40_140);
    seedConversation(db, "folder-links", 4_014, 183);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_143, 183, "member reply", 8)), env);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 4_014), true);
    assert.equal(calls.some((call) => call.method === "promoteChatMember"), false);
  });
});

test("operator acceptance 15: repeated add confirmation does not duplicate an operator", async () => {
  await withFixture(null, async ({ env, db }) => {
    const flow = await addOperatorById(env, db, 8, 40_150);
    await confirmOperatorFlow(env, flow, 40_153);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operators WHERE user_id = 8").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operator_audit WHERE action = 'operator_added' AND target_operator_id = 8").count, 1);
  });
});

test("operator acceptance 16: the primary removes an operator from their card", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8, { firstName: "Anna" });
    await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(40_160, 1, "um:o:card:8:0")), env);
    assert.match(calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1).body.text, /Anna/);
    const flow = await beginOperatorRemoval(env, db, 8, 40_161);
    await confirmOperatorFlow(env, flow, 40_162);
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id = 8").active, 0);
  });
});

test("operator acceptance 17: removing an operator requires confirmation", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8);
    await beginOperatorRemoval(env, db, 8, 40_170);
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id = 8").active, 1);
    assert.match(calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1).body.text, /Remove operator\?/);
  });
});

test("operator acceptance 18: a removed operator loses reply access immediately", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8);
    seedConversation(db, "folder-links", 4_018, 184);
    const flow = await beginOperatorRemoval(env, db, 8, 40_180);
    await confirmOperatorFlow(env, flow, 40_181);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_182, 184, "revoked reply", 8)), env);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 4_018), false);
  });
});

test("operator acceptance 19: old management buttons stop working after removal", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedOperator(db, 8);
    seedConversation(db, "folder-links", 4_019, 185);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_190, 185, "/ban", 8)), env);
    const nonce = db.get("SELECT flow_nonce FROM operator_pending_actions WHERE operator_id = 8").flow_nonce;
    const removal = await beginOperatorRemoval(env, db, 8, 40_191);
    await confirmOperatorFlow(env, removal, 40_192);
    await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(40_193, 185, `um:pa:confirm:${nonce}`, 8)), env);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM banned_users WHERE user_id = 4019").count, 0);
  });
});

test("operator acceptance 20: removal cancels unfinished operator actions", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedOperator(db, 8);
    seedConversation(db, "folder-links", 4_020, 186);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_200, 186, "/ban", 8)), env);
    db.run("INSERT INTO support_operator_flows (owner_id, owner_name, action, stage, chat_id, thread_id, flow_nonce, list_page, created_at, expires_at) VALUES (8, 'Operator 8', 'add', 'candidate', ?, 1, 'acceptance-flow', 0, ?, ?)", -1001234567890, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
    const removal = await beginOperatorRemoval(env, db, 8, 40_201);
    await confirmOperatorFlow(env, removal, 40_202);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM operator_pending_actions WHERE operator_id = 8").count, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operator_flows WHERE owner_id = 8").count, 0);
  });
});

test("operator acceptance 21: removing an operator does not change Telegram membership", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8);
    const flow = await beginOperatorRemoval(env, db, 8, 40_210);
    await confirmOperatorFlow(env, flow, 40_211);
    assert.equal(calls.some((call) => ["banChatMember", "unbanChatMember", "restrictChatMember", "promoteChatMember"].includes(call.method)), false);
  });
});

test("operator acceptance 22: the primary operator cannot be removed in Telegram", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(40_220, 1, "um:o:rm:7:0")), env);
    assert.equal(teamFlow(db), undefined);
    assert.match(calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1).body.text, /outdated/);
  });
});

test("operator acceptance 23: an old confirmation cannot add a newer candidate", async () => {
  await withFixture(null, async ({ env, db }) => {
    await beginOperatorAdd(env, 40_230);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_231, 1, "8")), env);
    const old = teamFlow(db);
    await beginOperatorAdd(env, 40_232);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_233, 1, "9")), env);
    await confirmOperatorFlow(env, old, 40_234);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operators").count, 0);
    assert.equal(teamFlow(db).candidate_id, 9);
  });
});

test("operator acceptance 24: concurrent confirmations create one correct operator", async () => {
  await withFixture(null, async ({ env, db }) => {
    await beginOperatorAdd(env, 40_240);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_241, 1, "8")), env);
    const flow = teamFlow(db);
    const responses = await Promise.all([
      confirmOperatorFlow(env, flow, 40_242),
      confirmOperatorFlow(env, flow, 40_243),
    ]);
    assert.equal(responses.every((response) => response.status === 200), true);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operators WHERE user_id = 8 AND active = 1").count, 1);
  });
});

test("operator acceptance 25: additions and removals appear in the common audit", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    await addOperatorById(env, db, 8, 40_250);
    const removal = await beginOperatorRemoval(env, db, 8, 40_253);
    await confirmOperatorFlow(env, removal, 40_254);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_255, 1, "/audit")), env);
    const text = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1).body.text;
    assert.match(text, /Operator added/);
    assert.match(text, /Operator removed/);
  });
});

test("operator acceptance 26: removed operator history is retained", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedOperator(db, 8, { firstName: "Historical" });
    db.run("INSERT INTO support_operator_audit (actor_id, actor_name, target_operator_id, target_name, action, result, created_at) VALUES (8, 'Historical', 99, 'User 99', 'operator_added', 'legacy', ?)", new Date().toISOString());
    const flow = await beginOperatorRemoval(env, db, 8, 40_260);
    await confirmOperatorFlow(env, flow, 40_261);
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id = 8").active, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM support_operator_audit WHERE actor_id = 8").count, 1);
  });
});

test("operator acceptance 27: operator lookup failure grants no outsider access", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8);
    seedConversation(db, "folder-links", 4_027, 187);
    db.failOnce("SELECT 1 FROM support_operators");
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_270, 187, "reply", 8)), env);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 4_027), false);
  });
});

test("operator acceptance 28: changing initial configuration revokes the former primary", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_280, 1, "/operators", 7)), env);
    env.ADMIN_IDS = "9";
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_281, 1, "/operators", 9)), env);
    seedConversation(db, "folder-links", 4_028, 188);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_282, 188, "old primary", 7)), env);
    assert.equal(db.get("SELECT user_id FROM support_primary_operator_state WHERE id = 1").user_id, 9);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 4_028), false);
  });
});

test("operator acceptance 29: additional operators survive a primary change", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedOperator(db, 8);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_290, 1, "/operators", 7)), env);
    env.ADMIN_IDS = "9";
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_291, 1, "/operators", 9)), env);
    seedConversation(db, "folder-links", 4_029, 189);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_292, 189, "operator reply", 8)), env);
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id = 8").active, 1);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 4_029), true);
  });
});

test("operator acceptance 30: operator screens work in English and Russian", async () => {
  await withFixture(null, async ({ env, calls }) => {
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_300, 1, "/operators")), env);
    assert.match(calls.filter((call) => call.method === "sendMessage").at(-1).body.text, /Operators/);
  });
  await withFixture(null, async ({ env, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }, registryValue[1]]);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(40_301, 1, "/operators")), env);
    assert.match(calls.filter((call) => call.method === "sendMessage").at(-1).body.text, /Операторы/);
  });
});

test("reply relations are translated through per-bot message mappings", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    db.run(
      "INSERT INTO message_mappings (bot_id, user_id, thread_id, user_message_id, support_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      "folder-links",
      42,
      55,
      10,
      110,
      new Date().toISOString(),
    );
    const userReply = privateUpdate(350, 42, 11);
    userReply.message.reply_to_message = { message_id: 10 };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", userReply), env)).status, 200);
    const supportCopy = calls.find((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890);
    assert.equal(supportCopy.body.reply_parameters.message_id, 110);

    const operatorReply = groupUpdate(351, 55, "answer");
    operatorReply.message.reply_to_message = { message_id: 110 };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", operatorReply), env)).status, 200);
    const userCopy = calls.find((call) => call.method === "copyMessage" && call.body.chat_id === 42);
    assert.equal(userCopy.body.reply_parameters.message_id, 10);
  });
});

test("ban is scoped to one bot", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    seedConversation(db, "image-compress", 42, 91);
    const reopenStartedAt = new Date().toISOString();
    db.run("INSERT INTO conversation_reopen_effects (bot_id,user_id,old_thread_id,created_at) VALUES ('folder-links',42,55,?)", reopenStartedAt);
    db.run("INSERT INTO reopen_business_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES ('folder-links',42,399,42,3990,?)", reopenStartedAt);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(400, 55, "/ban abusive traffic")), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM banned_users WHERE bot_id = 'folder-links'").count, 0);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(403, 55, pendingActionCallback(db, "confirm"))), env)).status, 200);
    const before = calls.length;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(401, 42)), env)).status, 200);
    assert.equal(calls.length, before);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", privateUpdate(402, 42)), env)).status, 200);
    assert.equal(calls.some((call) => call.token === "token-b" && call.method === "forwardMessage"), true);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM banned_users WHERE bot_id = 'folder-links'").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM banned_users WHERE bot_id = 'image-compress'").count, 0);
    const cancelled = db.get("SELECT completed_at, cancellation_reason FROM conversation_reopen_effects WHERE bot_id='folder-links' AND user_id=42");
    assert.ok(cancelled.completed_at);
    assert.equal(cancelled.cancellation_reason, "banned");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM reopen_business_messages WHERE bot_id='folder-links' AND user_id=42").count, 0);
  });
});

test("broken token for one bot does not prevent another bot from processing", async () => {
  await withFixture((call) => {
    if (call.token === "token-a" && call.method === "createForumTopic") {
      return { ok: false, error_code: 401, description: "Unauthorized" };
    }
    return null;
  }, async ({ env, db }) => {
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(500, 42)), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", privateUpdate(500, 42)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM conversations WHERE bot_id = 'folder-links'").count, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM conversations WHERE bot_id = 'image-compress'").count, 1);
  });
});

test("post-delivery D1 mapping failure does not cause duplicate Telegram delivery", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    db.failOnce("INSERT OR IGNORE INTO message_mappings");
    const update = privateUpdate(600, 42);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    const delivered = calls.filter((call) => call.method === "forwardMessage" || call.method === "copyMessage").length;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "forwardMessage" || call.method === "copyMessage").length, delivered);
  });
});

test("copyMessage fallback accepts the real MessageId result shape", async () => {
  await withFixture((call) => {
    if (call.method === "forwardMessage") {
      return { ok: false, error_code: 400, description: "Bad Request: message can't be forwarded" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(625, 42)), env)).status, 200);
    const copied = calls.find((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890);
    assert.ok(copied);
    const mapping = db.get("SELECT thread_id, support_message_id FROM message_mappings WHERE bot_id = 'folder-links' AND user_message_id = 625");
    assert.equal(mapping.thread_id, 55);
    assert.ok(mapping.support_message_id);
  });
});

test("copy fallback probe recreates a Topic redirected to General", async () => {
  let probeCount = 0;
  await withFixture((call) => {
    if (call.method === "forwardMessage") return { ok: false, error_code: 400, description: "Bad Request: message can't be forwarded" };
    if (call.method === "sendMessage" && call.body.message_thread_id) {
      probeCount += 1;
      if (probeCount === 1) return { ok: true, result: { message_id: 900, message_thread_id: 1 } };
    }
    if (call.method === "createForumTopic") return { ok: true, result: { message_thread_id: 77 } };
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(630, 42)), env)).status, 200);
    assert.equal(db.get("SELECT thread_id FROM conversations WHERE bot_id = 'folder-links' AND user_id = 42").thread_id, 77);
    assert.equal(calls.some((call) => call.method === "deleteMessage" && call.body.message_id === 900), true);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.message_thread_id === 77), true);
  });
});

test("a permanent user delivery error is acknowledged once with a user-facing notice", async () => {
  await withFixture((call) => {
    if (["forwardMessage", "copyMessage"].includes(call.method)) {
      return { ok: false, error_code: 400, description: "Bad Request: unsupported message" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    const update = privateUpdate(640, 42);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && /could not be delivered/.test(call.body.text)).length, 1);
  });
});

test("a transient delivery retry is deduplicated without D1 realtime rate counters", async () => {
  let transientFailures = 1;
  await withFixture((call) => {
    if (["forwardMessage", "copyMessage"].includes(call.method) && transientFailures > 0) {
      transientFailures -= 1;
      return { ok: false, httpStatus: 429, error_code: 429, description: "Temporary Telegram outage" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    const update = privateUpdate(650, 42);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM processed_updates WHERE bot_id = 'folder-links' AND update_id = 650").count, 1);
    assert.equal(calls.some((call) => call.method === "sendMessage" && /Too many/.test(call.body.text)), false);
  });
});

test("an expired processed-update lease is reclaimed and completed", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedConversation(db, "folder-links", 42, 55);
    db.run(
      "INSERT INTO processed_updates (bot_id, update_id, state, owner_token, lease_expires_at, processed_at, completed_at) VALUES (?, ?, 'processing', ?, ?, ?, NULL)",
      "folder-links",
      675,
      "dead-worker",
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() - 120_000).toISOString(),
    );
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(675, 42)), env)).status, 200);
    assert.equal(db.get("SELECT state FROM processed_updates WHERE bot_id = 'folder-links' AND update_id = 675").state, "completed");
  });
});

test("a user message silently reopens a closed conversation and reaches support", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([
      { ...registryValue[0], locale: "ru" },
      registryValue[1],
    ]);
    seedConversation(db, "folder-links", 42, 55);
    db.run("UPDATE conversations SET status = 'closed' WHERE bot_id = 'folder-links' AND user_id = 42");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(680, 42)), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "reopenForumTopic").length, 1);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && call.body.text === "🔄 Пользователь возобновил обращение.").length, 1);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.message_thread_id === 55), true);
    assert.equal(calls.some((call) => call.method === "sendMessage" && call.body.chat_id === 42), false);
    assert.equal(db.get("SELECT status FROM conversations WHERE bot_id = 'folder-links' AND user_id = 42").status, "open");
    assert.equal(db.get("SELECT action FROM operator_audit WHERE bot_id = 'folder-links' AND user_id = 42 ORDER BY id DESC LIMIT 1").action, "conversation_reopened_by_user");
  });
});

test("a closed Topic deleted in Telegram is recreated before the user's message is delivered", async () => {
  await withFixture((call) => {
    if (call.method === "reopenForumTopic") return { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
    if (call.method === "createForumTopic") return { ok: true, result: { message_thread_id: 188 } };
    return null;
  }, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }, registryValue[1]]);
    seedConversation(db, "folder-links", 681, 88);
    seedCompletedProvision(db, "folder-links", 681, 88);
    db.run("UPDATE conversations SET status = 'closed' WHERE bot_id = 'folder-links' AND user_id = 681");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(6810, 681)), env)).status, 200);
    const conversation = db.get("SELECT thread_id, status FROM conversations WHERE bot_id = 'folder-links' AND user_id = 681");
    assert.equal(conversation.thread_id, 188);
    assert.equal(conversation.status, "open");
    assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && call.body.text === "🔄 Пользователь возобновил обращение. Предыдущая тема была удалена.").length, 1);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.message_thread_id === 188), true);
    const audit = db.all("SELECT action, actor_type, reason FROM operator_audit WHERE bot_id = 'folder-links' AND user_id = 681 ORDER BY id");
    assert.deepEqual(audit.map((row) => row.action), ["conversation_reopened_by_user", "conversation_topic_restored"]);
    assert.equal(audit.every((row) => row.actor_type === "system"), true);
    assert.equal(audit.every((row) => /old_topic=88; new_topic=188/.test(row.reason)), true);
  });
});

test("a closed conversation remains closed until a queued verification succeeds", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru", verification_mode: "always" }, registryValue[1]]);
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    seedConversation(db, "folder-links", 682, 89);
    db.run("UPDATE conversations SET status = 'closed' WHERE bot_id = 'folder-links' AND user_id = 682");
    const timestamp = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, verification_required, created_at, updated_at) VALUES (?, ?, 1, ?, ?)", "folder-links", 682, timestamp, timestamp);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(6820, 682)), env)).status, 200);
    assert.equal(db.get("SELECT status FROM conversations WHERE bot_id = 'folder-links' AND user_id = 682").status, "closed");
    assert.equal(calls.some((call) => call.method === "reopenForumTopic"), false);
    const token = verificationToken(calls);
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.82", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    assert.equal((await worker.fetch(verify, env)).status, 200);
    assert.equal(db.get("SELECT status FROM conversations WHERE bot_id = 'folder-links' AND user_id = 682").status, "open");
    assert.equal(calls.filter((call) => call.method === "reopenForumTopic").length, 1);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && call.body.text === "🔄 Пользователь возобновил обращение.").length, 1);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length, 1);
  });
});

test("a ban does not reopen a closed conversation", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 683, 90);
    db.run("UPDATE conversations SET status = 'closed' WHERE bot_id = 'folder-links' AND user_id = 683");
    db.run("INSERT INTO banned_users (bot_id, user_id, banned_at) VALUES (?, ?, ?)", "folder-links", 683, new Date().toISOString());
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(6830, 683)), env)).status, 200);
    assert.equal(db.get("SELECT status FROM conversations WHERE bot_id = 'folder-links' AND user_id = 683").status, "closed");
    assert.equal(calls.some((call) => call.method === "reopenForumTopic" || call.method === "forwardMessage"), false);
  });
});

test("a duplicate closed-conversation update creates one reopening marker and one delivery", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }, registryValue[1]]);
    seedConversation(db, "folder-links", 684, 91);
    db.run("UPDATE conversations SET status = 'closed' WHERE bot_id = 'folder-links' AND user_id = 684");
    const update = privateUpdate(6840, 684);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "reopenForumTopic").length, 1);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && call.body.text === "🔄 Пользователь возобновил обращение.").length, 1);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.message_thread_id === 91).length, 1);
  });
});

test("a media album reopens a closed conversation once before the album is sent", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }, registryValue[1]]);
    seedConversation(db, "folder-links", 685, 92);
    db.run("UPDATE conversations SET status = 'closed' WHERE bot_id = 'folder-links' AND user_id = 685");
    const update = privateUpdate(6850, 685, 68500);
    delete update.message.text;
    update.message.media_group_id = "reopen-album";
    update.message.photo = [{ file_id: "small" }, { file_id: "large" }];
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "reopenForumTopic").length, 1);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && call.body.text === "🔄 Пользователь возобновил обращение.").length, 1);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.message_thread_id === 92), true);
  });
});

test("manual restriction and automatic mute keep a closed conversation closed", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const now = new Date().toISOString();
    seedConversation(db, "folder-links", 686, 93);
    seedConversation(db, "folder-links", 687, 94);
    db.run("UPDATE conversations SET status = 'closed' WHERE bot_id = 'folder-links' AND user_id IN (686, 687)");
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, manual_restricted_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", "folder-links", 686, new Date(Date.now() + 60_000).toISOString(), now, now);
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, muted_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", "folder-links", 687, new Date(Date.now() + 60_000).toISOString(), now, now);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(6860, 686)), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(6870, 687)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM conversations WHERE status = 'closed' AND user_id IN (686, 687)").count, 2);
    assert.equal(calls.some((call) => call.method === "reopenForumTopic" || call.method === "forwardMessage"), false);
  });
});

test("private start and reactions do not reopen conversations", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 688, 95);
    seedConversation(db, "folder-links", 689, 96);
    db.run("UPDATE conversations SET status = 'closed' WHERE bot_id = 'folder-links' AND user_id IN (688, 689)");
    const start = privateUpdate(6880, 688);
    start.message.text = "/start";
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", start), env)).status, 200);
    assert.equal(db.get("SELECT status FROM conversations WHERE user_id = 688").status, "closed");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(6890, 689, 100, 689, [{ type: "emoji", emoji: "👍" }])), env)).status, 200);
    assert.equal(db.get("SELECT status FROM conversations WHERE user_id = 689").status, "closed");
    assert.equal(calls.filter((call) => call.method === "reopenForumTopic").length, 0);
  });
});

test("two distinct concurrent messages reopen once and are each delivered once", async () => {
  const gate = deferred();
  let held = false;
  await withFixture(async (call) => {
    if (call.method === "reopenForumTopic" && !held) {
      held = true;
      await gate.promise;
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 690, 97);
    db.run("UPDATE conversations SET status = 'closed' WHERE user_id = 690");
    const first = worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(6900, 690, 69000)), env);
    while (!held) await new Promise((resolve) => setTimeout(resolve, 0));
    const secondResponse = await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(6901, 690, 69001)), env);
    gate.resolve();
    assert.equal((await first).status, 200);
    if (secondResponse.status !== 200) assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(6901, 690, 69001)), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "reopenForumTopic").length, 1);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && /reopened the conversation|возобновил обращение/.test(call.body.text)).length, 1);
    assert.deepEqual(calls.filter((call) => call.method === "copyMessage" && call.body.from_chat_id === 690).map((call) => call.body.message_id), [69000, 69001]);
  });
});

test("contended live album retries deliver every part once after one reopen", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 691, 98);
    db.run("UPDATE conversations SET status = 'closed' WHERE user_id = 691");
    const first = privateUpdate(6910, 691, 69100);
    const second = privateUpdate(6911, 691, 69101);
    for (const [update, file] of [[first, "album-a"], [second, "album-b"]]) {
      delete update.message.text;
      update.message.media_group_id = "closed-live-album";
      update.message.photo = [{ file_id: file }];
    }
    const responses = await Promise.all([
      worker.fetch(webhookRequest("folder-links", "secret-a", first), env),
      worker.fetch(webhookRequest("folder-links", "secret-a", second), env),
    ]);
    for (let index = 0; index < responses.length; index++) {
      if (responses[index].status !== 200) {
        const update = index === 0 ? first : second;
        assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 60));
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.filter((call) => call.method === "reopenForumTopic").length, 1);
    const albums = calls.filter((call) => call.method === "sendMediaGroup" && call.body.message_thread_id === 98);
    assert.equal(albums.length, 0);
    assert.deepEqual(calls.filter(call => call.method === "copyMessage").map(call => call.body.message_id), [69100, 69101]);
  });
});

test("a native close between reopen and delivery is repaired without losing or duplicating the message", async () => {
  let forwards = 0;
  await withFixture((call) => {
    if (call.method === "copyMessage" && ++forwards === 1) return { ok: false, error_code: 400, description: "Bad Request: TOPIC_CLOSED" };
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 692, 99);
    db.run("UPDATE conversations SET status = 'closed' WHERE user_id = 692");
    const update = privateUpdate(6920, 692, 69200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "reopenForumTopic").length, 2);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && /reopened the conversation|возобновил обращение/.test(call.body.text)).length, 1);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.message_id === 69200).length, 2);
    assert.equal(db.get("SELECT status FROM conversations WHERE user_id = 692").status, "open");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM message_mappings WHERE user_id = 692 AND user_message_id = 69200").count, 1);
  });
});

test("transient reopen, marker, and panel failures recover without duplicate visible effects", async () => {
  let reopenFailures = 1;
  let markerFailures = 1;
  let panelFailures = 1;
  await withFixture((call) => {
    if (call.method === "reopenForumTopic" && reopenFailures-- > 0) return { ok: false, httpStatus: 503, error_code: 503, description: "temporary reopen outage" };
    if (call.method === "sendMessage" && /reopened the conversation|возобновил обращение/.test(call.body.text) && markerFailures-- > 0) return { ok: false, httpStatus: 429, error_code: 429, description: "retry marker" };
    if (call.method === "editMessageText" && panelFailures-- > 0) return { ok: false, httpStatus: 429, error_code: 429, description: "retry panel" };
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 693, 100);
    db.run("UPDATE conversations SET status = 'closed', panel_message_id = 7000 WHERE user_id = 693");
    const update = privateUpdate(6930, 693, 69300);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && /reopened the conversation|возобновил обращение/.test(call.body.text) && call.body.message_thread_id === 100).length, 2);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.message_id === 69300).length, 1);
    const effect = db.get("SELECT marker_delivered_at, panel_refreshed_at, business_delivered_at, completed_at FROM conversation_reopen_effects WHERE user_id = 693");
    assert.ok(effect.marker_delivered_at && effect.panel_refreshed_at && effect.business_delivered_at && effect.completed_at);
  });
});

test("users card exposes the open or closed conversation state", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }, registryValue[1]]);
    seedConversation(db, "folder-links", 694, 101);
    db.run("UPDATE conversations SET status = 'closed' WHERE user_id = 694");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(6940, 1, "/user 694")), env)).status, 200);
    const selected=lastWorkspaceScreen(calls).body.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.startsWith("um:g:card:"));
    assert.equal((await worker.fetch(webhookRequest("folder-links","secret-a",callbackUpdate(6941,1,selected.callback_data)),env)).status,200);
    assert.equal(calls.some((call) => ["sendMessage", "editMessageText"].includes(call.method) && /Обращение: закрыт/.test(call.body.text)), true);
  });
});

test("audit renders lifecycle system actions as friendly RU and EN labels", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const now = new Date().toISOString();
    db.run("INSERT INTO operator_audit (bot_id, user_id, actor_type, action, reason, result, created_at) VALUES (?, ?, 'system', ?, ?, 'success', ?)", "folder-links", 695, "conversation_reopened_by_user", "reopen_effect_id=1; old_topic=10; new_topic=10", now);
    db.run("INSERT INTO operator_audit (bot_id, user_id, actor_type, action, reason, result, created_at) VALUES (?, ?, 'system', ?, ?, 'success', ?)", "folder-links", 695, "conversation_topic_restored", "reopen_effect_id=1; old_topic=10; new_topic=11", now);

    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru" }, registryValue[1]]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(6950, 1, "/audit")), env)).status, 200);
    const ru = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1).body.text;
    assert.match(ru, /Обращение возобновлено пользователем/);
    assert.match(ru, /Тема восстановлена после удаления/);

    env.BOT_REGISTRY = JSON.stringify(registryValue);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(6951, 1, "/audit")), env)).status, 200);
    const en = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1).body.text;
    assert.match(en, /Conversation reopened by user/);
    assert.match(en, /Topic restored after deletion/);
  });
});

test("an expired conversation lock is reclaimed without an unowned delete", async () => {
  await withFixture(null, async ({ env, db }) => {
    db.run(
      "INSERT INTO conversation_locks (bot_id, user_id, owner_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      "folder-links",
      42,
      "dead-worker",
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() - 120_000).toISOString(),
    );
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(690, 42)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM conversations WHERE bot_id = 'folder-links' AND user_id = 42").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM conversation_locks").count, 0);
  });
});

test("deleted Topic redirect is removed, remapped, and delivered to a new Topic", async () => {
  let forwardCount = 0;
  await withFixture((call) => {
    if (call.method === "forwardMessage") {
      forwardCount += 1;
      if (forwardCount === 1) return { ok: true, result: { message_id: 900, message_thread_id: 1 } };
    }
    if (call.method === "createForumTopic") return { ok: true, result: { message_thread_id: 77 } };
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(700, 42)), env)).status, 200);
    assert.equal(db.get("SELECT thread_id FROM conversations WHERE bot_id = 'folder-links' AND user_id = 42").thread_id, 77);
    assert.equal(calls.some((call) => call.method === "deleteMessage" && call.body.message_id === 900), true);
    assert.equal(forwardCount, 2);
  });
});

test("contended media-group updates retry without duplicate parts", async () => {
  await withFixture(null, async ({ env, db, calls, limitCalls }) => {
    seedConversation(db, "folder-links", 42, 55);
    const first = privateUpdate(800, 42, 8100);
    first.message.media_group_id = "album-1";
    first.message.photo = [{ file_id: "photo-1" }];
    delete first.message.text;
    const second = privateUpdate(801, 42, 8101);
    second.message.media_group_id = "album-1";
    second.message.photo = [{ file_id: "photo-2" }];
    delete second.message.text;
    const results = await Promise.all([
      worker.fetch(webhookRequest("folder-links", "secret-a", first), env),
      worker.fetch(webhookRequest("folder-links", "secret-a", second), env),
    ]);
    assert.deepEqual(results.map((result) => result.status), [200, 500]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", second), env)).status, 200);
    const albums = calls.filter((call) => call.method === "sendMediaGroup");
    // A late webhook retry may arrive after the first part has already flushed.
    assert.equal(albums.length, 0);
    assert.deepEqual(calls.filter(call => call.method === "copyMessage").map(call => call.body.message_id).sort(), [8100, 8101]);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM media_groups").count, 0);
    assert.equal(limitCalls.filter((call) => call.name === "absolute").length, 2);
    assert.equal(limitCalls.filter((call) => call.name === "burst").length, 1);
    assert.equal(limitCalls.filter((call) => call.name === "minute").length, 1);
  });
});

test("support-to-user media groups are sent once through the owning bot", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    const first = groupUpdate(850, 55, "ignored");
    first.message.media_group_id = "operator-album";
    first.message.photo = [{ file_id: "operator-photo-1" }];
    delete first.message.text;
    const second = groupUpdate(851, 55, "ignored");
    second.message.media_group_id = "operator-album";
    second.message.photo = [{ file_id: "operator-photo-2" }];
    delete second.message.text;
    const results = await Promise.all([
      worker.fetch(webhookRequest("folder-links", "secret-a", first), env),
      worker.fetch(webhookRequest("folder-links", "secret-a", second), env),
    ]);
    assert.deepEqual(results.map((result) => result.status), [200, 200]);
    const albums = calls.filter((call) => call.method === "sendMediaGroup" && call.body.chat_id === 42);
    assert.equal(albums.length, 1);
    assert.equal(albums[0].token, "token-a");
    assert.equal(albums[0].body.media.length, 2);
  });
});

test("scheduled recovery flushes a stale claimed media group", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    const old = Date.now() - 120_000;
    db.run("INSERT INTO media_groups (bot_id, direction, media_group_id, source_chat_id, target_chat_id, thread_id, user_id, last_received_at, version, claimed_at, claimed_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)", "folder-links", "user_to_support", "stale", 42, -1001234567890, 55, 42, old, old, new Date(old).toISOString());
    db.run("INSERT INTO media_group_items (bot_id, direction, media_group_id, source_chat_id, message_id, media_type, file_id, caption, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", "folder-links", "user_to_support", "stale", 42, 9000, "photo", "file-1", "", old);
    const waits = [];
    await runRecoveryCycle({}, env, { waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.message_thread_id === 55), true);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM media_groups").count, 0);
  });
});

test("close command retries idempotently after D1 fails post-Telegram", async () => {
  let closeCalls = 0;
  await withFixture((call) => {
    if (call.method === "closeForumTopic") {
      closeCalls += 1;
      if (closeCalls > 1) return { ok: false, error_code: 400, description: "Bad Request: topic is already closed" };
    }
    return null;
  }, async ({ env, db }) => {
    seedConversation(db, "folder-links", 42, 55);
    db.failOnce("UPDATE conversations SET status = 'closed'");
    const update = groupUpdate(900, 55, "/close");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(closeCalls, 2);
    assert.equal(db.get("SELECT status FROM conversations WHERE bot_id = 'folder-links' AND user_id = 42").status, "closed");
  });
});

test("forum close and reopen service messages synchronize D1 state", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedConversation(db, "folder-links", 42, 55);
    const closed = groupUpdate(925, 55, "ignored");
    delete closed.message.text;
    closed.message.forum_topic_closed = {};
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", closed), env)).status, 200);
    assert.equal(db.get("SELECT status FROM conversations WHERE bot_id = 'folder-links' AND user_id = 42").status, "closed");
    const reopened = groupUpdate(926, 55, "ignored");
    delete reopened.message.text;
    reopened.message.forum_topic_reopened = {};
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reopened), env)).status, 200);
    assert.equal(db.get("SELECT status FROM conversations WHERE bot_id = 'folder-links' AND user_id = 42").status, "open");
  });
});

test("retryable operator delivery errors do not emit a permanent-failure warning", async () => {
  let fail = true;
  await withFixture((call) => {
    if (call.method === "copyMessage" && call.body.chat_id === 42 && fail) {
      fail = false;
      return { ok: false, httpStatus: 429, error_code: 429, description: "Temporary Telegram outage" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 42, 55);
    const update = groupUpdate(950, 55, "answer");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal(calls.some((call) => call.method === "sendMessage" && /Delivery failed/.test(call.body.text)), false);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
  });
});

test("a normal new user is delivered without Turnstile or a risk event", async () => {
  await withFixture(null, async ({ env, calls, db }) => {
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1100, 901)), env)).status, 200);
    assert.equal(calls.some((call) => call.method === "createForumTopic"), true);
    assert.equal(calls.some((call) => call.method === "sendMessage" && /verification/i.test(call.body.text)), false);
    assert.equal(db.get("SELECT risk_score FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 901").risk_score, 0);
  });
});

test("repeated risky content is buffered and creates no Topic until verification passes", async () => {
  await withFixture(null, async ({ env, calls, db }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], risk_turnstile_threshold: 3 }]);
    const first = privateUpdate(1110, 902);
    first.message.text = "crypto giveaway https://bad.example";
    const second = privateUpdate(1111, 902);
    second.message.text = first.message.text;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", first), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", second), env)).status, 200);
    const linkMessage = calls.find((call) => call.method === "sendMessage" && call.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url);
    assert.ok(linkMessage);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 902").count, 2);
    const token = linkMessage.body.reply_markup.inline_keyboard[0][0].url.match(/\/verify\/([A-Za-z0-9_-]+)/)[1];
    assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 0);
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.1", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    assert.equal((await worker.fetch(verify, env)).status, 200);
    assert.equal(db.get("SELECT status FROM verification_challenges WHERE bot_id = 'folder-links' AND user_id = 902").status, "passed");
    assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length, 2);
  });
});

test("absolute edge limiter applies even to a manually trusted user", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 903, 88);
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, manual_trust, created_at, updated_at) VALUES (?, ?, 1, ?, ?)", "folder-links", 903, new Date().toISOString(), new Date().toISOString());
    env.ABUSE_ABSOLUTE_LIMITER = { limit: async () => ({ success: false }) };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1120, 903)), env)).status, 200);
    assert.equal(calls.some((call) => call.method === "forwardMessage" || call.method === "copyMessage"), false);
    const abuse = db.get("SELECT muted_until, mute_level FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 903");
    assert.equal(Date.parse(abuse.muted_until) > Date.now(), true);
    assert.equal(abuse.mute_level, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM abuse_events WHERE event_type = 'temporary_mute'").count, 1);
  });
});

test("trust and untrust commands are scoped to the support Topic service", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedConversation(db, "folder-links", 904, 89);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1130, 89, "/trust")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links","secret-a",callbackUpdate(91130,89,pendingActionCallback(db))),env)).status,200);
    assert.equal(db.get("SELECT manual_trust FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 904").manual_trust, 1);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1131, 89, "/untrust")), env)).status, 200);
    assert.equal(db.get("SELECT manual_trust FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 904").manual_trust, 0);
  });
});

test("registry validates fixed edge profiles and configurable signal policy", () => {
  assert.throws(() => parseBotRegistry(JSON.stringify([{ ...registryValue[0], burst_limit: 9 }])), /must match the deployed ABUSE_BURST_LIMITER/);
  assert.throws(() => parseBotRegistry(JSON.stringify([{ ...registryValue[0], risk_weights: { unknown: 1 } }])), /invalid risk weight/);
  const [bot] = parseBotRegistry(JSON.stringify([{
    ...registryValue[0],
    spam_keywords: ["Promo"],
    risk_weights: { spam_keyword: 6, failed_turnstile: 4 },
  }]));
  assert.deepEqual(bot.spamKeywords, ["promo"]);
  assert.equal(bot.riskWeights.spamKeyword, 6);
  assert.equal(bot.riskWeights.failedTurnstile, 4);
});

test("burst and minute edge failures add service-scoped risk and soft-throttle", async () => {
  for (const [binding, expectedRisk] of [["ABUSE_BURST_LIMITER", 2], ["ABUSE_MINUTE_LIMITER", 3]]) {
    await withFixture(null, async ({ env, db, calls }) => {
      env[binding] = { limit: async () => ({ success: false }) };
      const userId = binding === "ABUSE_BURST_LIMITER" ? 1201 : 1202;
      assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(userId, userId)), env)).status, 200);
      assert.equal(db.get("SELECT risk_score FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = ?", userId).risk_score, expectedRisk);
      assert.equal(calls.some((call) => call.method === "createForumTopic"), false);
      assert.equal(calls.some((call) => call.method === "sendMessage" && /Too many/.test(call.body.text)), true);
    });
  }
});

test("duplicate hashes raise risk once and lazy decay survives frequent safe traffic", async () => {
  await withFixture(null, async ({ env, db }) => {
    for (let updateId = 1210; updateId < 1213; updateId++) {
      assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(updateId, 1210)), env)).status, 200);
    }
    const before = db.get("SELECT risk_score FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1210");
    assert.equal(before.risk_score, 3);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM abuse_events WHERE bot_id = 'folder-links' AND user_id = 1210 AND event_type = 'message'").count, 3);
    db.run("UPDATE user_abuse_state SET last_risk_at = ? WHERE bot_id = 'folder-links' AND user_id = 1210", new Date(Date.now() - 3 * 60 * 60_000).toISOString());
    const safe = privateUpdate(1213, 1210);
    safe.message.text = "a distinct support follow-up";
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", safe), env)).status, 200);
    assert.equal(db.get("SELECT risk_score FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1210").risk_score, 0);
  });
});

test("verification GET is no-store, framed off, and independently rate-limited by token, IP, and user", async () => {
  await withFixture(null, async ({ env, calls, limitCalls, db }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], locale: "ru", verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1220, 1220)), env)).status, 200);
    const token = verificationToken(calls);
    const response = await worker.fetch(new Request(`https://support.example.workers.dev/verify/${token}`, { headers: { "CF-Connecting-IP": "203.0.113.7" } }), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(response.headers.get("content-security-policy"), /https:\/\/challenges\.cloudflare\.com/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.match(await response.text(), /Подтвердите, что вы человек/);
    const verifyCalls = limitCalls.filter((call) => call.name === "verify");
    assert.equal(verifyCalls.length, 3);
    assert.equal(verifyCalls.some((call) => call.key.startsWith("verify-token:") && !call.key.includes(token)), true);
    assert.equal(verifyCalls.some((call) => call.key === "verify-ip:203.0.113.7"), true);
    assert.equal(verifyCalls.some((call) => call.key === "verify-user:folder-links:1220"), true);
    assert.notEqual(db.get("SELECT token_hash FROM verification_challenges WHERE user_id = 1220").token_hash, token);
  });
});

test("expired challenges rotate while failed Siteverify increases configured risk", async () => {
  await withFixture((call) => call.method === "siteverify" ? { success: false } : null, async ({ env, calls, db }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{
      ...registryValue[0],
      verification_mode: "always",
      risk_weights: { failed_turnstile: 4 },
    }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1230, 1230)), env)).status, 200);
    const oldToken = verificationToken(calls);
    db.run("UPDATE verification_challenges SET expires_at = ? WHERE bot_id = 'folder-links' AND user_id = 1230", new Date(Date.now() - 1000).toISOString());
    assert.equal((await worker.fetch(new Request(`https://support.example.workers.dev/verify/${oldToken}`, { headers: { "CF-Connecting-IP": "203.0.113.8" } }), env)).status, 410);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1231, 1230)), env)).status, 200);
    const newToken = verificationToken(calls, 1);
    assert.notEqual(newToken, oldToken);
    const failed = new Request(`https://support.example.workers.dev/verify/${newToken}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.8", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=bad" });
    assert.equal((await worker.fetch(failed, env)).status, 403);
    const challenge = db.get("SELECT attempt_count, status FROM verification_challenges WHERE token_hash = (SELECT token_hash FROM verification_challenges WHERE bot_id = 'folder-links' AND user_id = 1230 ORDER BY id DESC LIMIT 1)");
    assert.equal(challenge.attempt_count, 1);
    assert.equal(challenge.status, "pending");
    assert.equal(db.get("SELECT risk_score FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1230").risk_score, 4);
  });
});

test("concurrent challenge creation and replayed verification flush pending messages once", async () => {
  await withFixture(null, async ({ env, calls, db }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    const responses = await Promise.all([
      worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1240, 1240)), env),
      worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1241, 1240)), env),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 500]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1241, 1240)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM verification_challenges WHERE bot_id = 'folder-links' AND user_id = 1240 AND status = 'pending'").count, 1);
    assert.equal(verificationUrls(calls).length, 1);
    const token = verificationToken(calls);
    const makeVerify = () => new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    const verified = await Promise.all([worker.fetch(makeVerify(), env), worker.fetch(makeVerify(), env)]);
    // Either concurrent request may acquire the verification lease first.
    assert.deepEqual(verified.map((response) => response.status).sort((a, b) => a - b), [200, 409]);
    assert.equal((await worker.fetch(makeVerify(), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length, 2);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 1240 AND delivered_at IS NULL").count, 0);
    const abuse = db.get("SELECT trusted_until, verification_required FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1240");
    assert.equal(Date.parse(abuse.trusted_until) > Date.now(), true);
    assert.equal(abuse.verification_required, 0);
  });
});

test("temporary mute escalates once, expires after decay, and never creates a permanent ban", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, risk_score, last_risk_at, created_at, updated_at) VALUES (?, ?, 12, ?, ?, ?)", "folder-links", 1250, now, now, now);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1250, 1250)), env)).status, 200);
    assert.equal(db.get("SELECT mute_level FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1250").mute_level, 1);
    db.run("UPDATE user_abuse_state SET muted_until = ? WHERE bot_id = 'folder-links' AND user_id = 1250", new Date(Date.now() - 1000).toISOString());
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1251, 1250)), env)).status, 200);
    assert.equal(db.get("SELECT mute_level FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1250").mute_level, 2);
    db.run("UPDATE user_abuse_state SET muted_until = ?, last_risk_at = ? WHERE bot_id = 'folder-links' AND user_id = 1250", new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 7 * 60 * 60_000).toISOString());
    const recovered = privateUpdate(1252, 1250);
    recovered.message.text = "a distinct recovery message";
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", recovered), env)).status, 200);
    assert.equal(db.get("SELECT risk_score FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1250").risk_score, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM banned_users WHERE bot_id = 'folder-links' AND user_id = 1250").count, 0);
    assert.equal(calls.some((call) => call.method === "createForumTopic"), true);
  });
});

test("attack mode is automatic, service-isolated, bypassed by trust, and exits with hysteresis", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const now = new Date().toISOString();
    for (let index = 0; index < 20; index++) db.run("INSERT INTO abuse_events (bot_id, user_id, event_key, event_type, created_at) VALUES (?, ?, ?, 'new_user', ?)", "folder-links", 2000 + index, `seed:${index}`, now);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1260, 1260)), env)).status, 200);
    assert.equal(db.get("SELECT mode FROM service_attack_state WHERE bot_id = 'folder-links'").mode, "attack");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM conversations WHERE bot_id = 'folder-links' AND user_id = 1260").count, 0);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", privateUpdate(1260, 1260)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM conversations WHERE bot_id = 'image-compress' AND user_id = 1260").count, 1);
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, manual_trust, created_at, updated_at) VALUES (?, ?, 1, ?, ?)", "folder-links", 1261, now, now);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1261, 1261)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM conversations WHERE bot_id = 'folder-links' AND user_id = 1261").count, 1);
    db.run("DELETE FROM abuse_events WHERE bot_id = 'folder-links'");
    db.run("UPDATE service_attack_state SET anomaly_seen_at = ?, entered_at = ? WHERE bot_id = 'folder-links'", new Date(Date.now() - 16 * 60_000).toISOString(), new Date(Date.now() - 30 * 60_000).toISOString());
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1262, 1261)), env)).status, 200);
    assert.equal(db.get("SELECT mode FROM service_attack_state WHERE bot_id = 'folder-links'").mode, "normal");
    assert.equal(calls.some((call) => call.method === "sendMessage" && /ATTACK MODE/.test(call.body.text)), true);
    assert.equal(calls.some((call) => call.method === "sendMessage" && /NORMAL mode/.test(call.body.text)), true);
  });
});

test("manual attack override has priority per service", async () => {
  await withFixture(null, async ({ env, db }) => {
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1270, 1, "/attack on")), env)).status, 200);
    let state = db.get("SELECT mode, manual_override FROM service_attack_state WHERE bot_id = 'folder-links'");
    assert.equal(state.mode, "attack");
    assert.equal(state.manual_override, "on");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1271, 1, "/attack off")), env)).status, 200);
    state = db.get("SELECT mode, manual_override FROM service_attack_state WHERE bot_id = 'folder-links'");
    assert.equal(state.mode, "attack");
    assert.equal(state.manual_override, "on");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1272, 1, pendingActionCallback(db, "confirm"))), env)).status, 200);
    state = db.get("SELECT mode, manual_override FROM service_attack_state WHERE bot_id = 'folder-links'");
    assert.equal(state.mode, "normal");
    assert.equal(state.manual_override, "off");
  });
});

test("a retry after post-risk delivery failure does not duplicate risk or edge logical counts", async () => {
  let failures = 1;
  await withFixture((call) => {
    if (["forwardMessage", "copyMessage"].includes(call.method) && failures > 0) {
      failures -= 1;
      return { ok: false, httpStatus: 429, error_code: 429, description: "Temporary Telegram outage" };
    }
    return null;
  }, async ({ env, db, limitCalls }) => {
    const update = privateUpdate(1280, 1280);
    update.message.text = "crypto";
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(db.get("SELECT risk_score FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1280").risk_score, 3);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM abuse_events WHERE bot_id = 'folder-links' AND user_id = 1280 AND event_type = 'risk'").count, 1);
    assert.equal(limitCalls.filter((call) => call.name === "absolute").length, 2);
    assert.equal(limitCalls.filter((call) => call.name === "burst").length, 1);
    assert.equal(limitCalls.filter((call) => call.name === "minute").length, 1);
  });
});

test("adaptive migration removes legacy D1 realtime counters", async () => {
  await withFixture(null, async ({ db }) => {
    assert.equal(db.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('rate_limit_buckets', 'rate_limit_events')").count, 0);
  });
});

test("verification_mode always challenges only new untrusted users", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    seedConversation(db, "folder-links", 1290, 90);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1290, 1290)), env)).status, 200);
    assert.equal(verificationUrls(calls).length, 0);
    assert.equal(calls.some((call) => ["forwardMessage", "copyMessage"].includes(call.method) && call.body.message_thread_id === 90), true);
  });
});

test("manual trust flushes queued messages and ban invalidates pending verification", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    seedConversation(db, "folder-links", 1291, 91);
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, risk_score, last_risk_at, created_at, updated_at) VALUES (?, ?, 7, ?, ?, ?)", "folder-links", 1291, now, now, now);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1291, 1291)), env)).status, 200);
    const token = verificationToken(calls);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 1291 AND delivered_at IS NULL").count, 1);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1292, 91, "/trust")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links","secret-a",callbackUpdate(91292,91,pendingActionCallback(db))),env)).status,200);
    assert.equal(db.get("SELECT manual_trust FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1291").manual_trust, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 1291 AND delivered_at IS NULL").count, 0);
    assert.equal((await worker.fetch(new Request(`https://support.example.workers.dev/verify/${token}`, { headers: { "CF-Connecting-IP": "203.0.113.10" } }), env)).status, 410);

    db.run("UPDATE user_abuse_state SET manual_trust = 0, trusted_until = NULL, risk_score = 7, verification_required = 0 WHERE bot_id = 'folder-links' AND user_id = 1291");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1293, 1291)), env)).status, 200);
    const secondToken = verificationToken(calls, 1);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1294, 91, "/ban repeated abuse")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1295, 91, pendingActionCallback(db, "confirm"))), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 1291").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 1291 AND delivered_at IS NULL").count, 0);
    assert.equal((await worker.fetch(new Request(`https://support.example.workers.dev/verify/${secondToken}`, { headers: { "CF-Connecting-IP": "203.0.113.10" } }), env)).status, 410);
  });
});

test("Turnstile outage preserves the pending queue and creates no Topic", async () => {
  await withFixture((call) => {
    if (call.method === "siteverify") throw new Error("Turnstile down");
    return null;
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1300, 1300)), env)).status, 200);
    const token = verificationToken(calls);
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.11", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    assert.equal((await worker.fetch(verify, env)).status, 503);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 1300 AND delivered_at IS NULL").count, 1);
    assert.equal(db.get("SELECT status FROM verification_challenges WHERE bot_id = 'folder-links' AND user_id = 1300").status, "pending");
    assert.equal(calls.some((call) => call.method === "createForumTopic"), false);
  });
});

test("a passed verification URL cannot flush a newer queue after untrust", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1310, 1310)), env)).status, 200);
    const oldToken = verificationToken(calls);
    const firstPass = new Request(`https://support.example.workers.dev/verify/${oldToken}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.20", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=first-proof" });
    assert.equal((await worker.fetch(firstPass, env)).status, 200);
    const threadId = db.get("SELECT thread_id FROM conversations WHERE bot_id = 'folder-links' AND user_id = 1310").thread_id;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1311, threadId, "/untrust")), env)).status, 200);
    db.run("UPDATE user_abuse_state SET risk_score = 7, last_risk_at = ? WHERE bot_id = 'folder-links' AND user_id = 1310", new Date().toISOString());
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1312, 1310)), env)).status, 200);
    assert.ok(verificationToken(calls, 1));
    const copiesBeforeReplay = calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length;
    assert.equal((await worker.fetch(new Request(`https://support.example.workers.dev/verify/${oldToken}`, { headers: { "CF-Connecting-IP": "203.0.113.21" } }), env)).status, 410);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length, copiesBeforeReplay);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 1310 AND delivered_at IS NULL").count, 1);
  });
});

test("temporary mute invalidates an active challenge and prevents its flush", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1320, 1320)), env)).status, 200);
    const token = verificationToken(calls);
    env.ABUSE_ABSOLUTE_LIMITER = { limit: async () => ({ success: false }) };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1321, 1320)), env)).status, 200);
    const challenge = db.get("SELECT status FROM verification_challenges WHERE bot_id = 'folder-links' AND user_id = 1320");
    assert.equal(challenge.status, "expired");
    assert.equal(Date.parse(db.get("SELECT muted_until FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1320").muted_until) > Date.now(), true);
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.22", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    assert.equal((await worker.fetch(verify, env)).status, 410);
    assert.equal(calls.some((call) => call.method === "createForumTopic"), false);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 1320 AND delivered_at IS NULL").count, 1);
  });
});

test("Siteverify idempotency is scoped to one application challenge", async () => {
  const accepted = new Map();
  await withFixture((call) => {
    if (call.method !== "siteverify") return null;
    const params = new URLSearchParams(call.body);
    const response = params.get("response");
    const key = params.get("idempotency_key");
    if (!accepted.has(response)) accepted.set(response, key);
    return accepted.get(response) === key
      ? { success: true, action: "support_verify", hostname: "support.example.workers.dev" }
      : { success: false, "error-codes": ["timeout-or-duplicate"] };
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1330, 1330)), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1331, 1331)), env)).status, 200);
    const firstToken = verificationToken(calls, 0);
    const secondToken = verificationToken(calls, 1);
    const makeVerify = (token, ip) => new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": ip, "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=shared-cloudflare-token" });
    assert.equal((await worker.fetch(makeVerify(firstToken, "203.0.113.23"), env)).status, 200);
    assert.equal((await worker.fetch(makeVerify(secondToken, "203.0.113.24"), env)).status, 403);
    const siteverifyCalls = calls.filter((call) => call.method === "siteverify").map((call) => new URLSearchParams(call.body).get("idempotency_key"));
    assert.equal(siteverifyCalls.length, 2);
    assert.notEqual(siteverifyCalls[0], siteverifyCalls[1]);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM verification_challenges WHERE status = 'passed'").count, 1);
  });
});

test("absolute limiter binding failure safely degrades for unknown users and preserves existing conversations", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.ABUSE_ABSOLUTE_LIMITER = { limit: async () => { throw new Error("limiter unavailable"); } };
    const update = privateUpdate(61_100, 61_100);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(verificationUrls(calls).length, 1);
    assert.equal(calls.some((call) => ["createForumTopic", "forwardMessage", "copyMessage"].includes(call.method)), false);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 61100 AND delivered_at IS NULL").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM abuse_events WHERE bot_id = 'folder-links' AND user_id = 61100 AND event_type = 'limiter_unavailable'").count, 1);
  });

  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 61_101, 611);
    env.ABUSE_ABSOLUTE_LIMITER = { limit: async () => { throw new Error("limiter unavailable"); } };
    const update = privateUpdate(61_101, 61_101);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(verificationUrls(calls).length, 0);
    assert.equal(calls.some((call) => ["forwardMessage", "copyMessage"].includes(call.method) && call.body.message_thread_id === 611), true);
  });
});

test("logical limiter binding failure safely degrades across retries and preserves existing conversations", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.ABUSE_BURST_LIMITER = { limit: async () => { throw new Error("limiter unavailable"); } };
    const update = privateUpdate(1340, 1340);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(verificationUrls(calls).length, 1);
    assert.equal(calls.some((call) => ["createForumTopic", "forwardMessage", "copyMessage"].includes(call.method)), false);
    const guard = db.get("SELECT state, burst_allowed, minute_allowed FROM logical_message_guards WHERE bot_id = 'folder-links' AND user_id = 1340");
    assert.equal(guard.state, "decided");
    assert.equal(guard.burst_allowed, 1);
    assert.equal(guard.minute_allowed, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM abuse_events WHERE bot_id = 'folder-links' AND user_id = 1340 AND event_type = 'limiter_unavailable'").count, 1);
  });

  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 61_111, 612);
    env.ABUSE_BURST_LIMITER = { limit: async () => { throw new Error("limiter unavailable"); } };
    const update = privateUpdate(61_111, 61_111);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(verificationUrls(calls).length, 0);
    assert.equal(calls.some((call) => ["forwardMessage", "copyMessage"].includes(call.method) && call.body.message_thread_id === 612), true);
  });
});

for (const binding of ["ABUSE_ABSOLUTE_LIMITER", "ABUSE_BURST_LIMITER", "ABUSE_MINUTE_LIMITER"]) {
  test(`Free retry remembers ${binding} outage after the binding recovers`, async () => {
    for (const failure of ["INSERT INTO logical_message_guards", "UPDATE logical_message_guards SET state = 'limited'", "SELECT * FROM service_attack_state WHERE bot_id = ?"]) {
      // A logical limiter has not run yet if inserting its guard fails.
      if (binding !== "ABUSE_ABSOLUTE_LIMITER" && failure === "INSERT INTO logical_message_guards") continue;
      await withFixture(null, async ({ env, db, calls }) => {
        env.RECOVERY_D1_PLAN = "free";
        env.TURNSTILE_SITE_KEY = "site-key";
        env.TURNSTILE_SECRET_KEY = "secret-key";
        const healthyLimiter = env[binding];
        env[binding] = { limit: async () => { throw new Error("limiter unavailable"); } };
        db.failOnce(failure);
        const request = () => webhookRequest("folder-links", "secret-a", privateUpdate(61_120, 61_120));
        assert.equal((await countedFreeFetch(worker, request(), env)).status, 500, failure);
        env[binding] = healthyLimiter;
        assert.equal((await countedFreeFetch(worker, request(), env)).status, 200, failure);
        assert.equal(verificationUrls(calls).length, 1);
        assert.equal(calls.some((call) => ["createForumTopic", "forwardMessage", "copyMessage"].includes(call.method)), false);
        assert.equal(db.get("SELECT COUNT(*) AS n FROM abuse_events WHERE user_id = 61120 AND event_type = 'limiter_unavailable'").n, 1);
      });
    }
  });
}

for (const plan of ["free", "paid"]) {
  for (const binding of ["ABUSE_ABSOLUTE_LIMITER", "ABUSE_BURST_LIMITER", "ABUSE_MINUTE_LIMITER"]) {
    test(`${plan}: album parts remember ${binding} outage across failed processing`, async () => {
      for (const failure of ["UPDATE logical_message_guards SET risk_delta", "SELECT * FROM service_attack_state WHERE bot_id = ?"]) {
        for (const recovered of [false, true]) await withFixture(null, async ({ env, db, calls }) => {
          env.RECOVERY_D1_PLAN = plan;
          env.TURNSTILE_SITE_KEY = "site-key";
          env.TURNSTILE_SECRET_KEY = "secret-key";
          const healthyLimiter = env[binding];
          env[binding] = { limit: async () => { throw new Error("limiter unavailable"); } };
          db.failOnce(failure);
          const part = (id) => {
            const update = privateUpdate(id, 70100);
            delete update.message.text;
            update.message.media_group_id = "outage-album";
            update.message.photo = [{ file_id: `photo-${id}` }];
            return webhookRequest("folder-links", "secret-a", update);
          };
          const fetchPart = async (id) => {
            const scope = { queries: 0, limit: plan === "free" ? 50 : 1000 };
            const response = await recoveryQueryScope.run(scope, () => worker.fetch(part(id), env));
            assert.ok(scope.queries <= scope.limit);
            return response;
          };
          assert.equal((await fetchPart(70101)).status, 500, failure);
          assert.equal(db.failures.length, 0);
          if (recovered) env[binding] = healthyLimiter;
          assert.equal((await fetchPart(70102)).status, 200);
          assert.equal((await fetchPart(70101)).status, 200);
          assert.equal(verificationUrls(calls).length, 1);
          assert.equal(calls.some((call) => ["createForumTopic", "forwardMessage", "copyMessage", "sendMediaGroup"].includes(call.method)), false);
          assert.equal(db.get("SELECT verification_required FROM user_abuse_state WHERE user_id = 70100").verification_required, 1);
          assert.equal(db.get("SELECT COUNT(*) AS n FROM pending_messages WHERE user_id = 70100 AND delivered_at IS NULL").n, 2);
          assert.equal(db.get("SELECT COUNT(*) AS n FROM abuse_decision_locks").n, 0);
          assert.equal(db.get("SELECT COUNT(*) AS n FROM logical_message_guards WHERE owner_token IS NOT NULL").n, 0);
        });
      }
    });
  }
}

test("Free album retry still reads limiter outage markers saved by the previous version", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.RECOVERY_D1_PLAN = "free";
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    const healthyLimiter = env.ABUSE_BURST_LIMITER;
    env.ABUSE_BURST_LIMITER = { limit: async () => { throw new Error("limiter unavailable"); } };
    const update = privateUpdate(70201, 70200);
    delete update.message.text;
    update.message.media_group_id = "legacy-outage-album";
    update.message.photo = [{ file_id: "legacy-photo" }];
    const request = () => webhookRequest("folder-links", "secret-a", update);
    db.failOnce("SELECT * FROM service_attack_state WHERE bot_id = ?");
    assert.equal((await countedFreeFetch(worker, request(), env)).status, 500);
    // Model the durable event written before album-scoped keys were introduced.
    db.run("UPDATE abuse_events SET event_key = 'update:70201:limiter' WHERE user_id = 70200 AND event_type = 'limiter_unavailable'");
    env.ABUSE_BURST_LIMITER = healthyLimiter;
    assert.equal((await countedFreeFetch(worker, request(), env)).status, 200);
    assert.equal(verificationUrls(calls).length, 1);
    assert.equal(calls.some((call) => ["createForumTopic", "forwardMessage", "copyMessage", "sendMediaGroup"].includes(call.method)), false);
  });
});

test("a retry preserves a completed soft-throttle decision", async () => {
  await withFixture(null, async ({ env, db, calls, limitCalls }) => {
    env.ABUSE_BURST_LIMITER = { limit: async ({ key }) => { limitCalls.push({ name: "burst", key }); return { success: false }; } };
    db.failOnce("SELECT * FROM service_attack_state WHERE bot_id = ?");
    const update = privateUpdate(1341, 1341);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(limitCalls.filter((call) => call.name === "burst").length, 1);
    assert.equal(calls.some((call) => call.method === "createForumTopic" || call.method === "forwardMessage"), false);
    const guard = db.get("SELECT state, burst_allowed, minute_allowed FROM logical_message_guards WHERE bot_id = 'folder-links' AND user_id = 1341");
    assert.equal(guard.state, "decided");
    assert.equal(guard.burst_allowed, 0);
    assert.equal(guard.minute_allowed, 1);
  });
});

test("a mid-risk D1 failure resumes without counting edge limits twice", async () => {
  await withFixture(null, async ({ env, db, calls, limitCalls }) => {
    db.failOnce("INSERT INTO abuse_events (bot_id, user_id, event_key, event_type, value_hash");
    const update = privateUpdate(1342, 1342);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(limitCalls.filter((call) => call.name === "burst").length, 1);
    assert.equal(limitCalls.filter((call) => call.name === "minute").length, 1);
    assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
    assert.equal(db.get("SELECT state FROM logical_message_guards WHERE bot_id = 'folder-links' AND user_id = 1342").state, "decided");
  });
});

test("an unsent challenge token is rotated and delivered after a post-insert failure", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    db.failOnce("UPDATE pending_messages SET challenge_id");
    const update = privateUpdate(1343, 1343);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 1343 AND challenge_id IS NULL").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM verification_challenges WHERE user_id = 1343 AND notice_sent_at IS NULL").count, 1);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    const token = verificationToken(calls);
    assert.equal((await worker.fetch(new Request(`https://support.example.workers.dev/verify/${token}`, { headers: { "CF-Connecting-IP": "203.0.113.31" } }), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 1343 AND challenge_id IS NULL").count, 0);
  });
});

test("pending queue cap is enforced by the insert under concurrent webhooks", async () => {
  await withFixture(null, async ({ env, db }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always", pending_message_limit: 1 }]);
    const responses = await Promise.all([
      worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1350, 1350)), env),
      worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1351, 1350)), env),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 500]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1351, 1350)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(DISTINCT COALESCE(media_group_id, 'update:' || update_id)) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 1350 AND delivered_at IS NULL").count, 1);
  });
});

test("pending flush probes and recreates a deleted Topic before copying", async () => {
  await withFixture((call) => {
    if (call.method === "sendMessage" && call.body.chat_id === -1001234567890 && call.body.message_thread_id === 55 && call.body.text === "🔎") {
      return { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    seedConversation(db, "folder-links", 1360, 55);
    seedCompletedProvision(db, "folder-links", 1360, 55);
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, risk_score, last_risk_at, created_at, updated_at) VALUES (?, ?, 7, ?, ?, ?)", "folder-links", 1360, now, now, now);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1360, 1360)), env)).status, 200);
    const token = verificationToken(calls);
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.25", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    assert.equal((await worker.fetch(verify, env)).status, 200);
    const newThread = db.get("SELECT thread_id FROM conversations WHERE bot_id = 'folder-links' AND user_id = 1360").thread_id;
    assert.notEqual(newThread, 55);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.message_thread_id === newThread), true);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 1360 AND delivered_at IS NULL").count, 0);
  });
});

test("pending replay repairs delivered_at from mapping without a duplicate copy", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1370, 1370)), env)).status, 200);
    const token = verificationToken(calls);
    db.failOnce("UPDATE pending_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL");
    const verify = () => new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.26", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    assert.equal((await worker.fetch(verify(), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length, 1);
    assert.equal((await worker.fetch(new Request(`https://support.example.workers.dev/verify/${token}`, { headers: { "CF-Connecting-IP": "203.0.113.26" } }), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 1370 AND delivered_at IS NULL").count, 0);
  });
});

test("a stale flush owner is fenced before it can duplicate a pending copy", async () => {
  let releaseFirstProbe;
  let blockedProbeThread;
  await withFixture((call) => {
    if (call.method === "sendMessage" && call.body.chat_id === -1001234567890 && call.body.text === "🔎" && !releaseFirstProbe) {
      blockedProbeThread = call.body.message_thread_id;
      return new Promise((resolve) => { releaseFirstProbe = resolve; });
    }
    return null;
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1371, 1371)), env)).status, 200);
    const token = verificationToken(calls);
    const firstVerify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.34", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    const firstResult = worker.fetch(firstVerify, env);
    for (let attempt = 0; attempt < 200 && !releaseFirstProbe; attempt++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(releaseFirstProbe);
    db.run("UPDATE pending_flush_locks SET lease_expires_at = ? WHERE bot_id = 'folder-links' AND user_id = 1371", new Date(Date.now() - 1000).toISOString());
    assert.equal((await worker.fetch(new Request(`https://support.example.workers.dev/verify/${token}`, { headers: { "CF-Connecting-IP": "203.0.113.35" } }), env)).status, 200);
    releaseFirstProbe({ ok: true, result: { message_id: 9999, message_thread_id: blockedProbeThread } });
    assert.equal((await firstResult).status, 200);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 1371 AND delivered_at IS NULL").count, 0);
  });
});

test("concurrent failed Turnstile attempts each apply risk exactly once", async () => {
  await withFixture((call) => call.method === "siteverify" ? { success: false } : null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always", risk_weights: { failed_turnstile: 4 } }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1380, 1380)), env)).status, 200);
    const token = verificationToken(calls);
    const makeVerify = (proof, ip) => new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": ip, "content-type": "application/x-www-form-urlencoded" }, body: `cf-turnstile-response=${proof}` });
    const responses = await Promise.all([
      worker.fetch(makeVerify("bad-one", "203.0.113.27"), env),
      worker.fetch(makeVerify("bad-two", "203.0.113.28"), env),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [403, 403]);
    assert.equal(db.get("SELECT attempt_count FROM verification_challenges WHERE user_id = 1380").attempt_count, 2);
    assert.equal(db.get("SELECT risk_score FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1380").risk_score, 8);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM abuse_events WHERE user_id = 1380 AND event_type = 'verification_failed'").count, 2);
  });
});

test("failed Turnstile attempts reaching severe risk mute and invalidate the challenge", async () => {
  await withFixture((call) => {
    if (call.method !== "siteverify") return null;
    const response = new URLSearchParams(call.body).get("response");
    return response.startsWith("bad-") ? { success: false } : { success: true, action: "support_verify", hostname: "support.example.workers.dev" };
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always", risk_weights: { failed_turnstile: 4 } }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1381, 1381)), env)).status, 200);
    const token = verificationToken(calls);
    const makeVerify = (proof) => new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.32", "content-type": "application/x-www-form-urlencoded" }, body: `cf-turnstile-response=${proof}` });
    for (const proof of ["bad-one", "bad-two", "bad-three"]) assert.equal((await worker.fetch(makeVerify(proof), env)).status, 403);
    const state = db.get("SELECT risk_score, muted_until FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1381");
    assert.equal(state.risk_score, 12);
    assert.equal(Date.parse(state.muted_until) > Date.now(), true);
    assert.equal(db.get("SELECT status FROM verification_challenges WHERE user_id = 1381").status, "expired");
    assert.equal((await worker.fetch(makeVerify("valid-proof"), env)).status, 410);
    assert.equal(calls.some((call) => call.method === "createForumTopic"), false);
  });
});

test("a passed challenge can recover its own pending row after untrust", async () => {
  let failCopy = true;
  await withFixture((call) => {
    if (call.method === "copyMessage" && call.body.chat_id === -1001234567890 && failCopy) {
      failCopy = false;
      return { ok: false, httpStatus: 429, error_code: 429, description: "Temporary Telegram outage" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1382, 1382)), env)).status, 200);
    const token = verificationToken(calls);
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.33", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    assert.equal((await worker.fetch(verify, env)).status, 200);
    const threadId = db.get("SELECT thread_id FROM conversations WHERE bot_id = 'folder-links' AND user_id = 1382").thread_id;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1383, threadId, "/untrust")), env)).status, 200);
    assert.equal((await worker.fetch(new Request(`https://support.example.workers.dev/verify/${token}`, { headers: { "CF-Connecting-IP": "203.0.113.33" } }), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 1382 AND delivered_at IS NULL").count, 0);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length, 2);
  });
});

test("verification respects the persisted bot emergency disable", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1390, 1390)), env)).status, 200);
    const token = verificationToken(calls);
    assert.equal(calls.some((call) => call.method === "createForumTopic"), false);
    assert.equal(db.get("SELECT enabled FROM bots WHERE id = 'folder-links'").enabled, 1);
    assert.equal(db.run("UPDATE bots SET enabled = 0 WHERE id = 'folder-links'").changes, 1);
    const siteverifyBefore = calls.filter((call) => call.method === "siteverify").length;
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.29", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    assert.equal((await worker.fetch(verify, env)).status, 410);
    assert.equal(calls.filter((call) => call.method === "siteverify").length, siteverifyBefore);
    assert.equal(calls.some((call) => call.method === "createForumTopic"), false);
  });
});

test("Turnstile hostname defaults to PUBLIC_BASE_URL and rejects another origin", async () => {
  await withFixture((call) => call.method === "siteverify" ? { success: true, action: "support_verify", hostname: "evil.example" } : null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1400, 1400)), env)).status, 200);
    const token = verificationToken(calls);
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.30", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    assert.equal((await worker.fetch(verify, env)).status, 403);
    assert.equal(db.get("SELECT trusted_until FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1400").trusted_until, null);
    assert.equal(calls.some((call) => call.method === "createForumTopic"), false);
  });
});

test("concurrent first-contact risk decisions cannot provision a Topic before verification", async () => {
  const enteredLimiter = deferred();
  const releaseLimiter = deferred();
  let firstBurst = true;
  await withFixture(null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.ABUSE_BURST_LIMITER = {
      limit: async () => {
        if (firstBurst) {
          firstBurst = false;
          enteredLimiter.resolve();
          await releaseLimiter.promise;
        }
        return { success: true };
      },
    };
    const risky = privateUpdate(1410, 1410);
    risky.message.text = "crypto https://one.example https://two.example https://three.example @one @two @three";
    const safe = privateUpdate(1411, 1410, 14101);
    const riskyResult = worker.fetch(webhookRequest("folder-links", "secret-a", risky), env);
    await enteredLimiter.promise;
    const safeResult = worker.fetch(webhookRequest("folder-links", "secret-a", safe), env);
    releaseLimiter.resolve();
    assert.deepEqual((await Promise.all([riskyResult, safeResult])).map((response) => response.status), [200, 500]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", safe), env)).status, 200);
    assert.equal(db.get("SELECT verification_required FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1410").verification_required, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 1410 AND delivered_at IS NULL AND failed_at IS NULL").count, 2);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM verification_challenges WHERE bot_id = 'folder-links' AND user_id = 1410 AND status = 'pending'").count, 1);
    assert.equal(verificationUrls(calls).length, 1);
    assert.equal(calls.some((call) => call.method === "createForumTopic" || call.method === "forwardMessage" || call.method === "copyMessage"), false);
  });
});

test("verification pre-limit rejects random tokens before touching D1", async () => {
  await withFixture(null, async ({ env, calls }) => {
    let dbTouches = 0;
    const keys = [];
    env.SUPPORT_DB = { prepare: () => { dbTouches += 1; throw new Error("D1 must not be touched"); } };
    env.VERIFY_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: !key.startsWith("verify-ip:") };
      },
    };
    const response = await worker.fetch(new Request("https://support.example.workers.dev/verify/abcdefghijklmnopqrstuvwxyzABCDEF", { headers: { "CF-Connecting-IP": "203.0.113.40" } }), env);
    assert.equal(response.status, 429);
    assert.equal(dbTouches, 0);
    assert.equal(keys.some((key) => key.startsWith("verify-token:")), true);
    assert.equal(keys.includes("verify-ip:203.0.113.40"), true);
    assert.equal(calls.length, 0);
  });
});

test("replaying the same failed Turnstile response applies one durable failure", async () => {
  await withFixture((call) => call.method === "siteverify" ? { success: false } : null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1420, 1420)), env)).status, 200);
    const token = verificationToken(calls);
    const verify = () => new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.41", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=same-bad-proof" });
    assert.equal((await worker.fetch(verify(), env)).status, 403);
    assert.equal((await worker.fetch(verify(), env)).status, 403);
    assert.equal(calls.filter((call) => call.method === "siteverify").length, 1);
    assert.equal(db.get("SELECT attempt_count FROM verification_challenges WHERE user_id = 1420").attempt_count, 1);
    assert.equal(db.get("SELECT risk_score FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1420").risk_score, 3);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM verification_attempts WHERE status = 'failed' AND effects_applied = 1").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM abuse_events WHERE user_id = 1420 AND event_type = 'verification_failed'").count, 1);
  });
});

test("a ban committed during a pending probe revokes the flush before copy", async () => {
  const probeStarted = deferred();
  const releaseProbe = deferred();
  let heldProbe = false;
  await withFixture(async (call) => {
    if (!heldProbe && call.method === "sendMessage" && call.body.chat_id === -1001234567890 && call.body.text === "🔎") {
      heldProbe = true;
      probeStarted.resolve(call.body.message_thread_id);
      return releaseProbe.promise;
    }
    return null;
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1430, 1430)), env)).status, 200);
    const token = verificationToken(calls);
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.42", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=valid-proof" });
    const verifyResult = worker.fetch(verify, env);
    const threadId = await probeStarted.promise;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1431, threadId, "/ban concurrent abuse")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1433, threadId, pendingActionCallback(db, "confirm"))), env)).status, 200);
    releaseProbe.resolve({ ok: true, result: { message_id: 9900, message_thread_id: threadId } });
    assert.equal((await verifyResult).status, 200);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM banned_users WHERE bot_id = 'folder-links' AND user_id = 1430").count, 1);
    assert.equal(db.get("SELECT status FROM verification_challenges WHERE user_id = 1430").status, "failed");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 1430 AND delivered_at IS NULL").count, 0);
  });
});

test("a temporary mute committed during a pending probe revokes the flush before copy", async () => {
  const probeStarted = deferred();
  const releaseProbe = deferred();
  let heldProbe = false;
  await withFixture(async (call) => {
    if (!heldProbe && call.method === "sendMessage" && call.body.chat_id === -1001234567890 && call.body.text === "🔎") {
      heldProbe = true;
      probeStarted.resolve(call.body.message_thread_id);
      return releaseProbe.promise;
    }
    return null;
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1432, 1432)), env)).status, 200);
    const token = verificationToken(calls);
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.46", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=valid-proof" });
    const verifyResult = worker.fetch(verify, env);
    const threadId = await probeStarted.promise;
    assert.ok(threadId);
    env.ABUSE_ABSOLUTE_LIMITER = { limit: async () => ({ success: false }) };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1433, 1432, 14330)), env)).status, 200);
    releaseProbe.resolve({ ok: true, result: { message_id: 9901, message_thread_id: threadId } });
    assert.equal((await verifyResult).status, 200);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length, 0);
    assert.equal(Date.parse(db.get("SELECT muted_until FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1432").muted_until) > Date.now(), true);
    assert.equal(db.get("SELECT status FROM verification_challenges WHERE user_id = 1432").status, "expired");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 1432 AND delivered_at IS NULL AND failed_at IS NULL").count, 1);
    assert.equal(db.get("SELECT pending_release_required FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1432").pending_release_required, 1);
  });
});

test("a permanent pending source failure is dead-lettered without blocking later rows", async () => {
  await withFixture((call) => {
    if (call.method === "copyMessage" && call.body.message_id === 14400) return { ok: false, error_code: 400, description: "Bad Request: message to copy not found" };
    return null;
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1440, 1440, 14400)), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1441, 1440, 14401)), env)).status, 200);
    const token = verificationToken(calls);
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.43", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=valid-proof" });
    assert.equal((await worker.fetch(verify, env)).status, 200);
    const failed = db.get("SELECT failed_at, failure_code, delivered_at FROM pending_messages WHERE user_id = 1440 AND source_message_id = 14400");
    const delivered = db.get("SELECT failed_at, delivered_at FROM pending_messages WHERE user_id = 1440 AND source_message_id = 14401");
    assert.equal(Boolean(failed.failed_at), true);
    assert.equal(failed.failure_code, "telegram_source_unavailable");
    assert.equal(failed.delivered_at, null);
    assert.equal(Boolean(delivered.delivered_at), true);
    assert.equal(db.get("SELECT COUNT(*) n FROM abuse_events WHERE bot_id='folder-links' AND user_id=1440 AND event_type='pending_delivery_failed'").n,1);
    assert.equal(delivered.failed_at, null);
    assert.equal(Boolean(db.get("SELECT flushed_at FROM verification_challenges WHERE user_id = 1440").flushed_at), true);
    const copies = calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length;
    assert.equal(copies, 2);
    assert.equal((await worker.fetch(new Request(`https://support.example.workers.dev/verify/${token}`, { headers: { "CF-Connecting-IP": "203.0.113.43" } }), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.chat_id === -1001234567890).length, copies);
  });
});

test("switching verification off retries a transient pending release durably", async () => {
  let failCopy = true;
  await withFixture((call) => {
    if (call.method === "copyMessage" && call.body.message_id === 14500 && failCopy) {
      failCopy = false;
      return { ok: false, httpStatus: 429, error_code: 429, description: "Temporary Telegram outage" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1450, 1450, 14500)), env)).status, 200);
    const token = verificationToken(calls);
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "off" }]);
    const next = privateUpdate(1451, 1450, 14501);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", next), env)).status, 500);
    let state = db.get("SELECT verification_required, pending_release_required FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1450");
    assert.equal(state.verification_required, 0);
    assert.equal(state.pending_release_required, 1);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", next), env)).status, 200);
    state = db.get("SELECT verification_required, pending_release_required FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1450");
    assert.equal(state.verification_required, 0);
    assert.equal(state.pending_release_required, 0);
    assert.equal(db.get("SELECT status FROM verification_challenges WHERE user_id = 1450").status, "expired");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 1450 AND delivered_at IS NULL AND failed_at IS NULL").count, 0);
    assert.equal((await worker.fetch(new Request(`https://support.example.workers.dev/verify/${token}`, { headers: { "CF-Connecting-IP": "203.0.113.44" } }), env)).status, 410);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.message_id === 14500).length, 2);
  });
});

test("riskreset retries and completes release of an existing pending queue", async () => {
  let failCopy = true;
  await withFixture((call) => {
    if (call.method === "copyMessage" && call.body.message_id === 14600 && failCopy) {
      failCopy = false;
      return { ok: false, httpStatus: 429, error_code: 429, description: "Temporary Telegram outage" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1460, 55);
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, risk_score, last_risk_at, verification_required, created_at, updated_at) VALUES (?, ?, 9, ?, 1, ?, ?)", "folder-links", 1460, now, now, now);
    const challenge = db.run("INSERT INTO verification_challenges (bot_id, user_id, token_hash, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)", "folder-links", 1460, "riskreset-token-hash", now, new Date(Date.now() + 60000).toISOString());
    db.run("INSERT INTO pending_messages (bot_id, user_id, challenge_id, update_id, source_chat_id, source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "folder-links", 1460, Number(challenge.lastInsertRowid), 14600, 1460, 14600, now);
    const command = groupUpdate(1461, 55, "/riskreset");
    assert.equal((await worker.fetch(webhookRequest("folder-links","secret-a",command),env)).status,200);
    const confirmation=callbackUpdate(91461,55,pendingActionCallback(db));
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", confirmation), env)).status, 500);
    assert.equal(db.get("SELECT pending_release_required FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1460").pending_release_required, 1);
    assert.equal((await worker.fetch(webhookRequest("folder-links","secret-a",groupUpdate(1462,55,"/riskreset")),env)).status,200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(91462,55,pendingActionCallback(db))), env)).status, 200);
    const state = db.get("SELECT risk_score, muted_until, verification_required, pending_release_required FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1460");
    assert.equal(state.risk_score, 0);
    assert.equal(state.muted_until, null);
    assert.equal(state.verification_required, 0);
    assert.equal(state.pending_release_required, 0);
    assert.equal(db.get("SELECT status FROM verification_challenges WHERE user_id = 1460").status, "expired");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 1460 AND delivered_at IS NULL AND failed_at IS NULL").count, 0);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.message_id === 14600).length, 2);
  });
});

test("scheduled recovery honors the persisted per-bot emergency disable", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1470, 55);
    const old = Date.now() - 120_000;
    db.run("INSERT INTO bots (id, display_name, topic_prefix, enabled, created_at) VALUES (?, ?, ?, 0, ?)", "folder-links", "Folder Links", "Folder Links", new Date(old).toISOString());
    db.run("INSERT INTO media_groups (bot_id, direction, media_group_id, source_chat_id, target_chat_id, thread_id, user_id, last_received_at, version, claimed_at, claimed_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)", "folder-links", "user_to_support", "disabled-stale", 1470, -1001234567890, 55, 1470, old, old, new Date(old).toISOString());
    db.run("INSERT INTO media_group_items (bot_id, direction, media_group_id, source_chat_id, message_id, media_type, file_id, caption, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", "folder-links", "user_to_support", "disabled-stale", 1470, 14700, "photo", "file-disabled", "", old);
    const waits = [];
    await runRecoveryCycle({}, env, { waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    assert.equal(calls.some((call) => call.token === "token-a"), false);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM media_groups WHERE bot_id = 'folder-links' AND media_group_id = 'disabled-stale'").count, 1);
  });
});

test("scheduled recovery applies a committed failed-verification outbox once", async () => {
  await withFixture((call) => call.method === "siteverify" ? { success: false } : null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1480, 1480)), env)).status, 200);
    const token = verificationToken(calls);
    db.failOnce("INSERT INTO abuse_events (bot_id, user_id, event_key, event_type, risk_delta, risk_applied");
    const verify = new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.45", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=failed-outbox" });
    assert.equal((await worker.fetch(verify, env)).status, 503);
    assert.equal(db.get("SELECT status, effects_applied FROM verification_attempts").status, "failed");
    assert.equal(db.get("SELECT effects_applied FROM verification_attempts").effects_applied, 0);
    const waits = [];
    await runRecoveryCycle({}, env, { waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    assert.equal(db.get("SELECT effects_applied FROM verification_attempts").effects_applied, 1);
    assert.equal(db.get("SELECT risk_score FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1480").risk_score, 3);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM abuse_events WHERE user_id = 1480 AND event_type = 'verification_failed'").count, 1);
  });
});

test("an unapplied failed proof is recovered before a distinct valid proof can pass", async () => {
  await withFixture((call) => {
    if (call.method !== "siteverify") return null;
    const proof = new URLSearchParams(call.body).get("response");
    return proof === "valid-after-failure"
      ? { success: true, action: "support_verify", hostname: "support.example.workers.dev" }
      : { success: false };
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1490, 1490)), env)).status, 200);
    const token = verificationToken(calls);
    db.run("UPDATE user_abuse_state SET risk_score = 10 WHERE bot_id = 'folder-links' AND user_id = 1490");
    db.failOnce("INSERT INTO abuse_events (bot_id, user_id, event_key, event_type, risk_delta, risk_applied");
    const verify = (proof) => new Request(`https://support.example.workers.dev/verify/${token}`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.46", "content-type": "application/x-www-form-urlencoded" },
      body: `cf-turnstile-response=${proof}`,
    });
    assert.equal((await worker.fetch(verify("failed-before-pass"), env)).status, 503);
    assert.equal(db.get("SELECT effects_applied FROM verification_attempts WHERE status = 'failed'").effects_applied, 0);
    assert.equal((await worker.fetch(verify("valid-after-failure"), env)).status, 410);
    assert.equal(calls.filter((call) => call.method === "siteverify").length, 1);
    assert.equal(db.get("SELECT status FROM verification_challenges WHERE user_id = 1490").status, "expired");
    assert.ok(Date.parse(db.get("SELECT muted_until FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1490").muted_until) > Date.now());
    assert.equal(db.get("SELECT effects_applied FROM verification_attempts WHERE status = 'failed'").effects_applied, 1);
    assert.equal(calls.some((call) => call.method === "createForumTopic" || call.method === "copyMessage"), false);
  });
});

test("restriction duration parser enforces the 5 minute to 30 day boundary", () => {
  assert.equal(parseRestrictionDuration("5m"), 5 * 60_000);
  assert.equal(parseRestrictionDuration("1h"), 60 * 60_000);
  assert.equal(parseRestrictionDuration("30d"), 30 * 86_400_000);
  assert.equal(parseRestrictionDuration("4m"), null);
  assert.equal(parseRestrictionDuration("31d"), null);
  assert.equal(parseRestrictionDuration("custom"), null);
});

test("a new Topic receives one operator panel and panel command edits it in place", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1500, 1500)), env)).status, 200);
    const conversation = db.get("SELECT thread_id, panel_message_id FROM conversations WHERE bot_id = 'folder-links' AND user_id = 1500");
    assert.ok(conversation.panel_message_id);
    const panels = calls.filter((call) => call.method === "sendMessage" && call.body.chat_id === -1001234567890 && call.body.reply_markup?.inline_keyboard?.flat().some((button) => button.callback_data === "um:tp:info"));
    assert.equal(panels.length, 1);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1501, conversation.thread_id, "/panel")), env)).status, 200);
    assert.equal(calls.some((call) => call.method === "editMessageText" && call.body.message_id === conversation.panel_message_id), true);
    assert.equal(db.get("SELECT panel_message_id FROM conversations WHERE bot_id = 'folder-links' AND user_id = 1500").panel_message_id, conversation.panel_message_id);
  });
});

test("users center stays with the preferred General owner when webhook deliveries overlap", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.GENERAL_OWNER_GRACE_MS = "40";
    seedConversation(db, "folder-links", 1510, 70);
    seedConversation(db, "image-compress", 1510, 71);
    seedConversation(db, "folder-links", 1511, 72);
    const shared = groupUpdate(1510, 1, "/users");
    const secondary = worker.fetch(webhookRequest("image-compress", "secret-b", shared), env);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", shared), env)).status, 200);
    assert.equal((await secondary).status, 200);
    assert.equal(calls.some((call) => call.token === "token-b" && call.method === "sendMessage" && /Пользователи|Users/.test(call.body.text)), false);
    const screen = calls.find((call) => call.token === "token-a" && call.method === "sendMessage" && /Пользователи|Users/.test(call.body.text));
    assert.ok(screen);
    assert.equal(screen.body.reply_markup.inline_keyboard.flat().some((button) => String(button.callback_data).startsWith("um:g:list:")), true);
  });
});

test("General management falls back after the owner grace window when the preferred webhook is unavailable", async () => {
  await withFixture(null, async ({ env, calls }) => {
    env.GENERAL_OWNER_GRACE_MS = "20";
    const response = await worker.fetch(webhookRequest("image-compress", "secret-b", groupUpdate(15_130, 1, "/users")), env);
    assert.equal(response.status, 200);
    assert.equal(calls.some((call) => call.token === "token-b" && call.method === "sendMessage" && /Пользователи|Users/.test(call.body.text)), true);
  });
});

test("pending General flow is rebound to the new D1 owner and can be cancelled", async () => {
  await withFixture(null, async ({ env, db }) => {
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(15_140, 1, "/users")), env)).status, 200);
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 60_000).toISOString();
    db.run("INSERT INTO operator_pending_actions (operator_id, operator_name, management_bot_id, target_bot_id, user_id, action, stage, duration_seconds, reason, chat_id, thread_id, flow_nonce, expected_state_key, created_at, expires_at) VALUES (7, 'Operator', 'folder-links', 'folder-links', 1510, 'ban', 'confirm', NULL, NULL, -1001234567890, NULL, 'failover-flow', NULL, ?, ?)", now, expires);
    assert.equal(db.run("UPDATE bots SET enabled = 0 WHERE id = 'folder-links'").changes, 1);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", groupUpdate(15_141, 1, "/cancel")), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM operator_pending_actions WHERE operator_id = 7").count, 0);
  });
});

test("manual restriction requires confirmation, drops attempts silently, and unrestrict preserves auto mute", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1520, 80);
    const reopenStartedAt = new Date().toISOString();
    db.run("INSERT INTO conversation_reopen_effects (bot_id,user_id,old_thread_id,created_at) VALUES ('folder-links',1520,80,?)", reopenStartedAt);
    db.run("INSERT INTO reopen_business_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES ('folder-links',1520,1519,1520,15190,?)", reopenStartedAt);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1520, 80, "/restrict 1h")), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM user_abuse_state WHERE user_id = 1520").count, 0);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1521, 80, pendingActionCallback(db, "confirm"))), env)).status, 200);
    const restricted = db.get("SELECT manual_restricted_until, manual_restriction_notice_at FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1520");
    assert.ok(Date.parse(restricted.manual_restricted_until) > Date.now());
    assert.ok(restricted.manual_restriction_notice_at);
    const cancelled = db.get("SELECT completed_at, cancellation_reason FROM conversation_reopen_effects WHERE bot_id='folder-links' AND user_id=1520");
    assert.ok(cancelled.completed_at);
    assert.equal(cancelled.cancellation_reason, "manual_restriction");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM reopen_business_messages WHERE bot_id='folder-links' AND user_id=1520").count, 0);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && call.body.chat_id === 1520 && /ограничена до|restricted until/.test(call.body.text)).length, 1);
    const beforeAttempt = calls.length;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1522, 1520)), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1523, 1520)), env)).status, 200);
    assert.equal(calls.length, beforeAttempt);
    assert.equal(db.get("SELECT manual_restricted_until FROM user_abuse_state WHERE user_id = 1520").manual_restricted_until, restricted.manual_restricted_until);
    const automaticMute = new Date(Date.now() + 30 * 60_000).toISOString();
    db.run("UPDATE user_abuse_state SET muted_until = ? WHERE bot_id = 'folder-links' AND user_id = 1520", automaticMute);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1524, 80, "/unrestrict")), env)).status, 200);
    const cleared = db.get("SELECT manual_restricted_until, muted_until FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1520");
    assert.equal(cleared.manual_restricted_until, null);
    assert.equal(cleared.muted_until, automaticMute);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM operator_audit WHERE user_id = 1520 AND action IN ('manual_restrict', 'manual_unrestrict')").count, 2);
  });
});

test("ban reason input is not forwarded and stale or unauthorized confirmations cannot repeat the action", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1530, 81);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1530, 81, "/ban")), env)).status, 200);
    assert.equal(db.get("SELECT stage FROM operator_pending_actions WHERE operator_id = 7").stage, "reason");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1531, 81, "coordinated spam campaign")), env)).status, 200);
    assert.equal(calls.some((call) => call.method === "copyMessage" && call.body.chat_id === 1530), false);
    assert.equal(db.get("SELECT stage FROM operator_pending_actions WHERE operator_id = 7").stage, "confirm");
    const confirmCallback = pendingActionCallback(db, "confirm");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1532, 81, confirmCallback, 8)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM banned_users WHERE user_id = 1530").count, 0);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1533, 81, confirmCallback)), env)).status, 200);
    const banned = db.get("SELECT reason, notified_at FROM banned_users WHERE bot_id = 'folder-links' AND user_id = 1530");
    assert.equal(banned.reason, "coordinated spam campaign");
    assert.ok(banned.notified_at);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1534, 81, confirmCallback)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM operator_audit WHERE user_id = 1530 AND action = 'manual_ban'").count, 1);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && call.body.chat_id === 1530).length, 1);
  });
});

test("a direct General action with multiple profiles requires an explicit service choice", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedConversation(db, "folder-links", 1540, 82);
    seedConversation(db, "image-compress", 1540, 83);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1540, 1, "/trust 1540")), env)).status, 200);
    assert.equal(db.get("SELECT stage FROM operator_pending_actions WHERE operator_id = 7").stage, "service");
    assert.equal(db.get("SELECT COUNT(*) AS count FROM user_abuse_state WHERE user_id = 1540 AND manual_trust = 1").count, 0);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1541, 1, pendingActionCallback(db, "service", managementBotKey(registryValue, "image-compress")))), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links","secret-a",callbackUpdate(91540,1,pendingActionCallback(db))),env)).status,200);
    assert.equal(db.get("SELECT manual_trust FROM user_abuse_state WHERE bot_id = 'image-compress' AND user_id = 1540").manual_trust, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1540 AND manual_trust = 1").count, 0);
    assert.equal(db.get("SELECT bot_id FROM operator_audit WHERE user_id = 1540 AND action = 'manual_trust'").bot_id, "image-compress");
  });
});

test("attack AUTO is explicit and audit exposes important operator actions", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1550, 1, "/attack on")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1551, 1, "/attack auto")), env)).status, 200);
    const state = db.get("SELECT mode, manual_override FROM service_attack_state WHERE bot_id = 'folder-links'");
    assert.equal(state.mode, "normal");
    assert.equal(state.manual_override, null);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM operator_audit WHERE bot_id = 'folder-links' AND action IN ('attack_control_on', 'attack_control_auto')").count, 2);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1552, 1, "/audit")), env)).status, 200);
    const audit = calls.at(-1);
    assert.ok(["sendMessage","editMessageText"].includes(audit.method));
    assert.match(audit.body.text, /Protection returned to AUTO/);
    const details=audit.body.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.endsWith(':d'));assert.ok(details);
    await worker.fetch(webhookRequest('folder-links','secret-a',callbackUpdate(1553,1,details.callback_data)),env);
    assert.match(calls.at(-1).body.text,/attack_control_auto/);
  });
});

test("management state and audit roll back together and confirmation can be retried", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedConversation(db, "folder-links", 1560, 84);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1560, 84, "/restrict 1h")), env)).status, 200);
    db.failOnce("INSERT INTO operator_audit");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1561, 84, pendingActionCallback(db, "confirm"))), env)).status, 500);
    assert.equal(db.get("SELECT manual_restricted_until FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1560").manual_restricted_until, null);
    assert.equal(db.get("SELECT stage FROM operator_pending_actions WHERE operator_id = 7").stage, "confirm");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1562, 84, pendingActionCallback(db, "confirm"))), env)).status, 200);
    assert.ok(db.get("SELECT manual_restricted_until FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1560").manual_restricted_until);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM operator_audit WHERE user_id = 1560 AND action = 'manual_restrict'").count, 1);
  });
});

test("Cron retries a failed one-time restriction notification without changing its deadline", async () => {
  let failNotice = true;
  await withFixture((call) => {
    if (call.method === "sendMessage" && call.body.chat_id === 1570 && failNotice) {
      failNotice = false;
      return { ok: false, httpStatus: 429, error_code: 429, description: "Temporary Telegram outage" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1570, 85);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1570, 85, "/restrict 15m")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1571, 85, pendingActionCallback(db, "confirm"))), env)).status, 200);
    const before = db.get("SELECT manual_restricted_until, manual_restriction_notice_at FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1570");
    assert.equal(before.manual_restriction_notice_at, null);
    const waits = [];
    await runRecoveryCycle({}, env, { waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    const after = db.get("SELECT manual_restricted_until, manual_restriction_notice_at FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 1570");
    assert.equal(after.manual_restricted_until, before.manual_restricted_until);
    assert.ok(after.manual_restriction_notice_at);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && call.body.chat_id === 1570).length, 2);
  });
});

test("retryable forward failure never falls through to copyMessage in the same webhook", async () => {
  await withFixture((call) => {
    if (call.method === "forwardMessage") return { ok: false, httpStatus: 429, error_code: 429, description: "Temporary Telegram outage" };
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1580, 85);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1580, 1580)), env)).status, 500);
    assert.equal(calls.filter((call) => call.method === "forwardMessage").length, 1);
    assert.equal(calls.filter((call) => call.method === "copyMessage").length, 0);
  });
});

test("a failed processed-update completion marker is retried without replaying delivery", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1581, 86);
    db.failOnce("UPDATE processed_updates SET state = 'completed'");
    const update = privateUpdate(1581, 1581);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(db.get("SELECT state FROM processed_updates WHERE bot_id = 'folder-links' AND update_id = 1581").state, "completed");
    const deliveries = calls.filter((call) => call.method === "forwardMessage" || call.method === "copyMessage").length;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "forwardMessage" || call.method === "copyMessage").length, deliveries);
  });
});

test("an old confirmation button cannot approve a newer pending action", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedConversation(db, "folder-links", 1582, 87);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1582, 87, "/ban first reason")), env)).status, 200);
    const staleConfirm = pendingActionCallback(db, "confirm");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1583, 87, "/restrict 1h")), env)).status, 200);
    assert.notEqual(pendingActionCallback(db, "confirm"), staleConfirm);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1584, 87, staleConfirm)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM banned_users WHERE user_id = 1582").count, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM user_abuse_state WHERE user_id = 1582 AND manual_restricted_until IS NOT NULL").count, 0);
  });
});

test("deleted closed Topic is recreated when an operator opens it", async () => {
  await withFixture((call) => {
    if (call.method === "reopenForumTopic") return { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
    if (call.method === "createForumTopic") return { ok: true, result: { message_thread_id: 188 } };
    return null;
  }, async ({ env, db }) => {
    seedConversation(db, "folder-links", 1585, 88);
    seedCompletedProvision(db, "folder-links", 1585, 88);
    db.run("UPDATE conversations SET status = 'closed' WHERE bot_id = 'folder-links' AND user_id = 1585");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1585, 88, "/open")), env)).status, 200);
    const conversation = db.get("SELECT thread_id, status FROM conversations WHERE bot_id = 'folder-links' AND user_id = 1585");
    assert.equal(conversation.thread_id, 188);
    assert.equal(conversation.status, "open");
  });
});

test("Telegram Topic lifecycle state sync does not require support-operator authorization", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1586, 89);
    const closed = groupUpdate(1586, 89, "ignored", 8);
    delete closed.message.text;
    closed.message.forum_topic_closed = {};
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", closed), env)).status, 200);
    assert.equal(db.get("SELECT status FROM conversations WHERE bot_id = 'folder-links' AND user_id = 1586").status, "closed");
    assert.equal(calls.some((call) => call.method === "sendMessage" && /not allowed/.test(call.body.text)), false);
  });
});

test("registry rejects zero for fields that cannot actually use zero", () => {
  assert.throws(() => parseBotRegistry(JSON.stringify([{ ...registryValue[0], warning_cooldown_seconds: 0 }])), /positive integer/);
  assert.throws(() => parseBotRegistry(JSON.stringify([{ ...registryValue[0], pending_message_limit: 0 }])), /positive integer/);
  assert.equal(parseBotRegistry(JSON.stringify([{ ...registryValue[0], risk_turnstile_threshold: 0 }]))[0].riskTurnstileThreshold, 0);
});

test("bidirectional reactions use the owning mapping, replace/remove, and stay bot-isolated", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "image-compress", 1600, 86);
    db.run("INSERT INTO message_mappings (bot_id, user_id, thread_id, user_message_id, support_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", "image-compress", 1600, 86, 200, 300, new Date().toISOString());
    db.run("INSERT INTO reaction_settings (bot_id, enabled, capability_verified, updated_at, verified_at) VALUES ('image-compress', 1, 1, ?, ?)", new Date().toISOString(), new Date().toISOString());
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", reactionUpdate(1601, 1600, 200, 1600, [{ type: "emoji", emoji: "👍" }])), env)).status, 200);
    let synced = calls.find((call) => call.method === "setMessageReaction");
    assert.equal(synced.token, "token-b");
    assert.equal(synced.body.chat_id, -1001234567890);
    assert.deepEqual(synced.body.reaction, [{ type: "emoji", emoji: "👍" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1602, -1001234567890, 300, 7, [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji", custom_emoji_id: "x" }, { type: "emoji", emoji: "👀" }], [{ type: "emoji", emoji: "👍" }])), env)).status, 200);
    synced = calls.filter((call) => call.method === "setMessageReaction").at(-1);
    assert.equal(synced.token, "token-b");
    assert.equal(synced.body.chat_id, 1600);
    assert.deepEqual(synced.body.reaction, [{ type: "emoji", emoji: "👀" }]);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", reactionUpdate(1603, 1600, 200, 1600, [])), env)).status, 200);
    synced = calls.filter((call) => call.method === "setMessageReaction").at(-1);
    assert.deepEqual(synced.body.reaction, []);
    assert.equal(calls.filter((call) => call.method === "setMessageReaction").length, 3);
  });
});

test("reactions are disabled or unverified by default, unsupported reactions are ignored, and General switch audits", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1610, 87);
    db.run("INSERT INTO message_mappings (bot_id, user_id, thread_id, user_message_id, support_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", "folder-links", 1610, 87, 210, 310, new Date().toISOString());
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1611, 1610, 210, 1610, [{ type: "emoji", emoji: "👍" }])), env)).status, 200);
    assert.equal(calls.some((call) => call.method === "setMessageReaction"), false);
    db.run("INSERT INTO reaction_settings (bot_id, enabled, capability_verified, updated_at) VALUES ('folder-links', 0, 1, ?)", new Date().toISOString());
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1612, 1, "/reactions on support-ru")), env)).status, 200);
    assert.equal(db.get("SELECT enabled FROM reaction_settings WHERE bot_id = 'folder-links'").enabled, 0);
    assert.match(calls.at(-1).body.text, /Unknown support bot|Неизвестный/);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1613, 1, "/reactions on folder-links")), env)).status, 200);
    assert.equal(db.get("SELECT enabled FROM reaction_settings WHERE bot_id = 'folder-links'").enabled, 1);
    assert.equal(db.get("SELECT action FROM operator_audit WHERE action = 'reactions_enable'").action, "reactions_enable");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1614, 1610, 210, 1610, [{ type: "custom_emoji", custom_emoji_id: "x" }])), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1615, 1610, 210, 1610, [{ type: "paid" }])), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1616, 1610, 210, 1610, [{ type: "emoji", emoji: "✅" }])), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "setMessageReaction").length, 0);
  });
});

test("replacing a mirrored reaction with an unsupported one clears the stale mirror in both directions", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1617, 91);
    db.run("INSERT INTO message_mappings (bot_id, user_id, thread_id, user_message_id, support_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", "folder-links", 1617, 91, 211, 311, new Date().toISOString());
    db.run("INSERT INTO reaction_settings (bot_id, enabled, capability_verified, updated_at, verified_at) VALUES ('folder-links', 1, 1, ?, ?)", new Date().toISOString(), new Date().toISOString());

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1617, 1617, 211, 1617, [{ type: "emoji", emoji: "👍" }])), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1618, 1617, 211, 1617, [{ type: "paid" }], [{ type: "emoji", emoji: "👍" }])), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1619, -1001234567890, 311, 7, [{ type: "emoji", emoji: "👀" }])), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1620, -1001234567890, 311, 7, [{ type: "custom_emoji", custom_emoji_id: "x" }], [{ type: "emoji", emoji: "👀" }])), env)).status, 200);

    const mirrored = calls.filter((call) => call.method === "setMessageReaction");
    assert.equal(mirrored.length, 4);
    assert.deepEqual(mirrored.map((call) => call.body.reaction), [[{ type: "emoji", emoji: "👍" }], [], [{ type: "emoji", emoji: "👀" }], []]);
    assert.deepEqual(mirrored.map((call) => call.body.chat_id), [-1001234567890, -1001234567890, 1617, 1617]);
  });
});

test("reaction ingress filters structural noise before D1 and fails safely when operator state is unavailable", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const forbiddenDb = new Proxy({}, { get() { throw new Error("D1 must not be touched"); } });
    env.SUPPORT_DB = forbiddenDb;
    const nonOwner = reactionUpdate(1620, -1001234567890, 320, 7, [{ type: "emoji", emoji: "👍" }]);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", nonOwner), env)).status, 500);
    const botOrigin = reactionUpdate(1621, -1001234567890, 320, 9001, [{ type: "emoji", emoji: "👍" }]);
    botOrigin.message_reaction.user.is_bot = true;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", botOrigin), env)).status, 200);
    const unauthorized = reactionUpdate(1622, -1001234567890, 320, 8, [{ type: "emoji", emoji: "👍" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", unauthorized), env)).status, 500);
    env.SUPPORT_DB = db;
    let limiterChecks = 0;
    env.REACTION_LIMITER = { limit: async () => { limiterChecks += 1; return { success: false }; } };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1623, 1623, 321, 1623, [{ type: "emoji", emoji: "👍" }])), env)).status, 200);
    assert.equal(limiterChecks, 1);
    assert.equal(calls.length, 0);
  });
});

test("reaction mirroring ignores unauthorized operators, deduplicates update ids, and does not audit reactions", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1630, 88);
    db.run("INSERT INTO message_mappings (bot_id, user_id, thread_id, user_message_id, support_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", "folder-links", 1630, 88, 220, 320, new Date().toISOString());
    db.run("INSERT INTO reaction_settings (bot_id, enabled, capability_verified, updated_at, verified_at) VALUES ('folder-links', 1, 1, ?, ?)", new Date().toISOString(), new Date().toISOString());

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1631, -1001234567890, 320, 8, [{ type: "emoji", emoji: "👍" }])), env)).status, 200);
    assert.equal(calls.some((call) => call.method === "setMessageReaction"), false);

    const valid = reactionUpdate(1632, -1001234567890, 320, 7, [{ type: "emoji", emoji: "👀" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", valid), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", valid), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "setMessageReaction").length, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM operator_audit WHERE action LIKE 'reaction%' OR action LIKE 'reactions_%'").count, 0);
  });
});

test("reaction limiter and Telegram failures are soft and never block ordinary messages", async () => {
  await withFixture((call) => {
    if (call.method === "setMessageReaction") return { ok: false, httpStatus: 503, error_code: 503, description: "Temporary reaction outage" };
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1640, 89);
    db.run("INSERT INTO message_mappings (bot_id, user_id, thread_id, user_message_id, support_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", "folder-links", 1640, 89, 230, 330, new Date().toISOString());
    db.run("INSERT INTO reaction_settings (bot_id, enabled, capability_verified, updated_at, verified_at) VALUES ('folder-links', 1, 1, ?, ?)", new Date().toISOString(), new Date().toISOString());

    db.failOnce("FROM message_mappings m");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1641, 1640, 230, 1640, [{ type: "emoji", emoji: "👀" }])), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "setMessageReaction").length, 0);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1642, 1640, 230, 1640, [{ type: "emoji", emoji: "👀" }])), env)).status, 500);
    env.REACTION_LIMITER = { limit: async () => ({ success: false }) };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", reactionUpdate(1643, 1640, 230, 1640, [])), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(1644, 1640, 231)), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "setMessageReaction").length, 1);
    assert.equal(calls.some((call) => call.method === "forwardMessage" && call.body.message_id === 231), true);
  });
});

test("reaction switch updates webhook subscriptions and rolls them back with D1 state", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    db.run("INSERT INTO reaction_settings (bot_id, enabled, capability_verified, updated_at, verified_at) VALUES ('folder-links', 0, 1, ?, ?)", new Date().toISOString(), new Date().toISOString());
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1648, 1, `um:r:set:${managementBotKey(registryValue, "folder-links")}:on`, 8)), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1649, 1, "um:r:set:a:on")), env)).status, 200);
    assert.equal(db.get("SELECT enabled FROM reaction_settings WHERE bot_id = 'folder-links'").enabled, 0);
    db.failOnce("INSERT INTO operator_audit");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1650, 1, "/reactions on folder-links")), env)).status, 200);
    assert.equal(db.get("SELECT enabled FROM reaction_settings WHERE bot_id = 'folder-links'").enabled, 0);
    let webhookCalls = calls.filter((call) => call.method === "setWebhook");
    assert.equal(webhookCalls.length, 2);
    assert.deepEqual(webhookCalls[0].body.allowed_updates, ["message", "callback_query", "message_reaction", "managed_bot"]);
    assert.deepEqual(webhookCalls[1].body.allowed_updates, ["message", "callback_query", "managed_bot"]);
    assert.match(calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1).body.text, /not changed|не изменено/i);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1651, 1, "/reactions on folder-links")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1652, 1, "/reactions off folder-links")), env)).status, 200);
    assert.equal(db.get("SELECT enabled FROM reaction_settings WHERE bot_id = 'folder-links'").enabled, 0);
    webhookCalls = calls.filter((call) => call.method === "setWebhook");
    assert.deepEqual(webhookCalls.at(-1).body.allowed_updates, ["message", "callback_query", "managed_bot"]);
    const audit = db.all("SELECT action, reason, result FROM operator_audit WHERE action LIKE 'reactions_%' ORDER BY id");
    assert.deepEqual(audit.map((row) => row.action), ["reactions_enable", "reactions_disable"]);
    assert.deepEqual(audit.map((row) => row.reason), ["off → on", "on → off"]);
    assert.deepEqual(audit.map((row) => row.result), ["success", "success"]);
  });
});

test("command-owner webhook stays subscribed while another service has reactions enabled", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const timestamp = new Date().toISOString();
    db.run("INSERT INTO reaction_settings (bot_id, enabled, capability_verified, updated_at, verified_at) VALUES ('folder-links', 0, 1, ?, ?)", timestamp, timestamp);
    db.run("INSERT INTO reaction_settings (bot_id, enabled, capability_verified, updated_at, verified_at) VALUES ('image-compress', 1, 1, ?, ?)", timestamp, timestamp);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1660, 1, "/reactions off folder-links")), env)).status, 200);
    let webhooks = calls.filter((call) => call.method === "setWebhook");
    assert.equal(webhooks.length, 1);
    assert.equal(webhooks[0].token, "token-a");
    assert.deepEqual(webhooks[0].body.allowed_updates, ["message", "callback_query", "message_reaction", "managed_bot"]);

    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1661, 1, "/reactions off image-compress")), env)).status, 200);
    webhooks = calls.filter((call) => call.method === "setWebhook");
    assert.deepEqual(webhooks.slice(-2).map((call) => call.token).sort(), ["token-a", "token-b"]);
    assert.equal(webhooks.slice(-2).every((call) => !call.body.allowed_updates.includes("message_reaction")), true);
  });
});

test("reaction ordering is serialized and fenced by event date plus update id", async () => {
  const started = deferred();
  const release = deferred();
  let blockFirstReaction = true;
  await withFixture(async (call) => {
    if (call.method === "setMessageReaction" && blockFirstReaction) {
      blockFirstReaction = false;
      started.resolve();
      await release.promise;
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1670, 90);
    db.run("INSERT INTO message_mappings (bot_id, user_id, thread_id, user_message_id, support_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", "folder-links", 1670, 90, 240, 340, new Date().toISOString());
    db.run("INSERT INTO reaction_settings (bot_id, enabled, capability_verified, updated_at, verified_at) VALUES ('folder-links', 1, 1, ?, ?)", new Date().toISOString(), new Date().toISOString());
    const older = reactionUpdate(1671, 1670, 240, 1670, [{ type: "emoji", emoji: "👍" }]);
    older.message_reaction.date = 1_000;
    const newer = reactionUpdate(1672, 1670, 240, 1670, [{ type: "emoji", emoji: "❤" }]);
    newer.message_reaction.date = 1_001;

    const first = worker.fetch(webhookRequest("folder-links", "secret-a", older), env);
    await started.promise;
    assert.equal(db.get("SELECT COUNT(*) AS count FROM reaction_sync_locks").count, 1);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", newer), env)).status, 500);
    release.resolve();
    assert.equal((await first).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", newer), env)).status, 200);
    assert.deepEqual(calls.filter((call) => call.method === "setMessageReaction").map((call) => call.body.reaction[0].emoji), ["👍", "❤"]);

    const afterQuietWeek = reactionUpdate(5, 1670, 240, 1670, [{ type: "emoji", emoji: "👎" }]);
    afterQuietWeek.message_reaction.date = 2_000;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", afterQuietWeek), env)).status, 200);
    const staleHighId = reactionUpdate(9_999, 1670, 240, 1670, [{ type: "emoji", emoji: "👀" }]);
    staleHighId.message_reaction.date = 1_500;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", staleHighId), env)).status, 200);
    assert.deepEqual(calls.filter((call) => call.method === "setMessageReaction").map((call) => call.body.reaction[0].emoji), ["👍", "❤", "👎"]);
    const marker = db.get("SELECT user_reaction_date, user_reaction_update_id FROM message_mappings WHERE bot_id = 'folder-links' AND user_id = 1670");
    assert.equal(marker.user_reaction_date, 2_000);
    assert.equal(marker.user_reaction_update_id, 5);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM reaction_sync_locks").count, 0);
  });
});

test("concurrent cross-service reaction settings cannot interleave webhook and D1 state", async () => {
  const started = deferred();
  const release = deferred();
  let blockFirstWebhook = true;
  await withFixture(async (call) => {
    if (call.method === "setWebhook" && blockFirstWebhook) {
      blockFirstWebhook = false;
      started.resolve();
      await release.promise;
    }
    return null;
  }, async ({ env, db, calls }) => {
    const timestamp = new Date().toISOString();
    db.run("INSERT INTO reaction_settings (bot_id, enabled, capability_verified, updated_at, verified_at) VALUES ('folder-links', 0, 1, ?, ?)", timestamp, timestamp);
    db.run("INSERT INTO reaction_settings (bot_id, enabled, capability_verified, updated_at, verified_at) VALUES ('image-compress', 1, 1, ?, ?)", timestamp, timestamp);
    const enabling = worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1680, 1, "/reactions on folder-links")), env);
    await started.promise;
    assert.equal(db.get("SELECT COUNT(*) AS count FROM reaction_settings_lock").count, 1);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1681, 1, "/reactions off image-compress")), env)).status, 500);
    assert.equal(calls.filter((call) => call.method === "setWebhook").length, 1);
    assert.equal(db.get("SELECT enabled FROM reaction_settings WHERE bot_id = 'folder-links'").enabled, 0);
    assert.equal(db.get("SELECT enabled FROM reaction_settings WHERE bot_id = 'image-compress'").enabled, 1);
    release.resolve();
    assert.equal((await enabling).status, 200);
    assert.equal(db.get("SELECT enabled FROM reaction_settings WHERE bot_id = 'folder-links'").enabled, 1);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1681, 1, "/reactions off image-compress")), env)).status, 200);
    assert.equal(db.get("SELECT enabled FROM reaction_settings WHERE bot_id = 'folder-links'").enabled, 1);
    assert.equal(db.get("SELECT enabled FROM reaction_settings WHERE bot_id = 'image-compress'").enabled, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM reaction_settings_lock").count, 0);
    assert.deepEqual(db.all("SELECT action FROM operator_audit WHERE action LIKE 'reactions_%' ORDER BY id").map((row) => row.action), ["reactions_enable", "reactions_disable"]);
  });
});


test("hidden text_link URLs participate in new-user risk", async () => {
  await withFixture(null, async ({ env, db }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], risk_turnstile_threshold: 1 }]);
    const u = privateUpdate(1800, 1800); u.message.text = "click here"; u.message.entities = [{ type: "text_link", offset: 0, length: 10, url: "https://spam.example/x" }];
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", u), env)).status, 200);
    assert.equal(db.get("SELECT verification_required FROM user_abuse_state WHERE user_id = 1800").verification_required, 1);
  });
});

test("stale forum lifecycle update cannot overwrite a newer state", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedConversation(db, "folder-links", 1801, 98);
    const opened = groupUpdate(1802, 98, "", 999); opened.message.forum_topic_reopened = {}; delete opened.message.text;
    const closed = groupUpdate(1801, 98, "", 999); closed.message.forum_topic_closed = {}; delete closed.message.text;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", opened), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", closed), env)).status, 200);
    const row=db.get("SELECT status, topic_state_update_id FROM conversations WHERE user_id = 1801"); assert.equal(row.status,"open"); assert.equal(row.topic_state_update_id,1802);
  });
});

test("cron releases queued messages after an automatic mute expires", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db,"folder-links",1803,99); const now=new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,pending_release_required,muted_until,created_at,updated_at) VALUES ('folder-links',1803,1,?,?,?)", new Date(Date.now()-1000).toISOString(),now,now);
    db.run("INSERT INTO pending_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES ('folder-links',1803,1803,1803,28003,?)",now);
    await runRecoveryCycle({},env,null);
    assert.equal(db.get("SELECT delivered_at FROM pending_messages WHERE user_id=1803").delivered_at!==null,true);
    assert.equal(calls.some((c)=>c.method==="copyMessage"&&c.body.message_id===28003),true);
  });
});

test("verified pending album is restored as one sendMediaGroup operation", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY="site-key"; env.TURNSTILE_SECRET_KEY="secret-key"; env.BOT_REGISTRY=JSON.stringify([{...registryValue[0],verification_mode:"always"}]);
    for (const [u,m,f] of [[1804,28004,"a"],[1805,28005,"b"]]) { const x=privateUpdate(u,1804,m); x.message.media_group_id="g"; x.message.photo=[{file_id:f}]; delete x.message.text; assert.equal((await worker.fetch(webhookRequest("folder-links","secret-a",x),env)).status,200); }
    const token=verificationToken(calls); const v=new Request(`https://support.example.workers.dev/verify/${token}`,{method:"POST",headers:{"CF-Connecting-IP":"203.0.113.60","content-type":"application/x-www-form-urlencoded"},body:"cf-turnstile-response=proof"});
    assert.equal((await worker.fetch(v,env)).status,200); const c=calls.filter((x)=>x.method==="sendMediaGroup"); assert.equal(c.length,1); assert.deepEqual(c[0].body.media.map((item)=>item.media),["a","b"]); assert.equal(calls.some((x)=>x.method==="copyMessages"),false);
  });
});


test("pending album recovery sorts Telegram message ids and never uses partial copyMessages", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1900, 110);
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,pending_release_required,created_at,updated_at) VALUES ('folder-links',1900,1,?,?)", now, now);
    db.run("INSERT INTO pending_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,media_group_id,media_type,file_id,created_at) VALUES ('folder-links',1900,1901,1900,30002,'g','photo','b',?)", now);
    db.run("INSERT INTO pending_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,media_group_id,media_type,file_id,created_at) VALUES ('folder-links',1900,1900,1900,30001,'g','photo','a',?)", now);
    await runRecoveryCycle({}, env, null);
    const album = calls.find((call) => call.method === "sendMediaGroup" && call.body.chat_id === -1001234567890);
    assert.ok(album);
    assert.deepEqual(album.body.media.map((item) => item.media), ["a", "b"]);
    assert.equal(calls.some((call) => call.method === "copyMessages"), false);
  });
});

test("confirmed ban revokes a queued user album before cron recovery", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1901, 111);
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,created_at,updated_at) VALUES ('folder-links',1901,?,?)", now, now);
    db.run("INSERT INTO media_groups (bot_id,direction,media_group_id,source_chat_id,target_chat_id,thread_id,user_id,last_received_at,version,claimed_at,claimed_version,created_at) VALUES ('folder-links','user_to_support','queued',1901,-1001234567890,111,1901,?,1,NULL,NULL,?)", Date.now()-10000, now);
    db.run("INSERT INTO media_group_items (bot_id,direction,media_group_id,source_chat_id,message_id,media_type,file_id,caption,received_at) VALUES ('folder-links','user_to_support','queued',1901,30011,'photo','x','',?)", Date.now()-10000);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1902, 111, "/ban abusive user")), env)).status, 200);
    const confirm = pendingActionCallback(db);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1903, 111, confirm)), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM media_groups WHERE user_id=1901").count, 0);
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.some((call) => call.method === "sendMediaGroup" && call.body.media?.some((item) => item.media === "x")), false);
  });
});

test("an old Unblock button cannot remove a newer ban", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 1902, 112);
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,created_at,updated_at) VALUES ('folder-links',1902,?,?)", now, now);
    db.run("INSERT INTO banned_users (bot_id,user_id,reason,banned_at) VALUES ('folder-links',1902,'first',?)", now);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1904, 112, "/panel")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(19040, 112, "um:tp:manage")), env)).status, 200);
    const panel = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1);
    const oldUnban = panel.body.reply_markup.inline_keyboard.flat().find((button) => String(button.callback_data || "").includes(":unban:"))?.callback_data;
    assert.ok(oldUnban);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1905, 112, "/unban")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(1906, 112, "/ban second ban")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1907, 112, pendingActionCallback(db))), env)).status, 200);
    assert.ok(db.get("SELECT banned_at FROM banned_users WHERE bot_id='folder-links' AND user_id=1902"));
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(1908, 112, oldUnban)), env)).status, 200);
    assert.ok(db.get("SELECT banned_at FROM banned_users WHERE bot_id='folder-links' AND user_id=1902"));
  });
});

test("permanent ban notification failures do not starve later cron notifications", async () => {
  await withFixture(async (call) => {
    if (call.method === "sendMessage" && Number(call.body.chat_id) >= 2000 && Number(call.body.chat_id) < 2050) {
      return { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" };
    }
    return null;
  }, async ({ env, db }) => {
    const base = Date.now() - 100000;
    for (let i = 0; i < 51; i++) {
      db.run("INSERT INTO banned_users (bot_id,user_id,reason,banned_at) VALUES ('folder-links',?,'test',?)", 2000+i, new Date(base+i).toISOString());
    }
    await runRecoveryCycle({}, env, null);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM banned_users WHERE user_id>=2000 AND user_id<2050 AND notified_at IS NOT NULL").count, 50);
    await runRecoveryCycle({}, env, null);
    assert.ok(db.get("SELECT notified_at FROM banned_users WHERE user_id=2050").notified_at);
  });
});

test("message-is-not-modified does not create a duplicate topic panel", async () => {
  await withFixture(async (call) => {
    if (call.method === "editMessageText") return { ok: false, error_code: 400, description: "Bad Request: message is not modified" };
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2051, 113);
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,created_at,updated_at) VALUES ('folder-links',2051,?,?)", now, now);
    db.run("UPDATE conversations SET panel_message_id=777 WHERE user_id=2051");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(2052, 113, "/panel")), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "editMessageText").length, 1);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && call.body.message_thread_id === 113).length, 0);
  });
});

test("unban state mutation rolls back when audit write fails", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedConversation(db, "folder-links", 2052, 114);
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,created_at,updated_at) VALUES ('folder-links',2052,?,?)", now, now);
    db.run("INSERT INTO banned_users (bot_id,user_id,reason,banned_at) VALUES ('folder-links',2052,'test',?)", now);
    db.failOnce("INSERT INTO operator_audit");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(2053, 114, "/unban")), env)).status, 500);
    assert.ok(db.get("SELECT banned_at FROM banned_users WHERE bot_id='folder-links' AND user_id=2052"));
  });
});


test("abuse normalization removes default-ignorable Unicode and album metadata survives reconstruction", () => {
  assert.equal(normalizeForAbuseText("ca\u200Bsino"), "casino");
  assert.equal(normalizeForAbuseText("SP\uFEFFAM"), "spam");
  const entities = [{ type: "bold", offset: 0, length: 6 }];
  const extracted = extractAlbumMedia({ photo: [{ file_id: "large" }], caption: "hidden", caption_entities: entities, has_media_spoiler: true });
  assert.equal(extracted.hasSpoiler, true);
  assert.deepEqual(extracted.captionEntities, entities);
  assert.deepEqual(storedAlbumInputMedia({ media_type: "photo", file_id: "large", caption: "hidden", caption_entities_json: JSON.stringify(entities), has_spoiler: 1 }), {
    type: "photo", media: "large", caption: "hidden", caption_entities: entities, has_spoiler: true,
  });
});

test("a delivered live album is not replayed after cleanup D1 failure and preserves spoiler metadata", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2100, 121);
    const old = Date.now() - 120_000;
    db.run("INSERT INTO media_groups (bot_id, direction, media_group_id, source_chat_id, target_chat_id, thread_id, user_id, last_received_at, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)", "folder-links", "user_to_support", "post-send-fence", 2100, -1001234567890, 121, 2100, old, new Date(old).toISOString());
    const entities = JSON.stringify([{ type: "bold", offset: 0, length: 6 }]);
    db.run("INSERT INTO media_group_items (bot_id, direction, media_group_id, source_chat_id, message_id, media_type, file_id, caption, caption_entities_json, has_spoiler, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "folder-links", "user_to_support", "post-send-fence", 2100, 21001, "photo", "file-a", "hidden", entities, 1, old);
    db.run("INSERT INTO media_group_items (bot_id, direction, media_group_id, source_chat_id, message_id, media_type, file_id, caption, caption_entities_json, has_spoiler, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "folder-links", "user_to_support", "post-send-fence", 2100, 21002, "photo", "file-b", "", null, 0, old);
    db.failOnce("DELETE FROM media_group_items WHERE bot_id = ? AND direction = ? AND media_group_id = ? AND source_chat_id = ? AND message_id = ?");
    await runRecoveryCycle({}, env, null);
    await runRecoveryCycle({}, env, null);
    const albums = calls.filter((call) => call.method === "sendMediaGroup" && call.body.media?.some((item) => item.media === "file-a"));
    assert.equal(albums.length, 1);
    assert.equal(albums[0].body.media[0].has_spoiler, true);
    assert.deepEqual(albums[0].body.media[0].caption_entities, [{ type: "bold", offset: 0, length: 6 }]);
  });
});

test("a closed conversation reopens once for a pending album and delivered bookkeeping is repaired without replay", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2110, 122);
    db.run("UPDATE conversations SET status = 'closed' WHERE user_id = 2110");
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, pending_release_required, created_at, updated_at) VALUES (?, ?, 1, ?, ?)", "folder-links", 2110, now, now);
    const entities = JSON.stringify([{ type: "italic", offset: 0, length: 5 }]);
    db.run("INSERT INTO pending_messages (bot_id, user_id, update_id, source_chat_id, source_message_id, media_group_id, media_type, file_id, caption, caption_entities_json, has_spoiler, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "folder-links", 2110, 21101, 2110, 31101, "pending-fence", "photo", "pending-a", "quiet", entities, 1, now);
    db.run("INSERT INTO pending_messages (bot_id, user_id, update_id, source_chat_id, source_message_id, media_group_id, media_type, file_id, caption, caption_entities_json, has_spoiler, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", "folder-links", 2110, 21102, 2110, 31102, "pending-fence", "photo", "pending-b", "", null, 0, now);
    db.failOnce("UPDATE pending_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL");
    await runRecoveryCycle({}, env, null);
    await runRecoveryCycle({}, env, null);
    const albums = calls.filter((call) => call.method === "sendMediaGroup" && call.body.media?.some((item) => item.media === "pending-a"));
    assert.equal(albums.length, 1);
    assert.equal(albums[0].body.media[0].has_spoiler, true);
    assert.deepEqual(albums[0].body.media[0].caption_entities, [{ type: "italic", offset: 0, length: 5 }]);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 2110 AND delivered_at IS NULL AND failed_at IS NULL").count, 0);
    assert.equal(calls.filter((call) => call.method === "reopenForumTopic").length, 1);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && /reopened the conversation|возобновил обращение/.test(call.body.text)).length, 1);
  });
});

test("scheduled recovery isolates a bot with missing secrets and continues other bots", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    delete env.BOT_FOLDER_LINKS_TOKEN;
    seedConversation(db, "image-compress", 2120, 123);
    const old = Date.now() - 120_000;
    db.run("INSERT INTO media_groups (bot_id, direction, media_group_id, source_chat_id, target_chat_id, thread_id, user_id, last_received_at, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)", "image-compress", "user_to_support", "other-bot-recovers", 2120, -1001234567890, 123, 2120, old, new Date(old).toISOString());
    db.run("INSERT INTO media_group_items (bot_id, direction, media_group_id, source_chat_id, message_id, media_type, file_id, caption, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", "image-compress", "user_to_support", "other-bot-recovers", 2120, 21201, "photo", "other-bot-file", "", old);
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.some((call) => call.token === "token-b" && call.method === "copyMessage" && call.body.message_id === 21201), true);
  });
});

test("management state is rechecked inside the user lock before a stale action mutates newer state", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2130, 124);
    const now = new Date().toISOString();
    const initialUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, manual_restricted_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", "folder-links", 2130, initialUntil, now, now);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(21301, 124, "/panel")), env)).status, 200);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(213010, 124, "um:tp:manage")), env)).status, 200);
    const callbackData = calls.flatMap((call) => call.body?.reply_markup?.inline_keyboard || []).flat().map((button) => button.callback_data).find((data) => data?.startsWith("um:tp:unrestrict:"));
    assert.ok(callbackData, "missing unrestrict callback");
    db.run("INSERT INTO abuse_decision_locks (bot_id, user_id, owner_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?)", "folder-links", 2130, "blocker", new Date(Date.now() + 60_000).toISOString(), now);
    const action = worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(21302, 124, callbackData)), env);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newerUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    db.run("UPDATE user_abuse_state SET manual_restricted_until = ?, updated_at = ? WHERE bot_id = ? AND user_id = ?", newerUntil, new Date().toISOString(), "folder-links", 2130);
    db.run("DELETE FROM abuse_decision_locks WHERE bot_id = ? AND user_id = ? AND owner_token = ?", "folder-links", 2130, "blocker");
    assert.equal((await action).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(21302, 124, callbackData)), env)).status, 200);
    assert.equal(db.get("SELECT manual_restricted_until FROM user_abuse_state WHERE bot_id = ? AND user_id = ?", "folder-links", 2130).manual_restricted_until, newerUntil);
  });
});


test("single user delivery is not replayed after a transport-uncertain forward", async () => {
  let forwards = 0;
  await withFixture(async (call) => {
    if (call.method === "forwardMessage") {
      forwards += 1;
      throw new Error("connection reset after accept");
    }
  }, async ({ env, db }) => {
    seedConversation(db, "folder-links", 2200, 130);
    const first = await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(2200, 2200, 22000)), env);
    assert.equal(first.status, 200);
    db.run("UPDATE processed_updates SET lease_expires_at = ? WHERE bot_id = ? AND update_id = ?", new Date(Date.now() - 1000).toISOString(), "folder-links", 2200);
    const second = await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(2200, 2200, 22000)), env);
    assert.equal(second.status, 200);
    assert.equal(forwards, 1);
    assert.equal(db.get("SELECT failure_code FROM message_delivery_attempts WHERE bot_id = 'folder-links' AND source_message_id = 22000").failure_code, "telegram_delivery_outcome_unknown");
  });
});

test("single operator delivery is not replayed after a transport-uncertain copy", async () => {
  let copies = 0;
  await withFixture(async (call) => {
    if (call.method === "copyMessage" && call.body.chat_id === 2201) {
      copies += 1;
      throw new Error("connection reset after accept");
    }
  }, async ({ env, db }) => {
    seedConversation(db, "folder-links", 2201, 131);
    const update = groupUpdate(2201, 131, "operator message", 7);
    const first = await worker.fetch(webhookRequest("folder-links", "secret-a", update), env);
    assert.equal(first.status, 200);
    db.run("UPDATE processed_updates SET lease_expires_at = ? WHERE bot_id = ? AND update_id = ?", new Date(Date.now() - 1000).toISOString(), "folder-links", 2201);
    const second = await worker.fetch(webhookRequest("folder-links", "secret-a", update), env);
    assert.equal(second.status, 200);
    assert.equal(copies, 1);
  });
});

test("HTTP 500 Telegram responses are treated as delivery-uncertain and not replayed", async () => {
  let sends = 0;
  await withFixture(async (call) => {
    if (call.method === "forwardMessage") {
      sends += 1;
      return { ok: false, error_code: 500, description: "Internal Server Error", httpStatus: 500 };
    }
  }, async ({ env, db }) => {
    seedConversation(db, "folder-links", 2202, 132);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(2202, 2202, 22002)), env)).status, 200);
    assert.equal(sends, 1);
    assert.equal(db.get("SELECT failure_code FROM message_delivery_attempts WHERE source_message_id = 22002").failure_code, "telegram_delivery_outcome_unknown");
  });
});

test("uncertain createForumTopic is quarantined and never creates a second Topic", async () => {
  let creates = 0;
  await withFixture(async (call) => {
    if (call.method === "createForumTopic") {
      creates += 1;
      throw new Error("connection reset after topic creation");
    }
  }, async ({ env, db }) => {
    const update = privateUpdate(2203, 2203, 22003);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    db.run("UPDATE processed_updates SET lease_expires_at = ? WHERE bot_id = ? AND update_id = ?", new Date(Date.now() - 1000).toISOString(), "folder-links", 2203);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(creates, 1);
    assert.equal(db.get("SELECT failure_code FROM conversation_provision_attempts WHERE bot_id = 'folder-links' AND user_id = 2203").failure_code, "telegram_topic_create_outcome_unknown");
  });
});

test("double processed-update completion failure cannot replay a delivered update after lease expiry", async () => {
  let copies = 0;
  await withFixture(async (call) => {
    if (call.method === "copyMessage" && call.body.chat_id === 2204) copies += 1;
  }, async ({ env, db }) => {
    seedConversation(db, "folder-links", 2204, 134);
    db.failOnce("UPDATE processed_updates SET state = 'completed'");
    db.failOnce("UPDATE processed_updates SET state = 'completed'");
    const update = groupUpdate(2204, 134, "once", 7);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(copies, 1);
    assert.ok(db.get("SELECT dispatch_succeeded_at FROM processed_updates WHERE bot_id = 'folder-links' AND update_id = 2204").dispatch_succeeded_at);
    db.run("UPDATE processed_updates SET lease_expires_at = ? WHERE bot_id = ? AND update_id = ?", new Date(Date.now() - 1000).toISOString(), "folder-links", 2204);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(copies, 1);
  });
});

test("pending recovery preserves repaired delivered and quarantined counters when no active rows remain", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedConversation(db, "folder-links", 2205, 135);
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id, user_id, verification_required, pending_release_required, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)", "folder-links", 2205, now, now);
    db.run("INSERT INTO pending_messages (bot_id, user_id, update_id, source_chat_id, source_message_id, created_at, delivery_started_at, delivery_completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "folder-links", 2205, 22051, 2205, 22051, now, now, now);
    db.run("INSERT INTO pending_messages (bot_id, user_id, update_id, source_chat_id, source_message_id, created_at, delivery_started_at, request_started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "folder-links", 2205, 22052, 2205, 22052, now, now, now);
    await runRecoveryCycle({}, env, null);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 2205 AND delivered_at IS NOT NULL").count, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM pending_messages WHERE user_id = 2205 AND failure_code = 'telegram_delivery_outcome_unknown'").count, 1);
  });
});

test("repeated media without caption participates in duplicate abuse scoring", async () => {
  await withFixture(null, async ({ env, db }) => {
    const make = (id) => ({ update_id: id, message: { message_id: id, chat: { id: 2206, type: "private" }, from: { id: 2206, first_name: "Media" }, photo: [{ file_id: `f${id}`, file_unique_id: "same-photo" }] } });
    await worker.fetch(webhookRequest("folder-links", "secret-a", make(22060)), env);
    await worker.fetch(webhookRequest("folder-links", "secret-a", make(22061)), env);
    await worker.fetch(webhookRequest("folder-links", "secret-a", make(22062)), env);
    const state = db.get("SELECT risk_score FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 2206");
    assert.ok(Number(state.risk_score) >= 3);
  });
});


test("a ban cannot commit between the final pending authorization and Telegram copy", async () => {
  const copyStarted = deferred();
  const releaseCopy = deferred();
  let held = false;
  await withFixture(async (call) => {
    if (!held && call.method === "copyMessage" && call.body.chat_id === -1001234567890) {
      held = true;
      copyStarted.resolve();
      return releaseCopy.promise;
    }
    return null;
  }, async ({ env, db, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(2210, 2210)), env)).status, 200);
    const token = verificationToken(calls);
    const verify = worker.fetch(new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.60", "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" }), env);
    await copyStarted.promise;
    const threadId = db.get("SELECT thread_id FROM conversations WHERE bot_id = 'folder-links' AND user_id = 2210").thread_id;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(2211, threadId, "/ban race test")), env)).status, 200);
    const confirmation = callbackUpdate(2212, threadId, pendingActionCallback(db, "confirm"));
    const confirmPromise = worker.fetch(webhookRequest("folder-links", "secret-a", confirmation), env);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(db.get("SELECT COUNT(*) AS count FROM banned_users WHERE bot_id = 'folder-links' AND user_id = 2210").count, 0);
    releaseCopy.resolve({ ok: true, result: { message_id: 11000, message_thread_id: threadId } });
    assert.equal((await verify).status, 200);
    assert.equal((await confirmPromise).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", confirmation), env)).status, 200);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM banned_users WHERE bot_id = 'folder-links' AND user_id = 2210").count, 1);
  });
});


test("pending mapping repair uses the durable delivery Topic after conversation recreation", async () => {
  await withFixture(null, async ({ env, db }) => {
    seedConversation(db, "folder-links", 2220, 140);
    const now = new Date().toISOString();
    db.run("INSERT INTO pending_messages (bot_id, user_id, update_id, source_chat_id, source_message_id, created_at, delivery_started_at, delivery_completed_at, target_message_id, target_thread_id, mapping_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)", "folder-links", 2220, 22200, 2220, 22200, now, now, now, 12000, 140);
    db.run("UPDATE conversations SET thread_id = 141 WHERE bot_id = 'folder-links' AND user_id = 2220");
    await runRecoveryCycle({}, env, null);
    const mapping = db.get("SELECT thread_id, user_message_id, support_message_id FROM message_mappings WHERE bot_id = 'folder-links' AND user_id = 2220");
    assert.equal(mapping.thread_id, 140);
    assert.equal(mapping.user_message_id, 22200);
    assert.equal(mapping.support_message_id, 12000);
    assert.ok(db.get("SELECT mapping_synced_at FROM pending_messages WHERE bot_id = 'folder-links' AND user_id = 2220").mapping_synced_at);
  });
});


test("a stale prepared single delivery is retried because Telegram was never marked as started", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2300, 150);
    const old = new Date(Date.now() - 120_000).toISOString();
    db.run("INSERT INTO message_delivery_attempts (bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at) VALUES (?,?,?,?,?,?,?,?,?)", "folder-links", "user_to_support", 2300, 23000, 2300, 150, -1001234567890, "forwardMessage", old);
    const response = await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(2300, 2300, 23000)), env);
    assert.equal(response.status, 200);
    assert.equal(calls.filter((call) => call.method === "forwardMessage" && call.body.message_id === 23000).length, 1);
    assert.ok(db.get("SELECT completed_at FROM message_delivery_attempts WHERE bot_id='folder-links' AND source_message_id=23000").completed_at);
  });
});

test("an uncertain Topic probe retries routing and never quarantines the unsent business message", async () => {
  let failProbe = true;
  await withFixture((call) => {
    if (failProbe && call.method === "sendMessage" && call.body.text === "🔎") {
      failProbe = false;
      return { ok: false, httpStatus: 500, error_code: 500, description: "probe server failure" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2301, 151);
    const now = new Date().toISOString();
    db.run("INSERT INTO message_mappings (bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES (?,?,?,?,?,?)", "folder-links", 2301, 151, 22999, 555, now);
    const update = privateUpdate(2301, 2301, 23010);
    update.message.reply_to_message = { message_id: 22999 };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM message_delivery_attempts WHERE source_message_id=23010").count, 0);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.message_id === 23010).length, 1);
  });
});

test("a prepared pending row is recovered and delivered instead of being quarantined", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2302, 152);
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 120_000).toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,pending_release_required,created_at,updated_at) VALUES ('folder-links',2302,1,?,?)", now, now);
    db.run("INSERT INTO pending_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,created_at,delivery_started_at) VALUES ('folder-links',2302,23020,2302,23020,?,?)", now, old);
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.message_id === 23020).length, 1);
    const row = db.get("SELECT delivered_at,failed_at,failure_code FROM pending_messages WHERE source_message_id=23020");
    assert.ok(row.delivered_at);
    assert.equal(row.failed_at, null);
  });
});

test("late album parts are a new recoverable generation after an uncertain earlier send", async () => {
  const sendStarted = deferred();
  const releaseSend = deferred();
  let held = false;
  await withFixture(async (call) => {
    if (!held && call.method === "sendMediaGroup" && call.body.media?.some((item) => item.media === "gen-a")) {
      held = true;
      sendStarted.resolve();
      return releaseSend.promise;
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2303, 153);
    const old = Date.now() - 120_000;
    db.run("INSERT INTO media_groups (bot_id,direction,media_group_id,source_chat_id,target_chat_id,thread_id,user_id,last_received_at,version,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)", "folder-links", "user_to_support", "generation-race", 2303, -1001234567890, 153, 2303, old, new Date(old).toISOString());
    db.run("INSERT INTO media_group_items (bot_id,direction,media_group_id,source_chat_id,message_id,media_type,file_id,caption,received_at) VALUES (?,?,?,?,?,?,?,?,?)", "folder-links", "user_to_support", "generation-race", 2303, 23031, "photo", "gen-a", "", old);
    db.run("INSERT INTO media_group_items (bot_id,direction,media_group_id,source_chat_id,message_id,media_type,file_id,caption,received_at) VALUES (?,?,?,?,?,?,?,?,?)", "folder-links", "user_to_support", "generation-race", 2303, 23032, "photo", "gen-b", "", old);
    const first = runRecoveryCycle({}, env, null);
    await sendStarted.promise;
    const late = Date.now();
    db.run("INSERT INTO media_group_items (bot_id,direction,media_group_id,source_chat_id,message_id,media_type,file_id,caption,received_at) VALUES (?,?,?,?,?,?,?,?,?)", "folder-links", "user_to_support", "generation-race", 2303, 23033, "photo", "gen-c", "", late);
    db.run("UPDATE media_groups SET version=version+1,last_received_at=? WHERE bot_id='folder-links' AND media_group_id='generation-race'", late);
    releaseSend.resolve({ ok: false, httpStatus: 500, error_code: 500, description: "ambiguous album response" });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 5));
    env.ALBUM_SETTLE_MS = "1";
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.filter((call) => call.method === "sendMediaGroup" && call.body.media?.some((item) => item.media === "gen-a")).length, 1);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.message_id === 23033).length, 1);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM media_group_items WHERE media_group_id='generation-race' AND delivery_uncertain_at IS NOT NULL").count, 2);
  });
});

test("General management fails over when the configured command-owner bot is disabled in D1", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const now = new Date().toISOString();
    db.run("INSERT INTO bots (id,display_name,topic_prefix,enabled,created_at) VALUES ('folder-links','Folder Links','FL',0,?)", now);
    const update = groupUpdate(2304, 1, "/users", 7);
    const response = await worker.fetch(webhookRequest("image-compress", "secret-b", update), env);
    assert.equal(response.status, 200);
    assert.ok(calls.some((call) => call.token === "token-b" && call.method === "sendMessage"));
    assert.equal(db.get("SELECT handler_bot_id FROM general_message_claims WHERE message_id=?", update.message.message_id).handler_bot_id, "image-compress");
  });
});


test("all post-dispatch marker writes failing returns 500 and a retry does not replay the fenced Telegram delivery", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2400, 160);
    for (let i = 0; i < 3; i++) db.failOnce("UPDATE processed_updates SET dispatch_succeeded_at = COALESCE");
    for (let i = 0; i < 2; i++) db.failOnce("UPDATE processed_updates SET state = 'completed'");
    const update = privateUpdate(2400, 2400, 24000);
    const first = await worker.fetch(webhookRequest("folder-links", "secret-a", update), env);
    assert.equal(first.status, 500);
    assert.equal(calls.filter((call) => call.method === "forwardMessage" && call.body.message_id === 24000).length, 1);
    db.run("UPDATE processed_updates SET lease_expires_at = ? WHERE bot_id = ? AND update_id = ?", new Date(Date.now() - 1000).toISOString(), "folder-links", 2400);
    const second = await worker.fetch(webhookRequest("folder-links", "secret-a", update), env);
    assert.equal(second.status, 200);
    assert.equal(calls.filter((call) => call.method === "forwardMessage" && call.body.message_id === 24000).length, 1);
    assert.equal(db.get("SELECT state FROM processed_updates WHERE bot_id='folder-links' AND update_id=2400").state, "completed");
  });
});

test("single delivery bookkeeping retries transient post-send D1 failures until both completion and mapping are durable", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2401, 161);
    for (let i = 0; i < 3; i++) db.failOnce("UPDATE message_delivery_attempts SET completed_at = ?");
    for (let i = 0; i < 2; i++) db.failOnce("INSERT OR IGNORE INTO message_mappings");
    const response = await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(2401, 2401, 24010)), env);
    assert.equal(response.status, 200);
    assert.equal(calls.filter((call) => call.method === "forwardMessage" && call.body.message_id === 24010).length, 1);
    const delivery = db.get("SELECT completed_at,target_message_id,mapping_synced_at FROM message_delivery_attempts WHERE bot_id='folder-links' AND source_message_id=24010");
    assert.ok(delivery.completed_at);
    assert.ok(delivery.target_message_id);
    assert.ok(delivery.mapping_synced_at);
    const mapping = db.get("SELECT support_message_id FROM message_mappings WHERE bot_id='folder-links' AND user_id=2401 AND user_message_id=24010");
    assert.equal(Number(mapping.support_message_id), Number(delivery.target_message_id));
  });
});


test("sixth hardening: removed operator is linearized against an in-flight reply", async () => {
  const copyStarted = deferred();
  const releaseCopy = deferred();
  await withFixture(async (call) => {
    if (call.method === "copyMessage" && call.body.chat_id === 2500) {
      copyStarted.resolve();
      await releaseCopy.promise;
    }
    return null;
  }, async ({ env, db }) => {
    seedConversation(db, "folder-links", 2500, 170);
    seedOperator(db, 8);
    const reply = worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(2501, 170, "reply", 8)), env);
    await copyStarted.promise;
    const flow = await beginOperatorRemoval(env, db, 8, 2502);
    const removal = confirmOperatorFlow(env, flow, 2503, 7, 500);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id=8").active, 1);
    releaseCopy.resolve();
    assert.equal((await reply).status, 200);
    assert.equal((await removal).status, 500);
    assert.equal((await confirmOperatorFlow(env, flow, 2503)).status, 200);
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id=8").active, 0);
  });
});

test("sixth hardening: reaction settings hold the operator fence until webhook reconciliation finishes", async () => {
  const webhookStarted = deferred();
  const releaseWebhook = deferred();
  let blocked = false;
  await withFixture(async (call) => {
    if (call.method === "setWebhook" && !blocked) {
      blocked = true;
      webhookStarted.resolve();
      await releaseWebhook.promise;
    }
    return null;
  }, async ({ env, db }) => {
    seedOperator(db, 8);
    const now = new Date().toISOString();
    db.run("INSERT INTO reaction_settings (bot_id,enabled,capability_verified,updated_at,verified_at) VALUES ('folder-links',0,1,?,?)", now, now);
    const setting = worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(2510, 1, "/reactions on folder-links", 8)), env);
    await webhookStarted.promise;
    const flow = await beginOperatorRemoval(env, db, 8, 2511);
    const removal = confirmOperatorFlow(env, flow, 2512, 7, 500);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id=8").active, 1);
    releaseWebhook.resolve();
    assert.equal((await setting).status, 200);
    assert.equal((await removal).status, 500);
    assert.equal((await confirmOperatorFlow(env, flow, 2512)).status, 200);
    assert.equal(db.get("SELECT active FROM support_operators WHERE user_id=8").active, 0);
  });
});

test("sixth hardening: cron cannot reopen an effect after the user is banned", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2520, 171);
    db.run("UPDATE conversations SET status='closed' WHERE user_id=2520");
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,created_at,updated_at) VALUES ('folder-links',2520,?,?)", now, now);
    db.run("INSERT INTO conversation_reopen_effects (bot_id,user_id,old_thread_id,created_at) VALUES ('folder-links',2520,171,?)", now);
    db.run("INSERT INTO banned_users (bot_id,user_id,reason,banned_at) VALUES ('folder-links',2520,'blocked',?)", now);
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.some((call) => call.method === "reopenForumTopic" && call.body.message_thread_id === 171), false);
    assert.equal(db.get("SELECT status FROM conversations WHERE user_id=2520").status, "closed");
    const effect = db.get("SELECT completed_at, cancelled_at, cancellation_reason FROM conversation_reopen_effects WHERE user_id=2520");
    assert.ok(effect.completed_at);
    assert.ok(effect.cancelled_at);
    assert.equal(effect.cancellation_reason, "banned");
    db.run("DELETE FROM banned_users WHERE bot_id='folder-links' AND user_id=2520");
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.some((call) => call.method === "reopenForumTopic" && call.body.message_thread_id === 171), false);
  });
});

test("sixth hardening: a prepared reopen marker with no HTTP start is retried safely", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2530, 172);
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,created_at,updated_at) VALUES ('folder-links',2530,?,?)", now, now);
    db.run("INSERT INTO conversation_reopen_effects (bot_id,user_id,old_thread_id,new_thread_id,opened_at,marker_prepared_at,business_delivered_at,created_at) VALUES ('folder-links',2530,172,172,?,?,?,?)", now, now, now, now);
    await runRecoveryCycle({}, env, null);
    const marker = calls.find((call) => call.method === "sendMessage" && call.body.message_thread_id === 172 && /reopened the conversation|возобновил обращение/i.test(String(call.body.text)));
    assert.ok(marker);
    const effect = db.get("SELECT marker_delivered_at, marker_outcome_uncertain_at FROM conversation_reopen_effects WHERE user_id=2530");
    assert.ok(effect.marker_delivered_at);
    assert.equal(effect.marker_outcome_uncertain_at, null);
  });
});

test("sixth hardening: ambiguous deleted-topic recreation preserves the triggering source for later recovery", async () => {
  let ambiguous = true;
  await withFixture(async (call) => {
    if (call.method === "reopenForumTopic") return { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
    if (call.method === "createForumTopic" && ambiguous) {
      ambiguous = false;
      return { ok: false, error_code: 500, httpStatus: 500, description: "Internal Server Error after create" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2540, 173);
    db.run("UPDATE conversations SET status='closed' WHERE user_id=2540");
    const first = await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(2541, 2540, 35401)), env);
    assert.equal(first.status, 200);
    const queued = db.get("SELECT * FROM reopen_business_messages WHERE bot_id='folder-links' AND update_id=2541");
    assert.ok(queued);
    assert.equal(queued.source_message_id, 35401);
    assert.equal(queued.delivered_at, null);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM conversations WHERE user_id=2540").count, 0);

    // Simulate operator reconciliation of the ambiguous Topic. The durable source can now be replayed exactly once.
    const now = new Date().toISOString();
    db.run("INSERT INTO conversations (bot_id,user_id,username,first_name,support_group_id,thread_id,status,created_at,last_message_at) VALUES ('folder-links',2540,'user2540','Alex',-1001234567890,174,'open',?,?)", now, now);
    await runRecoveryCycle({}, env, null);
    const copies = calls.filter((call) => call.method === "copyMessage" && call.body.message_id === 35401);
    assert.equal(copies.length, 1);
    assert.ok(db.get("SELECT delivered_at FROM reopen_business_messages WHERE update_id=2541").delivered_at);
  });
});

test("sixth hardening: concurrent reopen recovery emits one panel and unique system audit", async () => {
  const markerStarted = deferred();
  const releaseMarker = deferred();
  let blockMarker = true;
  await withFixture(async (call) => {
    if (call.method === "sendMessage" && call.body.message_thread_id === 175 && /reopened the conversation|возобновил обращение/i.test(String(call.body.text)) && blockMarker) {
      blockMarker = false;
      markerStarted.resolve();
      await releaseMarker.promise;
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2550, 175);
    db.run("UPDATE conversations SET status='closed' WHERE user_id=2550");
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,created_at,updated_at) VALUES ('folder-links',2550,?,?)", now, now);
    const first = worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(2551, 2550, 35501)), env);
    await markerStarted.promise;
    const cron = runRecoveryCycle({}, env, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseMarker.resolve();
    assert.equal((await first).status, 200);
    await cron;
    assert.equal(db.get("SELECT COUNT(*) AS count FROM operator_audit WHERE user_id=2550 AND action='conversation_reopened_by_user'").count, 1);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && call.body.message_thread_id === 175 && call.body.reply_markup).length, 1);
  });
});

test("sixth hardening: D1 failover owner stays subscribed to group reactions", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const third = {
      id: "third-service", displayName: "Third", topicPrefix: "Third", tokenBinding: "BOT_THIRD_TOKEN",
      webhookSecretBinding: "BOT_THIRD_SECRET", username: "ThirdBot", enabled: true,
    };
    env.BOT_REGISTRY = JSON.stringify([...registryValue, third]);
    env.BOT_THIRD_TOKEN = "token-c";
    env.BOT_THIRD_SECRET = "secret-c";
    const now = new Date().toISOString();
    db.run("INSERT INTO bots (id,display_name,topic_prefix,enabled,created_at) VALUES ('folder-links','Folder Links','Folder Links',0,?)", now);
    db.run("INSERT INTO bots (id,display_name,topic_prefix,enabled,created_at) VALUES ('image-compress','Image Compress','Image Compress',1,?)", now);
    db.run("INSERT INTO bots (id,display_name,topic_prefix,enabled,created_at) VALUES ('third-service','Third','Third',1,?)", now);
    db.run("INSERT INTO reaction_settings (bot_id,enabled,capability_verified,updated_at,verified_at) VALUES ('folder-links',0,1,?,?)", now, now);
    db.run("INSERT INTO reaction_settings (bot_id,enabled,capability_verified,updated_at,verified_at) VALUES ('image-compress',0,1,?,?)", now, now);
    db.run("INSERT INTO reaction_settings (bot_id,enabled,capability_verified,updated_at,verified_at) VALUES ('third-service',0,1,?,?)", now, now);
    assert.equal((await worker.fetch(webhookRequest("image-compress", "secret-b", groupUpdate(2560, 1, "/reactions on third-service")), env)).status, 200);
    const imageWebhook = calls.find((call) => call.method === "setWebhook" && call.token === "token-b");
    assert.ok(imageWebhook);
    assert.ok(imageWebhook.body.allowed_updates.includes("message_reaction"));
    assert.equal(calls.some((call) => call.method === "setWebhook" && call.token === "token-a"), false);
  });
});

test("sixth hardening: legacy operator albums are quarantined and alerted instead of deleted", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2570, 176);
    const now = new Date().toISOString();
    db.run("INSERT INTO media_groups (bot_id,direction,media_group_id,source_chat_id,target_chat_id,thread_id,user_id,operator_id,last_received_at,version,claimed_at,claimed_version,created_at) VALUES ('folder-links','support_to_user','legacy',-1001234567890,2570,176,2570,NULL,?,1,NULL,NULL,?)", Date.now()-10000, now);
    db.run("INSERT INTO media_group_items (bot_id,direction,media_group_id,source_chat_id,message_id,media_type,file_id,caption,received_at) VALUES ('folder-links','support_to_user','legacy',-1001234567890,35701,'photo','legacy-file','',?)", Date.now()-10000);
    await runRecoveryCycle({}, env, null);
    const group = db.get("SELECT operator_identity_unknown_at, operator_identity_alerted_at FROM media_groups WHERE media_group_id='legacy'");
    assert.ok(group);
    assert.ok(group.operator_identity_unknown_at);
    assert.ok(group.operator_identity_alerted_at);
    assert.equal(calls.some((call) => (call.method === "copyMessage" || call.method === "sendMediaGroup") && call.body.chat_id === 2570), false);
  });
});

test("sixth hardening: native close during reopen marker is treated as routing evidence and retried", async () => {
  let markerClosed = true;
  await withFixture(async (call) => {
    if (call.method === "sendMessage" && call.body.message_thread_id === 177 && /reopened the conversation|возобновил обращение/i.test(String(call.body.text)) && markerClosed) {
      markerClosed = false;
      return { ok: false, error_code: 400, description: "Bad Request: topic is closed" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2580, 177);
    db.run("UPDATE conversations SET status='closed' WHERE user_id=2580");
    const update = privateUpdate(2581, 2580, 35801);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal(db.get("SELECT status FROM conversations WHERE user_id=2580").status, "closed");
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.ok(calls.filter((call) => call.method === "reopenForumTopic" && call.body.message_thread_id === 177).length >= 2);
    const effect = db.get("SELECT marker_delivered_at, marker_failure FROM conversation_reopen_effects WHERE user_id=2580 ORDER BY id DESC LIMIT 1");
    assert.ok(effect.marker_delivered_at);
    assert.equal(effect.marker_failure, null);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.message_id === 35801).length, 1);
  });
});

test("sixth hardening: reopen durable queue delivers source ids in ascending order", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2590, 178);
    const now = new Date(Date.now()-1000).toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,created_at,updated_at) VALUES ('folder-links',2590,?,?)", now, now);
    db.run("INSERT INTO conversation_reopen_effects (bot_id,user_id,old_thread_id,new_thread_id,opened_at,marker_delivered_at,panel_refreshed_at,last_business_queued_at,created_at) VALUES ('folder-links',2590,178,178,?,?,?,?,?)", now, now, now, now, now);
    db.run("INSERT INTO reopen_business_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,source_first_name,created_at) VALUES ('folder-links',2590,2592,2590,35902,'Alex',?)", now);
    db.run("INSERT INTO reopen_business_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,source_first_name,created_at) VALUES ('folder-links',2590,2591,2590,35901,'Alex',?)", now);
    await runRecoveryCycle({}, env, null);
    const copies = calls.filter((call) => call.method === "copyMessage" && [35901,35902].includes(call.body.message_id));
    assert.deepEqual(copies.map((call) => call.body.message_id), [35901,35902]);
  });
});

test("sixth hardening: operators command from a user topic does not write management guidance into that topic", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 2600, 179);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(2601, 179, "/operators")), env)).status, 200);
    assert.equal(calls.some((call) => call.method === "sendMessage" && call.body.message_thread_id === 179 && /operator management|управление операторами/i.test(String(call.body.text))), false);
    assert.ok(calls.some((call) => call.method === "sendMessage" && !call.body.message_thread_id && String(call.body.text).includes("General")));
  });
});


test("recovery budget: a ten-part pending album makes progress without uncertain delivery", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 8001, 801);
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,pending_release_required,created_at,updated_at) VALUES ('folder-links',8001,1,?,?)", now, now);
    for (let i = 0; i < 10; i++) db.run("INSERT INTO pending_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,media_group_id,media_type,file_id,created_at) VALUES ('folder-links',8001,?,8001,?,'large','photo',?,?)", 80010+i, 80010+i, 'part'+i, now);
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.filter(c => c.method === "sendMediaGroup").length, 1);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM pending_messages WHERE delivered_at IS NOT NULL").n, 10);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM pending_messages WHERE failure_code IS NOT NULL").n, 0);
  });
});


test("recovery budget: dense multi-bot backlog drains under the Free ceiling", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const now = new Date().toISOString();
    for (const [b, bot] of registryValue.entries()) {
      for (let i = 0; i < 100; i++) {
        const user = 9000 + b * 100 + i;
        db.run("INSERT INTO message_delivery_attempts (bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at,failure_code) VALUES (?,'user_to_support',?,?,?,900,-1001234567890,'copyMessage',?,'telegram_delivery_outcome_unknown')", bot.id, user, user, user, now);
        db.run("INSERT INTO conversation_provision_attempts (bot_id,user_id,started_at,failure_code) VALUES (?,?,?,'telegram_topic_create_outcome_unknown')", bot.id, user, now);
        db.run("INSERT INTO pending_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,created_at,delivery_started_at,delivery_completed_at,target_message_id,target_thread_id) VALUES (?,?,?,?,?,?,?,?,?,900)", bot.id, user, user, user, user, now, now, now, 10000+user);
        db.run("INSERT INTO banned_users (bot_id,user_id,banned_at) VALUES (?,?,?)", bot.id, user, now);
      }
    }
    db.run("INSERT INTO processed_updates (bot_id,update_id,state,owner_token,processed_at) VALUES ('folder-links',99999,'completed','old',?)", new Date(Date.now()-8*86400000).toISOString());
    const expiredScreen = new Date(Date.now()-8*86400000).toISOString();
    const expiredNotice = new Date(Date.now()-40*86400000).toISOString();
    db.run(`INSERT INTO manager_message_sends(update_id,chat_id,thread_id,status,claim_token,claimed_at,updated_at)
      VALUES(99998,7,0,'uncertain','old',?,?)`, expiredScreen, expiredScreen);
    db.run(`INSERT INTO service_notification_outbox
      (bot_id,user_id,notification_cycle,kind,recipient_id,group_id,thread_id,status,
       available_at,created_at,telegram_message_id,sent_at)
      VALUES('folder-links',99998,1,'new',7,-1001234567890,900,'sent',?,?,123,?)`,
    expiredNotice, expiredNotice, expiredNotice);
    let peak = 0;
    for (let i = 0; i < 140; i++) peak = Math.max(peak, await runCountedRecovery({}, env));
    assert.ok(peak >= 30, "fixture must exercise budget exhaustion");
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_delivery_attempts WHERE alerted_at IS NULL").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM conversation_provision_attempts WHERE alerted_at IS NULL").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM pending_messages WHERE mapping_synced_at IS NULL").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM banned_users WHERE notified_at IS NULL").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM processed_updates").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM manager_message_sends").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM service_notification_outbox WHERE user_id=99998").n, 0);
    assert.equal(calls.some(c => ["copyMessage", "createForumTopic"].includes(c.method)), false);
  });
});

for (const failure of ["telegram", "mapping"]) test(`recovery budget: failing ${failure} queue cannot starve another bot or maintenance`, async () => {
  await withFixture((call) => failure === "telegram" && call.token === "token-a" && call.method === "sendMessage"
    ? { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the supergroup chat" }
    : null, async ({ env, db, calls }) => {
    const now = new Date().toISOString();
    if (failure === "mapping") db.sqlite.exec(`CREATE TRIGGER reject_mapping BEFORE INSERT ON message_mappings
      WHEN NEW.bot_id = 'folder-links' BEGIN SELECT RAISE(ABORT, 'Simulated persistent mapping failure'); END`);
    for (let i = 0; i < 45; i++) {
      if (failure === "telegram") {
        db.run("INSERT INTO message_delivery_attempts (bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at,failure_code) VALUES ('folder-links','user_to_support',?,?,?,900,-1001234567890,'copyMessage',?,'telegram_delivery_outcome_unknown')", 71000+i, 71000+i, 71000+i, now);
      } else {
        db.run("INSERT INTO pending_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,created_at,delivery_started_at,delivery_completed_at,target_message_id,target_thread_id) VALUES ('folder-links',?,?,?,?,?,?,?,?,900)", 71000+i, 71000+i, 71000+i, 71000+i, now, now, now, 81000+i);
      }
    }
    db.run("INSERT INTO pending_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,created_at,delivery_started_at,delivery_completed_at,target_message_id,target_thread_id) VALUES ('image-compress',72000,72000,72000,72000,?,?,?,82000,900)", now, now, now);
    db.run("INSERT INTO processed_updates (bot_id,update_id,state,owner_token,processed_at) VALUES ('folder-links',99999,'completed','old',?)", new Date(Date.now()-8*86400000).toISOString());
    for (let turn = 0; turn < 12; turn++) await runCountedRecovery({}, env);
    assert.ok(db.get("SELECT mapping_synced_at FROM pending_messages WHERE bot_id = 'image-compress'").mapping_synced_at);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_mappings WHERE bot_id = 'image-compress'").n, 1);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM processed_updates").n, 0);
    assert.equal(failure === "telegram"
      ? db.get("SELECT COUNT(*) AS n FROM message_delivery_attempts WHERE bot_id = 'folder-links' AND alerted_at IS NULL").n
      : db.get("SELECT COUNT(*) AS n FROM pending_messages WHERE bot_id = 'folder-links' AND mapping_synced_at IS NULL").n, 45);
    assert.equal(calls.some((call) => ["copyMessage", "createForumTopic"].includes(call.method)), false);
  });
});

test("recovery budget: a ten-part live album persists completion before yielding mappings", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 8101, 811);
    const now = new Date().toISOString();
    db.run("INSERT INTO media_groups (bot_id,direction,media_group_id,source_chat_id,target_chat_id,thread_id,user_id,last_received_at,version,created_at) VALUES ('folder-links','user_to_support','large-live',8101,-1001234567890,811,8101,?,1,?)", Date.now()-10000, now);
    for (let i = 0; i < 10; i++) db.run("INSERT INTO media_group_items (bot_id,direction,media_group_id,source_chat_id,message_id,media_type,file_id,caption,received_at) VALUES ('folder-links','user_to_support','large-live',8101,?,'photo',?,'',?)", 81010+i, 'live'+i, Date.now()-10000);
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.filter(c => c.method === "sendMediaGroup").length, 1);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_mappings WHERE user_id=8101").n, 10);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM media_groups").n, 0);
  });
});

test("recovery budget: pending delivery can provision a Topic across turns", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const now = new Date().toISOString();
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,pending_release_required,created_at,updated_at) VALUES ('folder-links',8201,1,?,?)", now, now);
    db.run("INSERT INTO pending_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES ('folder-links',8201,8201,8201,82010,?)", now);
    await runRecoveryCycle({}, env, null);
    assert.equal(calls.filter(c => c.method === "createForumTopic").length, 1);
    assert.equal(calls.filter(c => c.method === "copyMessage").length, 1);
    assert.ok(db.get("SELECT delivered_at FROM pending_messages WHERE user_id=8201").delivered_at);
  });
});


test("paid recovery exceeds Free budget and switches back without losing cursor", async () => {
  await withFixture(null, async ({ env, db }) => {
    const now = new Date().toISOString();
    for (let i = 0; i < 100; i++) db.run("INSERT INTO message_delivery_attempts (bot_id,direction,source_chat_id,source_message_id,user_id,thread_id,target_chat_id,method,started_at,failure_code) VALUES ('folder-links','user_to_support',?,?,?,900,-1001234567890,'copyMessage',?,'telegram_delivery_outcome_unknown')", 9500+i, 9500+i, 9500+i, now);
    env.RECOVERY_D1_PLAN = "paid";
    const scope = { queries: 0, limit: 1000 };
    const waits = [];
    await recoveryQueryScope.run(scope, async () => {
      await worker.scheduled({}, env, { waitUntil: promise => waits.push(promise) });
      await Promise.all(waits);
    });
    assert.ok(scope.queries > 45 && scope.queries <= 905);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_delivery_attempts WHERE alerted_at IS NOT NULL").n, 50);
    const ticket = db.get("SELECT next_job FROM recovery_scheduler").next_job;
    env.RECOVERY_D1_PLAN = "free";
    await runCountedRecovery({}, env);
    assert.ok(db.get("SELECT next_job FROM recovery_scheduler").next_job >= ticket);
  });
});


for (const plan of ["free", "paid"]) test(`operator execution contention uses one acquire query on ${plan} and retries safely`, async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.RECOVERY_D1_PLAN = plan;
    seedConversation(db, "folder-links", 9700, 970);
    const now = new Date().toISOString();
    db.run("INSERT INTO support_operator_execution_locks (operator_id,owner_token,lease_expires_at,created_at) VALUES (7,'holder',?,?)", new Date(Date.now()+60000).toISOString(), now);
    const scope = { queries: 0, sqls: [] };
    const update = groupUpdate(9701, 970, "busy reply");
    const response = await recoveryQueryScope.run(scope, () => worker.fetch(webhookRequest("folder-links", "secret-a", update), env));
    assert.equal(response.status, 500);
    assert.equal(scope.sqls.filter(sql => sql.includes("support_operator_execution_locks")).length, 1);
    assert.ok(scope.queries < 50);
    assert.equal(calls.some(call => call.method === "copyMessage"), false);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_delivery_attempts WHERE source_message_id=9701").n, 0);
    assert.equal(db.get("SELECT owner_token FROM support_operator_execution_locks WHERE operator_id=7").owner_token, "holder");
    assert.equal(db.get("SELECT COUNT(*) AS n FROM processed_updates WHERE update_id=9701 AND state='completed'").n, 0);
    db.run("UPDATE support_operator_execution_locks SET lease_expires_at = ? WHERE operator_id=7", new Date(Date.now()-1000).toISOString());
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter(call => call.method === "copyMessage").length, 1);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM support_operator_execution_locks").n, 0);
  });
});


test("busy abuse decision does two D1 queries and leaves retryable input untouched", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 9800, 980);
    const now = new Date().toISOString();
    db.run("INSERT INTO abuse_decision_locks (bot_id,user_id,owner_token,lease_expires_at,created_at) VALUES ('folder-links',9800,'holder',?,?)", new Date(Date.now()+60000).toISOString(), now);
    const scope = { queries: 0, sqls: [] };
    const update = privateUpdate(9801, 9800);
    const response = await recoveryQueryScope.run(scope, () => worker.fetch(webhookRequest("folder-links", "secret-a", update), env));
    assert.equal(response.status, 500);
    assert.equal(scope.sqls.filter(sql => sql.includes("abuse_decision_locks")).length, 2);
    assert.equal(calls.length, 0);
    assert.equal(db.get("SELECT owner_token FROM abuse_decision_locks WHERE user_id=9800").owner_token, "holder");
    db.run("UPDATE abuse_decision_locks SET lease_expires_at=? WHERE user_id=9800", new Date(Date.now()-1000).toISOString());
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter(call => call.method === "forwardMessage").length, 1);
  });
});

test("busy verification attempt returns 409 after two claim queries without another Siteverify", async () => {
  const started = deferred();
  const release = deferred();
  await withFixture(async call => {
    if (call.method === "siteverify") { started.resolve(); await release.promise; }
  }, async ({ env, calls }) => {
    env.TURNSTILE_SITE_KEY = "site-key";
    env.TURNSTILE_SECRET_KEY = "secret-key";
    env.BOT_REGISTRY = JSON.stringify([{ ...registryValue[0], verification_mode: "always" }]);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(9900,9900)), env)).status, 200);
    const token = verificationToken(calls);
    const request = () => new Request(`https://support.example.workers.dev/verify/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "cf-turnstile-response=proof" });
    const first = worker.fetch(request(), env);
    await started.promise;
    try {
      const scope = { queries: 0, sqls: [] };
      const busy = await recoveryQueryScope.run(scope, () => worker.fetch(request(), env));
      assert.equal(busy.status, 409);
      assert.equal(scope.sqls.filter(sql => sql.includes("verification_attempts")).length, 2);
      assert.equal(calls.filter(call => call.method === "siteverify").length, 1);
    } finally { release.resolve(); await first; }
    assert.equal((await worker.fetch(request(), env)).status, 200);
    assert.equal(calls.filter(call => call.method === "copyMessage").length, 1);
  });
});


test("operator execution heartbeat keeps a long reaction-setting operation fenced", async () => {
  const webhookStarted = deferred();
  const releaseWebhook = deferred();
  let blocked = false;
  await withFixture(async (call) => {
    if (call.method === "setWebhook" && !blocked) {
      blocked = true;
      webhookStarted.resolve();
      await releaseWebhook.promise;
    }
    return null;
  }, async ({ env, db }) => {
    env.OPERATOR_EXECUTION_RENEW_MS = "20";
    seedOperator(db, 8);
    const now = new Date().toISOString();
    db.run("INSERT INTO reaction_settings (bot_id,enabled,capability_verified,updated_at,verified_at) VALUES ('folder-links',0,1,?,?)", now, now);
    const setting = worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(9970, 1, "/reactions on folder-links", 8)), env);
    await webhookStarted.promise;
    db.run("UPDATE support_operator_execution_locks SET lease_expires_at=? WHERE operator_id=8", new Date(Date.now() + 70).toISOString());
    await new Promise((resolve) => setTimeout(resolve, 55));
    const renewed = db.get("SELECT lease_expires_at FROM support_operator_execution_locks WHERE operator_id=8");
    assert.ok(Date.parse(renewed.lease_expires_at) > Date.now() + 1000);
    releaseWebhook.resolve();
    assert.equal((await setting).status, 200);
  });
});

test("retryable Telegram reaction failure returns 500 and the same update succeeds once retried", async () => {
  let fail = true;
  await withFixture((call) => {
    if (call.method === "setMessageReaction" && fail) {
      fail = false;
      return { ok: false, httpStatus: 429, error_code: 429, description: "Too Many Requests" };
    }
    return null;
  }, async ({ env, db, calls }) => {
    seedConversation(db, "folder-links", 9980, 998);
    const now = new Date().toISOString();
    db.run("INSERT INTO reaction_settings (bot_id,enabled,capability_verified,updated_at,verified_at) VALUES ('folder-links',1,1,?,?)", now, now);
    db.run("INSERT INTO message_mappings (bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES ('folder-links',9980,998,19980,29980,?)", now);
    const update = { update_id: 9981, message_reaction: { chat: { id: 9980, type: 'private' }, message_id: 19980, user: { id: 9980, first_name: 'Alex' }, date: 1788560000, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] } };
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 500);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "setMessageReaction").length, 2);
    assert.equal(db.get("SELECT user_reaction_update_id FROM message_mappings WHERE user_id=9980").user_reaction_update_id, 9981);
  });
});


test("reaction webhook compensation still runs after the operator fence is lost", async () => {
  let dbRef;
  let webhookCalls = 0;
  await withFixture((call) => {
    if (call.method === "setWebhook") {
      webhookCalls += 1;
      if (webhookCalls === 1) {
        dbRef.run("UPDATE support_operator_execution_locks SET owner_token = 'stolen-owner' WHERE operator_id = 7");
      }
    }
    return null;
  }, async ({ env, db, calls }) => {
    dbRef = db;
    const now = new Date().toISOString();
    db.run("INSERT INTO reaction_settings (bot_id,enabled,capability_verified,updated_at,verified_at) VALUES ('folder-links',0,1,?,?)", now, now);
    db.run("INSERT INTO reaction_settings (bot_id,enabled,capability_verified,updated_at,verified_at) VALUES ('image-compress',0,1,?,?)", now, now);
    const response = await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(15_150, 1, "/reactions on image-compress")), env);
    assert.equal(response.status, 200);
    assert.equal(db.get("SELECT enabled FROM reaction_settings WHERE bot_id = 'image-compress'").enabled, 0);
    const webhookUpdates = calls.filter((call) => call.method === "setWebhook");
    assert.equal(webhookUpdates.length, 2);
    assert.equal(webhookUpdates[0].body.allowed_updates.includes("message_reaction"), true);
    assert.equal(webhookUpdates[1].body.allowed_updates.includes("message_reaction"), false);
  });
});


const styleCatalogue = Array.from({ length: 25 }, (_, i) => ({ custom_emoji_id: String(5000000000000000000n + BigInt(i)), emoji: i % 2 ? "⭐" : "📁" }));
function styleTelegram(call) {
  if (call.method === "getForumTopicIconStickers") return { ok: true, result: styleCatalogue };
}
function styleButtons(calls) {
  return calls.filter(call => ["sendMessage", "editMessageText"].includes(call.method)).at(-1)?.body.reply_markup?.inline_keyboard.flat() || [];
}
async function styleClick(env, calls, updateId, predicate, actor = 7, thread = 1) {
  const data = styleButtons(calls).find(predicate)?.callback_data;
  assert.ok(data, "missing topic-style button");
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(updateId, thread, data, actor)), env)).status, 200);
  return data;
}

function planDriver(env, calls, fetchMock, firstId = 65000) {
  const ingress = createControlPlaneWorker(undefined, fetchMock);
  let nextId = firstId;
  const send = async (value, actor = 7, thread = 1, updateId = nextId++) => {
    const update = value.startsWith("/") ? groupUpdate(updateId, thread, value, actor) : callbackUpdate(updateId, thread, value, actor);
    const scope = { queries: 0, limit: 50, sqls: [] };
    const response = await recoveryQueryScope.run(scope, () => ingress.fetch(webhookRequest("folder-links", "secret-a", update), env));
    assert.ok(scope.queries <= 50);
    assert.equal(scope.sqls.filter(sql => sql.includes("FROM cloudflare_plan_settings")).length >= 1, true);
    return response;
  };
  return {
    send,
    async click(predicate) {
      const data = styleButtons(calls).find(predicate)?.callback_data;
      assert.ok(data, "missing plan button");
      assert.ok(Buffer.byteLength(data) <= 64);
      assert.equal((await send(data)).status, 200);
      return data;
    },
  };
}

test("Cloudflare plan: primary General panel persists Paid, billing day, Free and config reset", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = "free";
    const ui = planDriver(env, calls, fetchMock);
    assert.equal((await ui.send("um:n:system")).status, 200);
    await ui.click(b => b.callback_data === "um:d:home");
    const oldFree = styleButtons(calls).find(b => b.text.startsWith("Free")).callback_data;
    await ui.click(b => b.text.startsWith("Paid"));
    await ui.click(b => b.text === "31");
    const confirmation = await ui.click(b => b.callback_data.startsWith("um:d:set:"));
    const paid = db.get("SELECT * FROM cloudflare_plan_settings");
    assert.equal(paid.plan, "paid");
    assert.equal(paid.billing_day, 31);
    assert.equal(paid.updated_by, 7);
    assert.equal(env.RECOVERY_D1_PLAN, "free");
    assert.equal((await ui.send(confirmation)).status, 200);
    assert.equal((await ui.send(oldFree)).status, 200);
    assert.equal(db.get("SELECT plan FROM cloudflare_plan_settings").plan, "paid");
    assert.equal(db.get("SELECT COUNT(*) AS n FROM operator_audit WHERE action = 'cloudflare_plan'").n, 1);
    await ui.send("/plan");
    await ui.click(b => b.callback_data.includes(":billing:"));
    await ui.click(b => b.text === "17");
    await ui.click(b => b.callback_data.includes(":set:"));
    assert.equal(db.get("SELECT billing_day FROM cloudflare_plan_settings").billing_day, 17);
    await ui.click(b => b.text.startsWith("Free"));
    await ui.click(b => b.callback_data.includes(":set:"));
    assert.equal(db.get("SELECT plan FROM cloudflare_plan_settings").plan, "free");
    // A persisted Free selection takes precedence even if deployment defaults change.
    env.RECOVERY_D1_PLAN = "paid";
    env.WORKERS_BILLING_DAY = "6";
    await ui.send("/plan");
    assert.match(lastWorkspaceScreen(calls).body.text, /FREE/);
    await ui.click(b => b.callback_data.includes(":choose:auto:"));
    await ui.click(b => b.callback_data.includes(":set:auto:"));
    assert.equal(db.get("SELECT plan FROM cloudflare_plan_settings").plan, null);
    const { readCloudflarePlan } = await import("../src/cloudflare-plan.js?fresh-plan-test");
    const resolved = await readCloudflarePlan(db, env);
    assert.equal(resolved.plan, "paid");
    assert.equal(resolved.source, "config");
    assert.equal(resolved.billingDay, 17);
    assert.ok(styleButtons(calls).every(b => Buffer.byteLength(b.callback_data) <= 64));
  });
});

test("Cloudflare plan: permissions, topic scope and malformed callbacks cannot change the plan", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = "free";
    env.WORKERS_BILLING_DAY = "17";
    seedOperator(db, 8);
    seedConversation(db, "folder-links", 65100, 651);
    const ui = planDriver(env, calls, fetchMock, 65101);
    await ui.send("/users", 8);
    assert.equal(styleButtons(calls).some(b => b.callback_data === "um:d:home"), false);
    await ui.send("/plan");
    await ui.click(b => b.text.startsWith("Paid"));
    const confirm = styleButtons(calls).find(b => b.callback_data.includes(":set:")).callback_data;
    for (const [data, actor, thread] of [[confirm, 8, 1], [confirm, 999, 1], [confirm, 7, 651],
      [confirm + ":0", 7, 1], [confirm.replace(":17", ":32"), 7, 1], [confirm.replace(":paid:", ":pro:"), 7, 1]]) {
      assert.equal((await ui.send(data, actor, thread)).status, 200);
      assert.equal(db.get("SELECT plan FROM cloudflare_plan_settings").plan, null);
    }
    assert.equal(db.get("SELECT COUNT(*) AS n FROM operator_audit WHERE action = 'cloudflare_plan'").n, 0);
  });
});

test("Cloudflare plan: audit failure rolls back, busy lease is retryable, concurrent confirmations apply once", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = "free";
    env.WORKERS_BILLING_DAY = "6";
    const ui = planDriver(env, calls, fetchMock, 65200);
    await ui.send("/plan");
    await ui.click(b => b.text.startsWith("Paid"));
    const confirmation = styleButtons(calls).find(b => b.callback_data.includes(":set:")).callback_data;
    db.failOnce("INSERT INTO operator_audit");
    assert.equal((await ui.send(confirmation, 7, 1, 65250)).status, 500);
    assert.equal(db.get("SELECT revision FROM cloudflare_plan_settings").revision, "initial");
    db.run("INSERT INTO support_operator_execution_locks (operator_id, owner_token, lease_expires_at, created_at) VALUES (7, 'busy', ?, ?)", new Date(Date.now() + 60000).toISOString(), new Date().toISOString());
    assert.equal((await ui.send(confirmation, 7, 1, 65250)).status, 500);
    assert.equal(db.get("SELECT plan FROM cloudflare_plan_settings").plan, null);
    db.run("DELETE FROM support_operator_execution_locks WHERE owner_token = 'busy'");
    const responses = await Promise.all([ui.send(confirmation, 7, 1, 65250), ui.send(confirmation, 7, 1, 65251)]);
    assert.ok(responses.some(r => r.status === 200));
    await ui.send(confirmation, 7, 1, 65251);
    assert.equal(db.get("SELECT plan FROM cloudflare_plan_settings").plan, "paid");
    assert.equal(db.get("SELECT COUNT(*) AS n FROM operator_audit WHERE action = 'cloudflare_plan'").n, 1);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM support_operator_execution_locks").n, 0);
  });
});

test("topic style: command and panel navigate, paginate, persist independently and reset", async () => {
  await withFixture(styleTelegram, async ({ env, db, calls }) => {
    let id = 60000;
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(id++, 1, "/users")), env)).status, 200);
    await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(id++, 1, "um:n:settings")), env);
    await styleClick(env, calls, id++, b => b.callback_data.startsWith("um:s:home:"));
    await styleClick(env, calls, id++, b => b.text === "Folder Links");
    const home = styleButtons(calls).find(b => b.callback_data.includes(":colors:"))?.callback_data.replace(":colors:", ":home:");
    assert.ok(home);
    await styleClick(env, calls, id++, b => b.callback_data.includes(":colors:"));
    assert.equal(styleButtons(calls).filter(b => /:color:.*:\d+$/.test(b.callback_data)).length, 6);
    const chosen = await styleClick(env, calls, id++, b => b.callback_data.endsWith(":7322096"));
    const savedAt = db.get("SELECT updated_at FROM topic_style_settings").updated_at;
    await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(id++, 1, chosen)), env);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM operator_audit WHERE action='topic_style_color'").n, 1);
    assert.equal(db.get("SELECT updated_at FROM topic_style_settings").updated_at, savedAt);
    await styleClick(env, calls, id++, b => b.callback_data.includes(":icons:"));
    const page = calls.filter(c => c.method === "editMessageText").at(-1).body.reply_markup.inline_keyboard;
    assert.deepEqual(page.slice(0,4).map(row => row.length), [6,6,6,6]);
    await styleClick(env, calls, id++, b => b.text === "→");
    const iconId = styleCatalogue[24].custom_emoji_id;
    await styleClick(env, calls, id++, b => b.callback_data.endsWith(":" + iconId));
    assert.equal(calls.filter(c => c.method === "getForumTopicIconStickers").length, 3);
    let style = db.get("SELECT * FROM topic_style_settings WHERE bot_id='folder-links'");
    assert.equal(style.icon_color, 7322096);
    assert.equal(style.icon_custom_emoji_id, iconId);
    assert.equal(style.updated_by, 7);
    assert.equal((await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(id++, 1, "/topicstyle image-compress")), env)).status, 200);
    await styleClick(env, calls, id++, b => b.callback_data.includes(":colors:"));
    await styleClick(env, calls, id++, b => b.callback_data.endsWith(":16766590"));
    assert.equal(db.get("SELECT icon_color FROM topic_style_settings WHERE bot_id='folder-links'").icon_color, 7322096);
    await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(id++, 1, home)), env);
    await styleClick(env, calls, id++, b => b.callback_data.includes(":icons:"));
    await styleClick(env, calls, id++, b => b.callback_data.endsWith(":default"));
    style = db.get("SELECT * FROM topic_style_settings WHERE bot_id='folder-links'");
    assert.equal(style.icon_color, 7322096);
    assert.equal(style.icon_custom_emoji_id, null);
    await styleClick(env, calls, id++, b => b.callback_data.includes(":reset:"));
    assert.equal(db.get("SELECT icon_color FROM topic_style_settings WHERE bot_id='folder-links'").icon_color, null);
    assert.equal(calls.some(c => c.method === "editForumTopic"), false);
  });
});

test("topic style: ownership, General and malformed callback validation", async () => {
  await withFixture(styleTelegram, async ({ env, db, calls }) => {
    seedOperator(db, 8);
    seedConversation(db, "folder-links", 60100, 601);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(60101, 1, "/topicstyle folder-links")), env);
    const colors = styleButtons(calls).find(b => b.callback_data.includes(":colors:")).callback_data;
    const set = colors.replace(":colors:", ":color:") + ":7322096";
    for (const [id, thread, data, actor] of [[60102,1,set,8], [60103,601,set,7], [60104,1,set.replace('7322096','42'),7], [60105,1,'um:s:color:unknown:7322096',7], [60106,1,set+':extra',7]]) {
      await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(id,thread,data,actor)), env);
    }
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(60107, 1, "/topicstyle",8)), env);
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(60108, 601, "/topicstyle")), env);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM topic_style_settings").n, 0);
    assert.equal(calls.some(c => c.method === "getForumTopicIconStickers"), false);
  });
});

test("topic style: catalogue failure, stale IDs and atomic audit failure preserve settings", async () => {
  let unavailable = true;
  await withFixture(call => call.method === "getForumTopicIconStickers" ? (unavailable ? { ok:false,error_code:503,description:'unavailable' } : styleTelegram(call)) : null, async ({ env,db,calls }) => {
    await worker.fetch(webhookRequest("folder-links", "secret-a", groupUpdate(60200,1,"/topicstyle folder-links")),env);
    const icons = styleButtons(calls).find(b => b.callback_data.includes(':icons:')).callback_data;
    const colors = styleButtons(calls).find(b => b.callback_data.includes(':colors:')).callback_data;
    await styleClick(env,calls,60201,b=>b.callback_data===icons);
    assert.ok(styleButtons(calls).some(b=>b.text==='Retry loading'));
    unavailable = false;
    await styleClick(env,calls,60202,b=>b.text==='Retry loading');
    const icon = styleButtons(calls).find(b=>b.callback_data.includes(':icon:')).callback_data;
    await worker.fetch(webhookRequest("folder-links","secret-a",callbackUpdate(60203,1,icon.replace(/:[0-9]+$/,':999'))),env);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM topic_style_settings").n,0);
    db.failOnce("INSERT INTO operator_audit");
    const change=callbackUpdate(60204,1,colors.replace(':colors:',':color:')+':7322096');
    assert.equal((await worker.fetch(webhookRequest("folder-links","secret-a",change),env)).status,500);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM topic_style_settings").n,0);
    assert.equal((await worker.fetch(webhookRequest("folder-links","secret-a",change),env)).status,200);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM operator_audit WHERE action='topic_style_color'").n,1);
    assert.equal((await worker.fetch(webhookRequest("folder-links","secret-a",change),env)).status,200);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM operator_audit WHERE action='topic_style_color'").n,1);
  });
});

for (const uncertain of [false,true]) test('topic style: creation preserves external-effect handling, uncertain='+uncertain, async()=>{
  let fail = true;
  await withFixture(call => call.method==='createForumTopic' && fail ? (uncertain ? {ok:false,error_code:500,description:'unknown'} : {ok:false,error_code:400,description:'invalid icon'}) : null, async({env,db,calls})=>{
    db.run("INSERT INTO topic_style_settings (bot_id,icon_color,icon_custom_emoji_id,updated_at,updated_by) VALUES ('folder-links',7322096,'5000000000000000000',?,7)",new Date().toISOString());
    const update=privateUpdate(60300,60300);
    await worker.fetch(webhookRequest('folder-links','secret-a',update),env);
    assert.equal(calls.filter(c=>c.method==='createForumTopic').length,1);
    assert.equal(calls.find(c=>c.method==='createForumTopic').body.icon_color,7322096);
    assert.equal(calls.find(c=>c.method==='createForumTopic').body.icon_custom_emoji_id,'5000000000000000000');
    fail=false;
    await worker.fetch(webhookRequest('folder-links','secret-a',update),env);
    assert.equal(calls.filter(c=>c.method==='createForumTopic').length,uncertain?1:2);
  });
});

test('topic style: existing conversations do not read settings and recreation uses latest settings',async()=>{
  await withFixture(null,async({env,db,calls})=>{
    seedConversation(db,'folder-links',60400,604);
    db.run("INSERT INTO topic_style_settings (bot_id,icon_color,updated_at,updated_by) VALUES ('folder-links',16766590,?,7)",new Date().toISOString());
    const scope={queries:0,sqls:[],limit:1000};
    await recoveryQueryScope.run(scope,()=>worker.fetch(webhookRequest('folder-links','secret-a',privateUpdate(60401,60400)),env));
    assert.equal(scope.sqls.some(sql=>sql.includes('topic_style_settings')),false);
    db.run("UPDATE conversations SET status='closed' WHERE user_id=60400");
    await worker.fetch(webhookRequest('folder-links','secret-a',privateUpdate(60402,60400)),env);
    assert.equal(calls.some(c=>c.method==='createForumTopic'||c.method==='editForumTopic'),false);
    db.run("DELETE FROM conversations WHERE user_id=60400");
    await worker.fetch(webhookRequest('folder-links','secret-a',privateUpdate(60403,60400)),env);
    assert.equal(calls.find(c=>c.method==='createForumTopic').body.icon_color,16766590);
  });
});


test('topic style: Russian UI and settings survive a fresh Worker module', async()=>{
  await withFixture(styleTelegram,async({env,db,calls})=>{
    env.BOT_REGISTRY=JSON.stringify(registryValue.map(item=>({...item,locale:'ru'})));
    await worker.fetch(webhookRequest('folder-links','secret-a',groupUpdate(60500,1,'/topicstyle')),env);
    assert.match(calls.at(-1).body.text,/Выберите бота/);
    await styleClick(env,calls,60501,b=>b.text==='Folder Links');
    await styleClick(env,calls,60502,b=>b.text==='Цвет');
    await styleClick(env,calls,60503,b=>b.callback_data.endsWith(':9367192'));
    assert.match(calls.at(-1).body.text,/Зелёный/);
    const fresh = (await import('../src/worker.js?topic-style-cold-start')).default;
    assert.equal((await fresh.fetch(webhookRequest('folder-links','secret-a',privateUpdate(60504,60504)),env)).status,200);
    assert.equal(calls.find(c=>c.method==='createForumTopic').body.icon_color,9367192);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM operator_audit WHERE action='topic_style_color'").n,1);
  });
});

test('topic style: catalogue reorder selects the same ID and screen failure does not duplicate audit',async()=>{
  let reverse=false, failScreen=false;
  await withFixture(call=>{
    if(call.method==='getForumTopicIconStickers') return {ok:true,result:reverse?[...styleCatalogue].reverse():styleCatalogue};
    if(call.method==='editMessageText'&&failScreen) return {ok:false,error_code:503,description:'unavailable'};
  },async({env,db,calls})=>{
    await worker.fetch(webhookRequest('folder-links','secret-a',groupUpdate(60600,1,'/topicstyle folder-links')),env);
    await styleClick(env,calls,60601,b=>b.callback_data.includes(':icons:'));
    const chosen=styleButtons(calls).find(b=>b.callback_data.endsWith(':'+styleCatalogue[0].custom_emoji_id)).callback_data;
    reverse=true;failScreen=true;
    const update=callbackUpdate(60602,1,chosen);
    assert.equal((await worker.fetch(webhookRequest('folder-links','secret-a',update),env)).status,500);
    assert.equal(db.get('SELECT icon_custom_emoji_id FROM topic_style_settings').icon_custom_emoji_id,styleCatalogue[0].custom_emoji_id);
    failScreen=false;
    assert.equal((await worker.fetch(webhookRequest('folder-links','secret-a',update),env)).status,200);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM operator_audit WHERE action='topic_style_icon'").n,1);
  });
});

test('topic style: busy execution lock prevents save and audit, same update retries',async()=>{
  await withFixture(null,async({env,db,calls})=>{
    await worker.fetch(webhookRequest('folder-links','secret-a',groupUpdate(60700,1,'/topicstyle folder-links')),env);
    const data=styleButtons(calls).find(b=>b.callback_data.includes(':colors:')).callback_data.replace(':colors:',':color:')+':7322096';
    db.run("INSERT INTO support_operator_execution_locks (operator_id,owner_token,lease_expires_at,created_at) VALUES (7,'holder',?,?)",new Date(Date.now()+60000).toISOString(),new Date().toISOString());
    const update=callbackUpdate(60701,1,data);
    assert.equal((await worker.fetch(webhookRequest('folder-links','secret-a',update),env)).status,500);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM topic_style_settings').n,0);
    db.run("DELETE FROM support_operator_execution_locks WHERE owner_token='holder'");
    assert.equal((await worker.fetch(webhookRequest('folder-links','secret-a',update),env)).status,200);
    assert.equal(db.get('SELECT icon_color FROM topic_style_settings').icon_color,7322096);
  });
});

test('topic style: D1 read failure happens before request-start; defaults omit icon parameters',async()=>{
  await withFixture(null,async({env,db,calls})=>{
    db.failOnce('SELECT icon_color, icon_custom_emoji_id FROM topic_style_settings');
    const update=privateUpdate(60800,60800);
    assert.equal((await worker.fetch(webhookRequest('folder-links','secret-a',update),env)).status,500);
    assert.equal(calls.some(c=>c.method==='createForumTopic'),false);
    const attempt=db.get("SELECT request_started_at FROM conversation_provision_attempts WHERE user_id=60800");
    assert.equal(attempt.request_started_at,null);
    db.run("UPDATE conversation_provision_attempts SET started_at=? WHERE user_id=60800",new Date(Date.now()-120000).toISOString());
    assert.equal((await worker.fetch(webhookRequest('folder-links','secret-a',update),env)).status,200);
    const body=calls.find(c=>c.method==='createForumTopic').body;
    assert.equal(Object.hasOwn(body,'icon_color'),false);
    assert.equal(Object.hasOwn(body,'icon_custom_emoji_id'),false);
  });
});


for (const plan of ['free','paid']) test('topic style: recovery creates styled Topics within '+plan+' budget',async()=>{
  await withFixture(null,async({env,db,calls})=>{
    env.RECOVERY_D1_PLAN=plan;
    const now=new Date().toISOString();
    db.run("INSERT INTO topic_style_settings (bot_id,icon_color,icon_custom_emoji_id,updated_at,updated_by) VALUES ('folder-links',13338331,'5000000000000000000',?,7)",now);
    db.run("INSERT INTO user_abuse_state (bot_id,user_id,pending_release_required,created_at,updated_at) VALUES ('folder-links',60900,1,?,?)",now,now);
    db.run("INSERT INTO pending_messages (bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES ('folder-links',60900,60900,60900,60900,?)",now);
    for(let i=0;i<35&&!db.get('SELECT delivered_at FROM pending_messages WHERE user_id=60900').delivered_at;i++){
      const scope={queries:0,limit:plan==='free'?50:1000};
      await recoveryQueryScope.run(scope,()=>worker.scheduled({},env,null));
      assert.ok(scope.queries<=(plan==='free'?45:905));
    }
    assert.ok(db.get('SELECT delivered_at FROM pending_messages WHERE user_id=60900').delivered_at);
    const creates=calls.filter(c=>c.method==='createForumTopic');
    assert.equal(creates.length,1);
    assert.equal(creates[0].body.icon_color,13338331);
    assert.equal(creates[0].body.icon_custom_emoji_id,'5000000000000000000');
  });
});

test("review regression: management callbacks keep their service after registry reorder", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    for (const [bot, secret] of [["folder-links", "secret-a"], ["image-compress", "secret-b"]]) {
      await ingress.fetch(webhookRequest(bot, secret, privateUpdate(61000, 61000)), env);
    }
    const key = managementBotKey(registryValue, "folder-links");
    await ingress.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(61001, 1, `um:g:card:${key}:61000`)), env);
    const card = calls.filter((call) => ["sendMessage", "editMessageText"].includes(call.method)).at(-1);
    const trust = card.body.reply_markup.inline_keyboard.flat().find((button) => button.callback_data?.includes(":trust:"));
    assert.match(card.body.text, /Folder Links/);
    env.BOT_REGISTRY = JSON.stringify(JSON.parse(env.BOT_REGISTRY).reverse());
    assert.equal((await ingress.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(61002, 1, trust.callback_data)), env)).status, 200);
    assert.equal((await ingress.fetch(webhookRequest("folder-links","secret-a",callbackUpdate(9161002,1,pendingActionCallback(db))),env)).status,200);
    assert.equal(db.get("SELECT manual_trust FROM user_abuse_state WHERE bot_id = 'folder-links' AND user_id = 61000").manual_trust, 1);
    assert.equal(db.get("SELECT manual_trust FROM user_abuse_state WHERE bot_id = 'image-compress' AND user_id = 61000").manual_trust, 0);
    // The same action on a pre-upgrade positional keyboard must be rejected.
    await ingress.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(61003, 1, trust.callback_data.replace(key, "0"))), env);
    assert.equal(db.get("SELECT manual_trust FROM user_abuse_state WHERE bot_id = 'image-compress' AND user_id = 61000").manual_trust, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM operator_audit WHERE action = 'manual_trust'").n, 1);
  });
});

test("review regression: the eleventh bot is selectable and long ids fit callback_data", async () => {
  await withFixture(null, async ({ env, calls }) => {
    const registry = [...registryValue];
    for (let index = 2; index < 11; index++) registry.push({
      ...registryValue[1], id: `extra-${index}`, displayName: `Extra ${index}`,
      tokenBinding: `TOKEN_${index}`, webhookSecretBinding: `SECRET_${index}`,
    });
    env.BOT_REGISTRY = JSON.stringify(registry);
    const key = managementBotKey(registry, "extra-10");
    assert.notEqual(key, "a");
    await worker.fetch(webhookRequest("folder-links", "secret-a", callbackUpdate(61100, 1, `um:s:home:${key}`)), env);
    assert.match(calls.find((call) => ["sendMessage", "editMessageText"].includes(call.method)).body.text, /Extra 10 · Topic appearance/);
    for (const legacy of ["0", "1", "a", "0junk"]) assert.equal(managementBotFromKey(registry, legacy), null);
    assert.equal(managementBotFromKey(registry.slice(0, 10), key), null);
    const longRegistry = [{ id: "x".repeat(64) }];
    const longKey = managementBotKey(longRegistry, longRegistry[0].id);
    assert.ok(Buffer.byteLength(`um:g:act:unrestrict:${longKey}:9007199254740991:1234567`) <= 64);
    assert.ok(Buffer.byteLength(`um:s:icon:${longKey}:12345678901234567890`) <= 64);
  });
});

function seedReviewAlbum(db, { prepared = false, requested = false, active = false, direction = "user_to_support" } = {}) {
  seedConversation(db, "folder-links", 61200, 612);
  const outgoing = direction === "support_to_user";
  const sourceChat = outgoing ? -1001234567890 : 61200;
  const targetChat = outgoing ? 61200 : -1001234567890;
  const received = Date.now() - 120_000;
  const claim = active ? Date.now() : received;
  const stamp = new Date(claim).toISOString();
  db.run(`INSERT INTO media_groups (bot_id, direction, media_group_id, source_chat_id, target_chat_id,
    thread_id, user_id, operator_id, last_received_at, version, claimed_at, claimed_version, created_at, delivery_started_at, request_started_at)
    VALUES ('folder-links', ?, 'review-album', ?, ?, 612, 61200, ?, ?, 1, ?, ?, ?, ?, ?)`,
  direction, sourceChat, targetChat, outgoing ? 7 : null, received, prepared ? claim : null, prepared ? 1 : null, stamp, prepared ? stamp : null, requested ? stamp : null);
  for (let index = 0; index < 10; index++) db.run(`INSERT INTO media_group_items
    (bot_id, direction, media_group_id, source_chat_id, message_id, media_type, file_id, caption, received_at, delivery_attempt_started_at)
    VALUES ('folder-links', ?, 'review-album', ?, ?, 'photo', ?, '', ?, ?)`,
  direction, sourceChat, 61200 + index, `review-file-${index}`, received, prepared ? stamp : null);
}

for (const direction of ["user_to_support", "support_to_user"]) test(`review regression: recovery resumes a ${direction} album after yielding before HTTP`, async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedReviewAlbum(db, { direction });
    // Start in maintenance so the album first encounters a partially spent budget.
    db.run("INSERT INTO recovery_scheduler (id, next_job) VALUES (1, 33)");
    for (let index = 0; index < 12; index++) await runCountedRecovery({}, env);
    assert.equal(calls.filter((call) => call.method === "sendMediaGroup").length, 1);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM media_group_items").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM media_groups").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_mappings WHERE user_id = 61200").n, 10);
  });
});

for (const requested of [false, true]) test(`review regression: cron reconciles an interrupted album, HTTP started=${requested}`, async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedReviewAlbum(db, { prepared: true, requested });
    for (let index = 0; index < 12; index++) await runCountedRecovery({}, env);
    assert.equal(calls.filter((call) => call.method === "sendMediaGroup").length, requested ? 0 : 1);
    if (requested) {
      assert.equal(db.get("SELECT COUNT(*) AS n FROM media_group_items WHERE delivery_uncertain_at IS NOT NULL").n, 10);
      assert.equal(calls.filter((call) => call.body.text?.includes("Album delivery outcome unknown")).length, 1);
    } else assert.equal(db.get("SELECT COUNT(*) AS n FROM media_groups").n, 0);
  });
});

test("review regression: cron does not quarantine an album whose claim is still active", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedReviewAlbum(db, { prepared: true, requested: true, active: true });
    for (let index = 0; index < 12; index++) await runCountedRecovery({}, env);
    assert.equal(calls.filter(call => call.method === "sendMediaGroup" || (call.method === "sendMessage" && String(call.body.text).startsWith("⚠️"))).length, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM media_group_items WHERE delivery_uncertain_at IS NOT NULL").n, 0);
    assert.ok(db.get("SELECT request_started_at FROM media_groups").request_started_at);
  });
});

test("review regression: cron alerts on interrupted Topic and single-message requests without a webhook retry", async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const fresh = new Date().toISOString();
    for (const [user, stamp] of [[61300, old], [61301, fresh]]) {
      db.run("INSERT INTO conversation_provision_attempts (bot_id, user_id, started_at, request_started_at) VALUES ('folder-links', ?, ?, ?)", user, stamp, stamp);
      db.run(`INSERT INTO message_delivery_attempts (bot_id, direction, source_chat_id, source_message_id,
        user_id, thread_id, target_chat_id, method, started_at, request_started_at)
        VALUES ('folder-links', 'user_to_support', ?, ?, ?, 613, -1001234567890, 'forwardMessage', ?, ?)`, user, user, user, stamp, stamp);
    }
    for (let index = 0; index < 12; index++) await runCountedRecovery({}, env);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && String(call.body.text).startsWith("⚠️")).length, 2);
    for (const table of ["conversation_provision_attempts", "message_delivery_attempts"]) {
      assert.ok(db.get(`SELECT failure_code, alerted_at FROM ${table} WHERE user_id = 61300`).alerted_at);
      assert.equal(db.get(`SELECT failure_code FROM ${table} WHERE user_id = 61301`).failure_code, null);
    }
    const response = await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(61302, 61300)), env);
    assert.equal(response.status, 200);
    assert.equal(calls.some((call) => ["createForumTopic", "forwardMessage"].includes(call.method)), false);
  });
});

test("review regression: Telegram body timeout releases the user lock without replaying delivery", { timeout: 2000 }, async () => {
  await withFixture(null, async ({ env, db }) => {
    env.TELEGRAM_TIMEOUT_MS = "20";
    const originalFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = (url, init) => {
      if (String(url).endsWith("/forwardMessage")) {
        sends++;
        return Promise.resolve(stalledJsonResponse(init.signal));
      }
      return originalFetch(url, init);
    };
    const request = () => webhookRequest("folder-links", "secret-a", privateUpdate(61400, 61400));
    assert.equal((await worker.fetch(request(), env)).status, 200);
    assert.equal((await worker.fetch(request(), env)).status, 200);
    assert.equal(sends, 1);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM abuse_decision_locks").n, 0);
    assert.equal(db.get("SELECT failure_code FROM message_delivery_attempts WHERE user_id = 61400").failure_code, "telegram_delivery_outcome_unknown");
  });
});

async function countedFreeFetch(ingress, request, env) {
  const scope = { queries: 0, limit: 50 };
  const response = await recoveryQueryScope.run(scope, () => ingress.fetch(request, env));
  assert.ok(scope.queries <= 50, `Webhook used ${scope.queries} D1 statements`);
  return response;
}

for (const urls of [0, 1, 30]) test(`Free ingress: cold and warm new users with ${urls} URLs complete and release locks`, async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = "free";
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    for (const user of [62000, 62001]) {
      const update = privateUpdate(user, user);
      update.message.text += Array.from({ length: urls }, (_, index) => ` https://example.com/${index}`).join("");
      const request = () => webhookRequest("folder-links", "secret-a", update);
      assert.equal((await countedFreeFetch(ingress, request(), env)).status, 200);
      assert.equal(db.get("SELECT state FROM processed_updates WHERE update_id = ?", user).state, "completed");
      assert.equal(db.get("SELECT COUNT(*) AS n FROM abuse_decision_locks").n, 0);
      assert.equal((await countedFreeFetch(ingress, request(), env)).status, 200);
    }
    assert.equal(calls.filter((call) => call.method === "forwardMessage").length, 2);
  });
});

test("deleted Topic: live TOPIC_ID_INVALID recovers the primary administrator's persisted reopen queue on Free", async () => {
  await withFixture(call => {
    if (call.body.message_thread_id === 21) return { ok: false, error_code: 400, description: "Bad Request: TOPIC_ID_INVALID" };
  }, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = "free";
    env.TELEGRAM_COOLDOWN_ENABLED = "true";
    env.OPERATIONAL_HEALTH_ENABLED = "true";
    env.RETENTION_ENABLED = "true";
    env.STORAGE_GUARD_ENABLED = "true";
    env.BOT_REGISTRY = JSON.stringify([registryValue[0]]);
    seedConversation(db, "folder-links", 7, 21);
    db.run("UPDATE conversations SET status='closed' WHERE user_id=7");
    db.run("INSERT INTO conversation_reopen_effects(bot_id,user_id,old_thread_id,created_at) VALUES('folder-links',7,21,?)", new Date().toISOString());
    db.run("INSERT INTO reopen_business_messages(bot_id,user_id,update_id,source_chat_id,source_message_id,created_at) VALUES('folder-links',7,977455440,7,8,?)", new Date().toISOString());
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const retry = () => countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", privateUpdate(977455440, 7, 8)), env);
    const first = await retry();
    assert.ok([200, 503].includes(first.status));
    for (let i = 0; i < 70 && !db.get("SELECT completed_at FROM conversation_reopen_effects").completed_at; i++) await runCountedRecovery({}, env);
    assert.equal((await retry()).status, 200);
    assert.equal(db.get("SELECT thread_id FROM conversations WHERE user_id=7").thread_id, 51);
    assert.ok(db.get("SELECT completed_at FROM conversation_reopen_effects").completed_at);
    assert.equal(db.get("SELECT recreated FROM conversation_reopen_effects").recreated, 1);
    assert.equal(db.get("SELECT COUNT(*) n FROM operator_audit WHERE action='conversation_topic_restored'").n, 1);
    assert.ok(db.get("SELECT delivered_at FROM reopen_business_messages WHERE source_message_id=8").delivered_at);
    assert.equal(calls.filter(call => call.method === "createForumTopic").length, 1);
    assert.equal(calls.filter(call => call.method === "copyMessage" && call.body.message_id === 8 && call.body.message_thread_id === 51).length, 1);
    const next = () => countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", privateUpdate(977455441, 7, 9)), env);
    for (let i = 0; i < 5; i++) if ((await next()).status === 200) break;
    assert.equal(db.get("SELECT thread_id FROM message_mappings WHERE user_message_id=9").thread_id, 51);
  });
});

test("Topic invalidation recognizes Telegram's exact invalid ID code, not access or generic message errors", () => {
  for (const description of ["Bad Request: TOPIC_ID_INVALID", "Bad Request: topic_id_invalid", "Bad Request: message thread not found", "Bad Request: TOPIC_DELETED"]) assert.equal(isMissingTopicError(description), true, description);
  for (const description of ["Bad Request: CHAT_ID_INVALID", "Bad Request: MESSAGE_ID_INVALID", "Forbidden: bot is not a member of the supergroup chat", "Bad Request: not enough rights", "Internal Server Error", "Bad Request: TOPIC_CLOSED", "Bad Request: XTOPIC_ID_INVALID"]) assert.equal(isMissingTopicError(description), false, description);
});

test("Free ingress: a closed Topic yields, recovers and accepts replay without duplicate delivery", async () => {
  await withFixture(null, async ({ env, db, calls, fetchMock }) => {
    env.RECOVERY_D1_PLAN = "free";
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    seedConversation(db, "folder-links", 62100, 621);
    db.run("UPDATE conversations SET status = 'closed' WHERE user_id = 62100");
    const request = () => webhookRequest("folder-links", "secret-a", privateUpdate(62100, 62100));
    assert.equal((await countedFreeFetch(ingress, request(), env)).status, 503);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM abuse_decision_locks").n, 0);
    for (let index = 0; index < 35; index++) await runCountedRecovery({}, env);
    assert.equal((await countedFreeFetch(ingress, request(), env)).status, 200);
    assert.equal(db.get("SELECT status FROM conversations WHERE user_id = 62100").status, "open");
    assert.equal(calls.filter((call) => call.method === "reopenForumTopic").length, 1);
    assert.equal(calls.filter((call) => call.method === "copyMessage" && call.body.message_id === 62100).length, 1);
  });
});

test("Free verification: passing a ten-message queue succeeds and Cron finishes every message", async (t) => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.RECOVERY_D1_PLAN = "free";
    env.TURNSTILE_SITE_KEY = "site";
    env.TURNSTILE_SECRET_KEY = "secret";
    env.BOT_REGISTRY = JSON.stringify(registryValue.map((bot) => ({ ...bot, verification_mode: "always" })));
    for (let index = 0; index < 10; index++) {
      const update = privateUpdate(62200 + index, 62200);
      update.message.text = `Question ${index}`;
      assert.equal((await countedFreeFetch(worker, webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    }
    const response = await countedFreeFetch(worker, new Request(`https://support.example.workers.dev/verify/${verificationToken(calls)}`, {
      method: "POST", body: new URLSearchParams({ "cf-turnstile-response": "passed" }),
    }), env);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Verification passed/);
    // Fair recovery yields to other queues even when this one still has work.
    let turns = 0;
    for (; turns < 90 && db.get("SELECT COUNT(*) AS n FROM pending_messages WHERE delivered_at IS NULL").n; turns++) {
      await runCountedRecovery({}, env);
    }
    t.diagnostic(`Verified queue drained after ${turns} fair recovery invocations`);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM pending_messages WHERE delivered_at IS NOT NULL AND failure_code IS NULL").n, 10);
    assert.equal(new Set(calls.filter((call) => call.method === "copyMessage").map((call) => call.body.message_id)).size, 10);
    assert.equal(calls.filter((call) => call.method === "copyMessage").length, 10);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM pending_flush_locks").n, 0);
  });
});

for (const command of ["/ban 42 reason", "/restrict 42 1h", "/trust 42", "/untrust 42", "/riskreset 42"]) {
  test(`Free General ingress: ${command} shares routing and action budget`, async () => {
    await withFixture(null, async ({ env, db, calls, fetchMock }) => {
      env.RECOVERY_D1_PLAN = "free";
      env.GENERAL_OWNER_GRACE_MS = "0";
      const ingress = createControlPlaneWorker(undefined, fetchMock);
      assert.equal((await countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", privateUpdate(62300, 42)), env)).status, 200);
      assert.equal((await countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", groupUpdate(62301, 1, command)), env)).status, 200);
      if (["/ban","/restrict","/trust","/riskreset"].some(prefix=>command.startsWith(prefix))) {
        assert.equal((await countedFreeFetch(ingress, webhookRequest("folder-links", "secret-a", callbackUpdate(62302, 1, pendingActionCallback(db))), env)).status, 200);
      }
      const state = db.get("SELECT * FROM user_abuse_state WHERE user_id = 42");
      if (command.startsWith("/trust")) assert.equal(state.manual_trust, 1);
      if (command.startsWith("/untrust")) assert.equal(state.manual_trust, 0);
      if (command.startsWith("/restrict")) assert.ok(state.manual_restricted_until);
      if (command.startsWith("/ban")) assert.ok(db.get("SELECT user_id FROM banned_users WHERE user_id = 42"));
      assert.equal(db.get("SELECT COUNT(*) AS n FROM support_operator_execution_locks").n, 0);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM general_message_claims WHERE completed_at IS NULL").n, 0);
      assert.equal(calls.filter((call) => call.method === "forwardMessage").length, 1);
    });
  });
}

for (const operational of [false, true]) for (const direction of ["user", "support"]) test(`Free ingress: ${direction} album survives deferred delivery and webhook retries${operational ? ' with operational features' : ''}`, async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.RECOVERY_D1_PLAN = "free";
    if (operational) Object.assign(env, { RETENTION_ENABLED: 'true', STORAGE_GUARD_ENABLED: 'true', TELEGRAM_COOLDOWN_ENABLED: 'true', OPERATIONAL_HEALTH_ENABLED: 'true' });
    seedConversation(db, "folder-links", 62400, 624);
    // A late retry may arrive after an earlier part has already flushed.
    for (let index = 0; index < 10; index++) {
      const update = direction === "user" ? privateUpdate(62400 + index, 62400) : groupUpdate(62400 + index, 624, "");
      delete update.message.text;
      update.message.media_group_id = `free-${direction}-album`;
      update.message.photo = [{ file_id: `photo-${index}` }];
      const result = await countedFreeFetch(worker, webhookRequest("folder-links", "secret-a", update), env);
      assert.ok([200, 503].includes(result.status), `Unexpected status ${result.status}`);
      for (let turn = 0; turn < 12; turn++) await runCountedRecovery({}, env);
      assert.equal((await countedFreeFetch(worker, webhookRequest("folder-links", "secret-a", update), env)).status, 200);
    }
    for (let turn = 0; turn < 12; turn++) await runCountedRecovery({}, env);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_mappings WHERE user_id = 62400").n, 10,
      JSON.stringify(db.all('SELECT user_message_id, support_message_id FROM message_mappings WHERE user_id = 62400')));
    assert.equal(db.get("SELECT COUNT(*) AS n FROM media_group_items WHERE delivery_uncertain_at IS NOT NULL").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM media_groups").n, 0);
    assert.equal(calls.filter((call) => call.method === "copyMessage").length, 10);
  });
});

for (const [plan, work, total] of [["free", 44, 50], ["paid", 990, 1000]]) {
  for (const outcome of ['success', 'already-missing', 'partial']) {
    test(`${plan} /delete budget boundaries retain retryability and release locks (${outcome})`, async t => {
      let peak = 0;
      for (let remaining = 0; remaining <= 44; remaining++) {
        let retry = false;
        await withFixture(call => {
          if (call.method !== 'deleteMessage') return null;
          if (outcome === 'already-missing') return { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' };
          if (outcome === 'partial' && !retry && call.body.chat_id < 0) return { ok: false, error_code: 503, description: 'Temporary failure' };
        }, async ({ env, db, calls, fetchMock }) => {
          Object.assign(env, { RECOVERY_D1_PLAN: plan, TELEGRAM_COOLDOWN_ENABLED: 'true',
            OPERATIONAL_HEALTH_ENABLED: 'true', RETENTION_ENABLED: 'true', STORAGE_GUARD_ENABLED: 'true' });
          seedConversation(db, 'folder-links', 88007, 87);
          db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',88007,87,105,205,?)", new Date().toISOString());
          const ingress = createControlPlaneWorker(undefined, fetchMock);
          const command = groupUpdate(880070, 87, '/delete');
          command.message.reply_to_message = { message_id: 205, from: { id: 7 } };
          const request = () => webhookRequest('folder-links', 'secret-a', command);
          const budget = createWebhookDatabase(db, plan);
          Object.assign(budget, { telegramCooldownEnabled: true, telegramCooldowns: {}, storageGeneration: 0 });
          const scope = { queries: 0, limit: total };
          await recoveryQueryScope.run(scope, async () => {
            for (let index = 0; index < work - remaining; index++) await budget.prepare('SELECT 1').all();
            await ingress.fetch(request(), { ...env, SUPPORT_DB: budget });
          });
          peak = Math.max(peak, scope.queries - (work - remaining));
          assert.ok(scope.queries <= total);
          assert.equal(db.get('SELECT COUNT(*) n FROM support_operator_execution_locks').n, 0, `Leaked operator lock with ${remaining} slots`);
          assert.equal(db.get("SELECT COUNT(*) n FROM processed_updates WHERE state='processing'").n, 0);
          retry = true;
          if (db.get("SELECT state FROM processed_updates WHERE update_id=?", command.update_id)?.state === 'completed'
            && !db.get("SELECT id FROM operator_audit WHERE action='message_delete' AND result='success'")) {
            command.update_id++; command.message.message_id++;
          }
          const retryScope = { queries: 0, limit: total };
          assert.equal((await recoveryQueryScope.run(retryScope, () => ingress.fetch(request(), env))).status, 200);
          assert.equal(db.get("SELECT COUNT(*) n FROM operator_audit WHERE action='message_delete' AND result='success'").n, 1);
          assert.equal(db.get('SELECT COUNT(*) n FROM telegram_cleanup_jobs').n, 0);
          assert.equal(calls.filter(c => c.method === 'copyMessage').length, 0);
        });
      }
      t.diagnostic(`Deletion used at most ${peak} D1 statements beyond the prefilled budget`);
    });
  }

  test(`${plan} budget boundaries: private delivery releases every acquired guard and retries immediately`, async () => {
    for (let remaining = 0; remaining <= 44; remaining++) await withFixture(null, async ({ env, db, calls, fetchMock }) => {
      env.RECOVERY_D1_PLAN = plan;
      const ingress = createControlPlaneWorker(undefined, fetchMock);
      const budget = createWebhookDatabase(db, plan);
      const scope = { queries: 0, limit: total };
      const request = () => webhookRequest("folder-links", "secret-a", privateUpdate(63100, 63100));
      await recoveryQueryScope.run(scope, async () => {
        for (let index = 0; index < work - remaining; index++) await budget.prepare("SELECT 1").all();
        await ingress.fetch(request(), { ...env, SUPPORT_DB: budget });
      });
      assert.ok(scope.queries <= total);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM logical_message_guards WHERE owner_token IS NOT NULL").n, 0, `Leaked guard with ${remaining} slots left`);
      for (const table of ["abuse_decision_locks", "conversation_locks"]) assert.equal(db.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0);
      const retryScope = { queries: 0, limit: total };
      const retried = await recoveryQueryScope.run(retryScope, () => ingress.fetch(request(), env));
      assert.equal(retried.status, 200, `Retry failed with ${remaining} slots originally left`);
      assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
      assert.equal(calls.filter((call) => call.method === "forwardMessage").length, 1);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM message_delivery_attempts WHERE failure_code IS NOT NULL").n, 0);
    });
  });

  test(`${plan} budget: a slow operator reply keeps its result reservation despite heartbeats`, async () => {
    await withFixture(async (call) => {
      if (call.method === "copyMessage") await new Promise((resolve) => setTimeout(resolve, 180));
    }, async ({ env, db, calls }) => {
      env.RECOVERY_D1_PLAN = plan;
      env.OPERATOR_EXECUTION_RENEW_MS = "20";
      seedConversation(db, "folder-links", 65000, 650);
      const budget = createWebhookDatabase(db, plan);
      const scope = { queries: 0, sqls: [], limit: total };
      const request = () => webhookRequest("folder-links", "secret-a", groupUpdate(65000, 650, "reply"));
      const first = await recoveryQueryScope.run(scope, async () => {
        for (let index = 0; index < work - 16; index++) await budget.prepare("SELECT 1").all();
        return worker.fetch(request(), { ...env, SUPPORT_DB: budget });
      });
      assert.ok([200, 503].includes(first.status));
      assert.ok(scope.queries <= total);
      assert.ok(scope.sqls.filter((sql) => sql.startsWith("UPDATE support_operator_execution_locks SET lease_expires_at")).length > 1);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM support_operator_execution_locks").n, 0);
      const attempt = db.get("SELECT * FROM message_delivery_attempts WHERE user_id = 65000");
      assert.ok(attempt.completed_at, "A known Telegram result must survive budget pressure");
      assert.equal(attempt.failure_code, null);
      const retryScope = { queries: 0, limit: total };
      assert.equal((await recoveryQueryScope.run(retryScope, () => worker.fetch(request(), env))).status, 200);
      assert.equal(calls.filter((call) => call.method === "copyMessage").length, 1);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM message_mappings WHERE user_id = 65000").n, 1);
    });
  });
}

for (const source of ["config", "general"]) test(`Paid verification reaches its own ceiling, switches to Free and finishes after switching back (${source})`, async (t) => {
  await withFixture(null, async ({ env, db, calls }) => {
    env.RECOVERY_D1_PLAN = "paid";
    env.TURNSTILE_SITE_KEY = "site";
    env.TURNSTILE_SECRET_KEY = "secret";
    env.BOT_REGISTRY = JSON.stringify(registryValue.map((bot) => ({ ...bot, verification_mode: "always", pending_message_limit: 60 })));
    await worker.fetch(webhookRequest("folder-links", "secret-a", privateUpdate(65100, 65100)), env);
    const challenge = db.get("SELECT id FROM verification_challenges");
    const url = `https://support.example.workers.dev/verify/${verificationToken(calls)}`;
    for (let index = 1; index < 60; index++) db.run(`INSERT INTO pending_messages
      (bot_id, user_id, update_id, source_chat_id, source_message_id, challenge_id, created_at)
      VALUES ('folder-links', 65100, ?, 65100, ?, ?, ?)`, 65100 + index, 65100 + index, challenge.id, new Date().toISOString());
    const counts = [];
    for (const [index, plan] of ["paid", "free", "paid"].entries()) {
      if (source === "general") {
        env.RECOVERY_D1_PLAN = plan === "free" ? "paid" : "free";
        db.run("UPDATE cloudflare_plan_settings SET plan = ?, revision = ?", plan, `test-${index}`);
      } else env.RECOVERY_D1_PLAN = plan;
      const scope = { queries: 0, limit: plan === "free" ? 50 : 1000 };
      const request = new Request(url, index === 0 ? { method: "POST", body: new URLSearchParams({ "cf-turnstile-response": "passed" }) } : {});
      const result = await recoveryQueryScope.run(scope, () => worker.fetch(request, env));
      assert.equal(result.status, 200);
      assert.ok(scope.queries <= scope.limit);
      counts.push(scope.queries);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM pending_flush_locks").n, 0);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM abuse_decision_locks").n, 0);
    }
    assert.ok(counts[0] > 900, `Paid unexpectedly capped at ${counts[0]}`);
    t.diagnostic(`Verification ${source} Paid/Free/Paid statements: ${counts.join("/")}`);
    assert.ok(counts[1] <= 50);
    assert.ok(counts[2] > 50);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM pending_messages WHERE delivered_at IS NOT NULL AND failure_code IS NULL").n, 60);
    assert.ok(db.get("SELECT flushed_at FROM verification_challenges WHERE id = ?", challenge.id).flushed_at);
    assert.equal(calls.filter((call) => call.method === "copyMessage").length, 60);
    assert.equal(new Set(calls.filter((call) => call.method === "copyMessage").map((call) => call.body.message_id)).size, 60);
  });
});

for (const source of ["config", "general"]) test(`Cron switches Free/Paid budgets on the same dense multi-bot backlog without losing progress (${source})`, async (t) => {
  await withFixture(null, async ({ env, db, calls }) => {
    const registry = [...registryValue];
    for (let index = 2; index < 4; index++) {
      registry.push({ ...registryValue[1], id: `extra-${index}`, tokenBinding: `TOKEN_${index}`, webhookSecretBinding: `SECRET_${index}` });
      env[`TOKEN_${index}`] = `token-${index}`;
      env[`SECRET_${index}`] = `secret-${index}`;
    }
    env.BOT_REGISTRY = JSON.stringify(registry);
    const now = new Date().toISOString();
    for (const bot of registry) for (let index = 0; index < 60; index++) {
      const user = 66000 + index;
      db.run(`INSERT INTO pending_messages (bot_id, user_id, update_id, source_chat_id, source_message_id,
        created_at, delivery_started_at, delivery_completed_at, target_message_id, target_thread_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 660)`, bot.id, user, user, user, user, now, now, now, 70000 + index);
      db.run(`INSERT INTO message_delivery_attempts (bot_id, direction, source_chat_id, source_message_id,
        user_id, thread_id, target_chat_id, method, started_at, failure_code)
        VALUES (?, 'user_to_support', ?, ?, ?, 660, -1001234567890, 'copyMessage', ?, 'telegram_delivery_outcome_unknown')`, bot.id, user, user, user, now);
      db.run(`INSERT INTO conversation_provision_attempts (bot_id, user_id, started_at, failure_code)
        VALUES (?, ?, ?, 'telegram_topic_create_outcome_unknown')`, bot.id, user, now);
    }
    let previousTicket = 0;
    const counts = [];
    for (const plan of ["free", "paid", "free", "paid", "paid"]) {
      if (source === "general") {
        env.RECOVERY_D1_PLAN = plan === "free" ? "paid" : "free";
        db.run("UPDATE cloudflare_plan_settings SET plan = ?, revision = ?", plan, `test-${counts.length}`);
      } else env.RECOVERY_D1_PLAN = plan;
      const scope = { queries: 0, limit: plan === "free" ? 50 : 1000 };
      const tasks = [];
      await recoveryQueryScope.run(scope, async () => {
        await worker.scheduled({}, env, { waitUntil: (task) => tasks.push(task) });
        await Promise.all(tasks);
      });
      assert.ok(scope.queries <= (plan === "free" ? 45 : 905));
      const ticket = db.get("SELECT next_job FROM recovery_scheduler").next_job;
      assert.ok(ticket >= previousTicket);
      previousTicket = ticket;
      counts.push(scope.queries);
    }
    assert.ok(counts[1] > 850, `Paid Cron unexpectedly capped at ${counts[1]}`);
    t.diagnostic(`Cron ${source} Free/Paid/Free/Paid/Paid statements: ${counts.join("/")}`);
    assert.ok(counts[0] <= 45 && counts[2] <= 45);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM pending_messages WHERE mapping_synced_at IS NULL").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_delivery_attempts WHERE alerted_at IS NULL").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM conversation_provision_attempts WHERE alerted_at IS NULL").n, 0);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_mappings").n, 240);
    assert.equal(calls.filter((call) => call.method === "sendMessage" && String(call.body.text).startsWith("⚠️")).length, 480);
  });
});

for (const [plan, work, total] of [["free", 44, 50], ["paid", 990, 1000]]) test(`${plan}: a slow ten-part operator album persists every result before deferring mappings`, async () => {
  await withFixture(async (call) => {
    if (call.method === "sendMediaGroup") await new Promise((resolve) => setTimeout(resolve, 180));
  }, async ({ env, db, calls }) => {
    env.RECOVERY_D1_PLAN = plan;
    env.OPERATOR_EXECUTION_RENEW_MS = "20";
    seedReviewAlbum(db, { direction: "support_to_user" });
    const update = groupUpdate(56209, 612, "");
    delete update.message.text;
    update.message.media_group_id = "review-album";
    update.message.photo = [{ file_id: "review-file-9" }];
    const budget = createWebhookDatabase(db, plan);
    const scope = { queries: 0, limit: total };
    const request = () => webhookRequest("folder-links", "secret-a", update);
    const response = await recoveryQueryScope.run(scope, async () => {
      for (let index = 0; index < work - 30; index++) await budget.prepare("SELECT 1").all();
      return worker.fetch(request(), { ...env, SUPPORT_DB: budget });
    });
    assert.equal(response.status, 503);
    assert.ok(scope.queries <= total);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM media_group_items WHERE delivered_at IS NOT NULL AND target_message_id IS NOT NULL").n, 10);
    assert.ok(db.get("SELECT delivery_completed_at FROM media_groups").delivery_completed_at);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM support_operator_execution_locks").n, 0);
    for (let turn = 0; turn < 12 && db.get("SELECT COUNT(*) AS n FROM media_groups").n; turn++) await runCountedRecovery({}, env);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM message_mappings WHERE user_id = 61200").n, 10);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM media_groups").n, 0);
    assert.equal((await worker.fetch(request(), env)).status, 200);
    assert.equal(calls.filter((call) => call.method === "sendMediaGroup").length, 1);
  });
});

test("Free failures: failed D1 writes count against the limit and retries preserve delivery", async () => {
  for (const failure of ["INSERT OR IGNORE INTO message_mappings", "UPDATE message_delivery_attempts SET completed_at", "UPDATE processed_updates SET dispatch_succeeded_at", "INSERT INTO conversations", "UPDATE logical_message_guards SET state"]) {
    await withFixture(null, async ({ env, db, calls, fetchMock }) => {
      env.RECOVERY_D1_PLAN = "free";
      db.failOnce(failure);
      const ingress = createControlPlaneWorker(undefined, fetchMock);
      const request = () => webhookRequest("folder-links", "secret-a", privateUpdate(67100, 67100));
      let status;
      for (let turn = 0; turn < 3 && status !== 200; turn++) status = (await countedFreeFetch(ingress, request(), env)).status;
      assert.equal(db.failures.length, 0, `Failure did not exercise ${failure}`);
      assert.equal(status, 200, failure);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM message_mappings WHERE user_id = 67100").n, 1);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM abuse_decision_locks").n, 0);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM logical_message_guards WHERE owner_token IS NOT NULL").n, 0);
      assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
      assert.equal(calls.filter((call) => call.method === "forwardMessage").length, 1);
    });
  }
});

function lastWorkspaceScreen(calls) { return calls.filter(c=>["sendMessage","editMessageText"].includes(c.method)&&c.body.reply_markup).at(-1); }

for (const action of ['save', 'revise', 'cancel', 'pause', 'back', 'home']) test(`workspace: registered bot welcome ${action} responds in the lower window through operational Free ingress`, async () => {
  await withFixture(null, async ({env, db, calls, fetchMock}) => {
    Object.assign(env, {RECOVERY_D1_PLAN:'free', RETENTION_ENABLED:'true', STORAGE_GUARD_ENABLED:'true',
      TELEGRAM_COOLDOWN_ENABLED:'true', OPERATIONAL_HEALTH_ENABLED:'true', BOT_ONBOARDING_ENABLED:'true', BOT_REGISTRY_KEY:'ab'.repeat(32)});
    const config = registeredConfig({id:987654,username:'new_support_bot'}, 'New service', 'NEW');
    const credentials = await sealCredentials(env, config.id, {token:'987654:test-token',webhookSecret:'new-secret'});
    const at = new Date().toISOString();
    db.run("INSERT INTO registered_bots(bot_id,telegram_id,config_json,credentials,status,owner_id,created_at,updated_at) VALUES(?,?,?,?, 'active',7,?,?)",
      config.id, 987654, JSON.stringify(config), credentials, at, at);
    const key = managementBotKey([...registryValue,config], config.id);
    const ingress = createRegistrationWorker(createControlPlaneWorker(undefined,fetchMock),fetchMock);
    const send = update => countedFreeFetch(ingress,webhookRequest('folder-links','secret-a',update),env);
    const session = () => db.get('SELECT * FROM operator_ui_sessions WHERE operator_id=7 AND thread_id=1');
    let id = 999300;
    const click = async (data, message) => {
      const update = callbackUpdate(id++,1,data);
      if (message) Object.assign(update.callback_query.message, message);
      assert.equal((await send(update)).status,200,data);
    };
    assert.equal((await send(groupUpdate(id++,1,'/menu'))).status,200);
    const oldMenu = session().message_id;
    const pin = db.get('SELECT dashboard_message_id FROM bot_ui_state').dashboard_message_id;
    await click(`um:m:view:${key}:w`);
    await click(`um:m:edit:${key}:w`);
    assert.equal((await send(groupUpdate(id++,1,'Welcome to the new service'))).status,200);
    const previewId = db.get('SELECT message_id FROM operator_input_prompts ORDER BY message_id DESC LIMIT 1').message_id;
    const preview = {...lastWorkspaceScreen(calls).body,message_id:previewId,from:{id:12345,is_bot:true}};
    assert.equal(session().message_id,previewId,'the preview becomes the active window');
    assert.notEqual(previewId,oldMenu);
    const flow = db.get('SELECT * FROM bot_message_flows');
    const data = ['save','revise','cancel'].includes(action) ? `um:m:${action}:${flow.nonce}`
      : action === 'pause' ? 'um:w:pause' : action === 'home' ? 'um:n:home'
      : preview.reply_markup.inline_keyboard.flat().find(b=>b.text==='← Back').callback_data;
    // Match the deployed incident too: old versions kept the menu as the target.
    db.run('UPDATE operator_ui_sessions SET message_id=? WHERE operator_id=7 AND thread_id=1',oldMenu);
    const boundary = calls.length;
    await click(data,preview);
    const result = lastWorkspaceScreen(calls);
    if (action === 'revise') {
      assert.equal(result.method,'sendMessage');
      assert.ok(session().message_id > previewId,'revised input appears as a new lower prompt');
    } else {
      assert.equal(result.method,'editMessageText');
      assert.equal(result.body.message_id,previewId,'the clicked preview shows the result');
      assert.equal(session().message_id,previewId);
      assert.ok(!result.body.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===`um:m:save:${flow.nonce}`),
        'completed or suspended preview no longer offers the obsolete Save action');
    }
    assert.equal(calls.slice(boundary).some(c=>c.method==='editMessageText'&&[oldMenu,pin].includes(c.body.message_id)),false);
    assert.ok(db.get('SELECT kind FROM operator_input_prompts WHERE message_id=?',previewId),'internal reply identity survives rendering');
    if (action === 'save') {
      assert.equal(db.get('SELECT welcome_text FROM bot_message_settings WHERE bot_id=?',config.id).welcome_text,'Welcome to the new service');
      await click(data,preview);
      assert.equal(lastWorkspaceScreen(calls).body.message_id,previewId,'stale Save gives visible feedback in the same window');
      assert.equal(db.get("SELECT COUNT(*) n FROM operator_audit WHERE action='bot_message_welcome_text'").n,1,'saving twice is fenced');
    }
    assert.equal(calls.some(c=>['copyMessage','forwardMessage','sendMediaGroup'].includes(c.method)),false);
    assert.equal(db.get("SELECT COUNT(*) n FROM processed_updates WHERE state<>'completed'").n,0);
  });
});

test('UX v2: readiness separates missing delivery evidence from connection details',async()=>{
  await withFixture(call=>{
    if(call.method==='getChatMember')return {ok:true,result:{status:'administrator',can_manage_topics:true,can_pin_messages:true}};
    if(call.method==='getWebhookInfo')return {ok:true,result:{url:'https://support.example.workers.dev/tg/folder-links',pending_update_count:0}};
  },async({env,calls,db,fetchMock})=>{
    env.RECOVERY_D1_PLAN='free';seedOperator(db,8);
    const ingress=createControlPlaneWorker(undefined,fetchMock),key=managementBotKey(registryValue,'folder-links');
    let id=998000;
    const click=async(route,actor=7)=>{assert.equal((await countedFreeFetch(ingress,webhookRequest('folder-links','secret-a',callbackUpdate(id++,1,route,actor)),env)).status,200);return lastWorkspaceScreen(calls).body;};
    let screen=await click(`um:w:ready:${key}`);
    assert.match(screen.text,/Checks needed: 1/);assert.match(screen.text,/message exchange has not been confirmed/);assert.doesNotMatch(screen.text,/Webhook:/);
    screen=await click(`um:w:ready:${key}:details`);assert.match(screen.text,/Webhook:/);
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===`um:w:ready:${key}`));
    screen=await click(`um:w:ready:${key}`,8);
    assert.ok(!screen.reply_markup.inline_keyboard.flat().some(b=>/^um:(?:m:|w:test:)/.test(b.callback_data)));
  });
});

for(const locale of ['ru','en'])for(const actor of [7,8])test(`UX v2: selfcheck command and button share one screen on operational Free (${locale}, ${actor})`,async()=>{
  await withFixture(null,async({env,db,calls,fetchMock})=>{
    Object.assign(env,{RECOVERY_D1_PLAN:'free',RETENTION_ENABLED:'true',STORAGE_GUARD_ENABLED:'true',TELEGRAM_COOLDOWN_ENABLED:'true',OPERATIONAL_HEALTH_ENABLED:'true'});
    env.BOT_REGISTRY=JSON.stringify(registryValue.map(c=>({...c,locale})));
    seedOperator(db,8);
    const ingress=createControlPlaneWorker(undefined,fetchMock),send=update=>countedFreeFetch(ingress,webhookRequest('folder-links','secret-a',update),env);
    assert.equal((await send(groupUpdate(998100,1,'/selfcheck',actor))).status,200);
    const command=lastWorkspaceScreen(calls).body;
    assert.equal((await send(callbackUpdate(998101,1,'um:n:check',actor))).status,200);
    const button=lastWorkspaceScreen(calls).body;
    assert.equal(button.text,command.text);assert.deepEqual(button.reply_markup,command.reply_markup);
    assert.doesNotMatch(button.text,/token=|темы=|operator: 7|оператор: 7/);
    const service=button.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.startsWith('um:w:ready:'));
    assert.ok(service);
    assert.equal((await send(callbackUpdate(998102,1,service.callback_data,actor))).status,200);
    const screen=lastWorkspaceScreen(calls).body;
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===service.callback_data+':details'));
    assert.equal(db.get('SELECT route FROM operator_ui_sessions WHERE operator_id=?',actor).route,service.callback_data);
  });
});

test('menu recovery: unchanged callbacks avoid writes and a Telegram pause resumes the same screen through Free ingress', async () => {
  let rejectEdit = false;
  await withFixture(call => {
    if (rejectEdit && call.method === 'editMessageText') {
      rejectEdit = false;
      return {ok:false,error_code:429,description:'Too Many Requests: retry after 20',parameters:{retry_after:20}};
    }
  }, async ({env,db,calls,fetchMock}) => {
    Object.assign(env,{RECOVERY_D1_PLAN:'free',RETENTION_ENABLED:'true',STORAGE_GUARD_ENABLED:'true',TELEGRAM_COOLDOWN_ENABLED:'true',OPERATIONAL_HEALTH_ENABLED:'true'});
    const ingress=createControlPlaneWorker(undefined,fetchMock),send=u=>countedFreeFetch(ingress,webhookRequest('folder-links','secret-a',u),env);
    assert.equal((await send(callbackUpdate(998190,1,'um:n:home'))).status,200);
    const screen=lastWorkspaceScreen(calls).body;
    const messageId=db.get('SELECT message_id FROM operator_ui_sessions WHERE operator_id=7').message_id;
    const duplicate=callbackUpdate(998191,1,'um:n:home');
    Object.assign(duplicate.callback_query.message,{message_id:messageId,text:screen.text,reply_markup:screen.reply_markup});
    let boundary=calls.length;
    assert.equal((await send(duplicate)).status,200);
    assert.deepEqual(calls.slice(boundary).map(c=>c.method),['answerCallbackQuery']);
    const next=callbackUpdate(998192,1,'um:w:queue:a:mine:0');
    next.callback_query.message={...duplicate.callback_query.message};
    rejectEdit=true;boundary=calls.length;
    assert.equal((await send(next)).status,500);
    assert.deepEqual(calls.slice(boundary).map(c=>c.method),['answerCallbackQuery','editMessageText']);
    assert.equal(db.get('SELECT route FROM operator_ui_sessions WHERE operator_id=7').route,'um:n:home');
    boundary=calls.length;
    assert.equal((await send(next)).status,503);
    assert.equal(calls.length,boundary,'honor the stored Telegram pause');
    db.run("UPDATE telegram_cooldowns SET not_before='2000-01-01T00:00:00.000Z'");
    assert.equal((await send(next)).status,200);
    assert.equal(db.get('SELECT message_id FROM operator_ui_sessions WHERE operator_id=7').message_id,messageId);
    assert.equal(db.get('SELECT route FROM operator_ui_sessions WHERE operator_id=7').route,'um:w:queue:a:mine:0');
    assert.equal(db.get('SELECT state FROM processed_updates WHERE update_id=998192').state,'completed');
    assert.equal(calls.slice(boundary).filter(c=>c.method==='sendMessage').length,0);
  });
});

for (const actor of [7, 8]) test(`menu recovery: commands and buttons count distinct drafts across all sources on D1 (${actor})`, async () => {
  await withFixture(null, async ({env, db, calls, fetchMock}) => {
    Object.assign(env, {RECOVERY_D1_PLAN:'free', RETENTION_ENABLED:'true', STORAGE_GUARD_ENABLED:'true', TELEGRAM_COOLDOWN_ENABLED:'true', OPERATIONAL_HEALTH_ENABLED:'true'});
    seedOperator(db, 8);
    const expires = new Date(Date.now() + 3600000).toISOString(), at = new Date().toISOString();
    for (const field of ['welcome_text', 'auto_reply_text']) db.run("INSERT INTO bot_message_drafts VALUES(?,'folder-links',?,'Saved text','revision',?)", actor, field, at);
    db.run("INSERT INTO bot_message_drafts VALUES(?,'removed-bot','welcome_text','Hidden','revision',?)", actor, at);
    db.run("INSERT INTO bot_message_drafts VALUES(99,'folder-links','welcome_text','Other operator','revision',?)", at);
    db.run("INSERT INTO bot_message_flows(owner_id,bot_id,field,stage,draft,expected_revision,nonce,chat_id,expires_at) VALUES(?,'folder-links','welcome_text','text','Editing','revision','message-nonce',-1001234567890,?)", actor, expires);
    db.run("INSERT INTO operator_pending_actions(operator_id,operator_name,management_bot_id,user_id,action,stage,chat_id,created_at,expires_at,flow_nonce) VALUES(?,'Operator','folder-links',70001,'ban','reason',-1001234567890,?,?,'moderation-nonce')", actor, at, expires);
    db.run("INSERT INTO support_operator_flows(owner_id,owner_name,action,stage,chat_id,flow_nonce,created_at,expires_at) VALUES(?,'Operator','add','candidate',-1001234567890,'team-nonce',?,?)", actor, at, expires);
    for (const user of [70001, 70002]) db.run("INSERT INTO operator_note_drafts VALUES(?,'folder-links',?,99,'Saved note',?)", actor, user, at);
    db.run("INSERT INTO operator_work_inputs(operator_id,bot_id,user_id,target_operator,nonce,expected_revision,chat_id,thread_id,expires_at,draft) VALUES(?,'folder-links',70001,99,'note-nonce',0,-1001234567890,1,?,'Editing note')", actor, expires);
    const ingress = createControlPlaneWorker(undefined, fetchMock);
    const check = async update => {
      assert.equal((await countedFreeFetch(ingress, webhookRequest('folder-links','secret-a',update), env)).status, 200);
      const screen = lastWorkspaceScreen(calls).body;
      assert.equal(screen.reply_markup.inline_keyboard.flat().find(b => b.callback_data === 'um:w:resume').text, '📝 Drafts · 6');
      assert.equal(db.get('SELECT route FROM operator_ui_sessions WHERE operator_id=?', actor).route, 'um:n:home');
      assert.equal(db.get("SELECT COUNT(*) n FROM processed_updates WHERE state<>'completed'").n, 0);
    };
    await check(groupUpdate(998200,1,'/menu',actor));
    await check(callbackUpdate(998201,1,'um:n:home',actor));
    // The saved draft and its active editor are the same item, not two drafts.
    db.run("DELETE FROM bot_message_drafts WHERE owner_id=? AND bot_id='folder-links' AND field='welcome_text'", actor);
    db.run("DELETE FROM operator_note_drafts WHERE operator_id=? AND bot_id='folder-links' AND user_id=70001", actor);
    await check(groupUpdate(998202,1,'/panel',actor));
    await check(callbackUpdate(998203,1,'um:w:back',actor));
    assert.equal(calls.some(c => ['copyMessage','forwardMessage','sendMediaGroup'].includes(c.method)), false);
  });
});

for(const locale of ['ru','en'])test(`UX v2: role menus, contextual work and list navigation fit operational Free ingress (${locale})`,async()=>{
  await withFixture(null,async({env,db,calls,fetchMock})=>{
    Object.assign(env,{RECOVERY_D1_PLAN:'free',RETENTION_ENABLED:'true',STORAGE_GUARD_ENABLED:'true',TELEGRAM_COOLDOWN_ENABLED:'true',OPERATIONAL_HEALTH_ENABLED:'true'});
    env.BOT_REGISTRY=JSON.stringify(registryValue.map(c=>({...c,locale})));
    seedOperator(db,8,{firstName:'Anna',username:'anna'});
    for(let i=1;i<=7;i++) {
      seedConversation(db,'folder-links',72000+i,760+i);
      db.run("INSERT INTO conversation_work(bot_id,user_id,state,updated_at,last_inbound_at) VALUES('folder-links',?,'needs_reply',?,?)",72000+i,new Date().toISOString(),new Date(Date.now()-18*60000).toISOString());
    }
    const key=managementBotKey(registryValue,'folder-links'),ingress=createControlPlaneWorker(undefined,fetchMock);
    let id=999000;
    const click=async(route,actor=7)=>{assert.equal((await countedFreeFetch(ingress,webhookRequest('folder-links','secret-a',callbackUpdate(id++,1,route,actor)),env)).status,200,route);return lastWorkspaceScreen(calls).body;};
    const data=screen=>screen.reply_markup.inline_keyboard.flat().map(b=>b.callback_data);
    let screen=await click('um:n:home');
    assert.ok(data(screen).includes('um:n:system'));assert.ok(data(screen).includes('um:n:bots'));
    assert.ok(!data(screen).includes('um:n:home'));assert.ok(!data(screen).includes('um:dl:home:a'));
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(b=>b.text.endsWith(' · 7')));
    screen=await click('um:n:home',8);
    assert.ok(!data(screen).some(d=>/^um:(?:n:(?:system|settings|bots)|st:|dl:|o:)/.test(d)));
    assert.doesNotMatch(screen.text,/panel 8|оператора 8/);
    screen=await click('um:n:bots',8);assert.ok(!screen.reply_markup.inline_keyboard.flat().some(b=>b.url?.includes('start=addbot')));
    screen=await click('um:g:home:a',8);assert.ok(!data(screen).some(d=>/^um:(?:r:|s:|d:|o:|g:audit)/.test(d)));
    await click('um:w:queue:a:needs:0');screen=await click('um:w:queue:a:needs:1');
    assert.ok(screen.reply_markup.inline_keyboard.flat().some(b=>b.text==='2 / 2'));
    assert.match(screen.text,locale==='ru'?/18 мин/:/18 min/);
    await click(`um:w:card:${key}:72007`);
    screen=await click('um:w:back');assert.ok(screen.reply_markup.inline_keyboard.flat().some(b=>b.text==='2 / 2'));
    screen=await click('um:w:back');assert.ok(data(screen).includes('um:n:system'));
    screen=await click(`um:w:card:${key}:72001`);
    assert.ok(data(screen).some(d=>d?.startsWith('um:w:act:take:')));
    assert.ok(!data(screen).some(d=>/^um:w:act:(?:needs|release|hour|tomorrow):/.test(d)));
    db.run("UPDATE conversation_work SET assigned_to=8,state='waiting',revision=revision+1 WHERE user_id=72001");
    screen=await click(`um:w:card:${key}:72001`);assert.match(screen.text,/Anna · @anna/);
    screen=await click(`um:w:card:${key}:72001`,8);assert.match(screen.text,locale==='ru'?/Ответственный: вы/:/Assigned: you/);
    assert.ok(!data(screen).some(d=>/^um:w:act:(?:take|waiting):/.test(d)));
    assert.ok(data(screen).some(d=>d?.startsWith('um:w:act:needs:')));
    screen=await click(`um:w:snooze:${key}:72001`,8);assert.ok(screen.reply_markup.inline_keyboard.flat().some(b=>b.text.includes('09:00')));
    screen=await click(`um:w:more:${key}:72001`,8);assert.ok(data(screen).some(d=>d?.startsWith('um:w:act:release:')));
    screen=await click('um:w:queue:a:needs:999',8);assert.ok(screen.reply_markup.inline_keyboard.flat().some(b=>b.text==='2 / 2'));
    for(const call of calls)for(const b of call.body.reply_markup?.inline_keyboard?.flat()||[])if(b.callback_data)assert.ok(Buffer.byteLength(b.callback_data)<=64,b.callback_data);
  });
});

for (const stage of ['confirm','expired','cancelled','navigated']) test(`workspace: ${stage} internal replies never reach a customer`,async()=>{
  await withFixture(null,async({env,db,calls})=>{
    seedConversation(db,'folder-links',70001,710);
    const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    await send(groupUpdate(970001,710,'/ban'));
    const prompt=db.get('SELECT message_id FROM operator_input_prompts ORDER BY message_id DESC LIMIT 1').message_id;
    if(stage==='confirm')await send(groupUpdate(970002,710,'Internal reason'));
    if(stage==='expired')db.run("UPDATE operator_pending_actions SET expires_at='2000-01-01T00:00:00Z'");
    if(stage==='cancelled')await send(groupUpdate(970002,710,'/cancel'));
    if(stage==='navigated')await send(callbackUpdate(970002,710,'um:tp:info'));
    const reply=groupUpdate(970003,710,'Late internal correction');reply.message.reply_to_message={message_id:prompt};
    assert.equal((await send(reply)).status,200);
    if(['expired','confirm'].includes(stage))assert.equal((await send(groupUpdate(970004,710,'Another internal correction'))).status,200);
    assert.equal(calls.some(c=>c.method==='copyMessage'&&c.body.chat_id===70001),false);
    await send(groupUpdate(970005,710,'/cancel'));
    assert.equal((await send(groupUpdate(970006,710,'Actual customer answer'))).status,200);
    assert.equal(calls.filter(c=>c.method==='copyMessage'&&c.body.chat_id===70001).length,1);
  });
});

test('workspace: two operators keep separate panels and exact list history without changing the pin',async()=>{
  await withFixture(null,async({env,db,calls})=>{
    seedOperator(db,8);seedConversation(db,'folder-links',70002,711);
    const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    await send(groupUpdate(971000,1,'/menu'));
    const pinned=db.get('SELECT dashboard_message_id FROM bot_ui_state').dashboard_message_id;
    const boundary=calls.length,key=managementBotKey(registryValue,'folder-links');
    await send(callbackUpdate(971001,1,`um:g:list:${key}:x:2`));
    await send(callbackUpdate(971002,1,`um:g:card:${key}:70002`));
    await send(callbackUpdate(971003,1,'um:g:home:a',8));
    const panels=db.all('SELECT operator_id,message_id FROM operator_ui_sessions ORDER BY operator_id');
    assert.equal(panels.length,2);assert.notEqual(panels[0].message_id,panels[1].message_id);
    assert.equal(calls.slice(boundary).some(c=>c.method==='editMessageText'&&c.body.message_id===pinned),false);
    await send(callbackUpdate(971004,1,'um:w:back'));
    assert.equal(db.get('SELECT route FROM operator_ui_sessions WHERE operator_id=7').route,`um:g:list:${key}:x:2`);
    assert.ok(lastWorkspaceScreen(calls).body.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='um:n:home'));
  });
});

test('workspace: search input is routed through real Free General ingress and retains its query',async()=>{
  await withFixture(null,async({env,db,calls,fetchMock})=>{
    seedConversation(db,'folder-links',70003,712);
    const ingress=createControlPlaneWorker(undefined,fetchMock),send=u=>countedFreeFetch(ingress,webhookRequest('folder-links','secret-a',u),env);
    assert.equal((await send(callbackUpdate(972000,1,'um:w:search'))).status,200);
    assert.equal((await send(groupUpdate(972001,1,'70003'))).status,200);
    const session=db.get('SELECT * FROM operator_ui_sessions WHERE operator_id=7');
    assert.equal(session.search_query,'70003');assert.equal(session.route,'um:w:searchresults:a');
    const card=lastWorkspaceScreen(calls).body.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.startsWith('um:g:card:'));
    assert.ok(card);assert.equal((await send(callbackUpdate(972002,1,card.callback_data))).status,200);
    await send(callbackUpdate(972003,1,'um:w:back'));
    assert.match(lastWorkspaceScreen(calls).body.text,/70003/);
  });
});

test('workspace: drafts survive navigation and restore with a fresh explicit preview',async()=>{
  await withFixture(null,async({env,db,calls})=>{
    setBotTexts(db,'folder-links','Original','Received');
    const key=managementBotKey(registryValue,'folder-links'),send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    await send(callbackUpdate(973000,1,`um:m:edit:${key}:w`));
    await send(groupUpdate(973001,1,'Saved draft'));
    await send(callbackUpdate(973002,1,'um:n:bots'));
    assert.equal(db.get('SELECT draft FROM bot_message_drafts').draft,'Saved draft');
    await send(groupUpdate(973003,1,'Ordinary General text'));
    assert.equal(db.get('SELECT welcome_text FROM bot_message_settings').welcome_text,'Original');
    await send(callbackUpdate(973004,1,'um:w:resume'));
    const restore=lastWorkspaceScreen(calls).body.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.startsWith('um:m:restore:'));
    assert.ok(restore);await send(callbackUpdate(973005,1,restore.callback_data));
    const flow=db.get('SELECT * FROM bot_message_flows');assert.equal(flow.stage,'confirm');assert.equal(flow.suspended,0);
    await send(callbackUpdate(973006,1,'um:m:save:'+flow.nonce));
    assert.equal(db.get('SELECT welcome_text FROM bot_message_settings').welcome_text,'Saved draft');
    assert.equal(db.get('SELECT COUNT(*) n FROM bot_message_drafts').n,0);
  });
});

test('workspace: delivery switches preserve text and suppress welcome and auto-replies',async()=>{
  await withFixture(null,async({env,db,calls})=>{
    setBotTexts(db,'folder-links','Welcome','Received');
    const key=managementBotKey(registryValue,'folder-links'),send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    for(const [i,field] of ['w','a'].entries())assert.equal((await send(callbackUpdate(974000+i,1,`um:m:disable:${key}:${field}`))).status,200);
    const start=privateUpdate(974002,70004);start.message.text='/start';await send(start);
    await send(privateUpdate(974003,70004));
    assert.equal(autoReplyCalls(calls,'Welcome').length,0);assert.equal(autoReplyCalls(calls).length,0);
    assert.equal(db.get('SELECT welcome_text FROM bot_message_settings').welcome_text,'Welcome');
    await send(callbackUpdate(974004,1,`um:m:enable:${key}:w`));start.update_id=974005;start.message.message_id=974005;await send(start);
    assert.equal(autoReplyCalls(calls,'Welcome').length,1);
  });
});

test('workspace: work queue uses confirmed answers, survives topic closure, and rejects stale assignments',async()=>{
  const {changeWork,workQueue}=await import('../src/conversation-work.js');
  await withFixture(null,async({env,db})=>{
    const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    await send(privateUpdate(975000,70005));
    const conversation=db.get('SELECT * FROM conversations WHERE user_id=70005');
    let row=db.get('SELECT * FROM conversation_work WHERE user_id=70005');assert.equal(row.state,'needs_reply');
    seedOperator(db,8);
    assert.ok(await changeWork(db,{botId:row.bot_id,userId:row.user_id,actor:7,revision:row.revision,action:'take'}));
    assert.equal(await changeWork(db,{botId:row.bot_id,userId:row.user_id,actor:8,revision:row.revision,action:'take'}),null);
    db.run("UPDATE conversations SET status='closed' WHERE user_id=70005");
    assert.equal(db.get('SELECT state FROM conversation_work').state,'needs_reply');
    db.run("UPDATE conversations SET status='open' WHERE user_id=70005");
    await send(groupUpdate(975001,conversation.thread_id,'Customer answer'));
    assert.equal(db.get('SELECT state FROM conversation_work').state,'waiting');
    assert.equal((await workQueue(db,{filter:'waiting',actor:7})).rows.length,1);
    await send(privateUpdate(975002,70005));
    assert.equal(db.get('SELECT state FROM conversation_work').state,'needs_reply');
    row=db.get('SELECT * FROM conversation_work');
    await changeWork(db,{botId:row.bot_id,userId:row.user_id,actor:7,revision:row.revision,action:'snooze',until:new Date(Date.now()+3600000).toISOString()});
    assert.equal((await workQueue(db,{filter:'needs',actor:7})).rows.length,0);
    db.run("UPDATE conversation_work SET snoozed_until='2000-01-01T00:00:00Z'");
    assert.equal((await workQueue(db,{filter:'needs',actor:7})).rows.length,1);
  });
});

test('workspace: handoff note stays internal and removed operators lose assignments',async()=>{
  await withFixture(null,async({env,db,calls})=>{
    seedOperator(db,8);const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    await send(privateUpdate(976000,70006));
    env.MANAGER_BOT_TOKEN='manager-token';
    const row=db.get('SELECT * FROM conversation_work'),conversation=db.get('SELECT * FROM conversations');
    const key=managementBotKey(registryValue,row.bot_id);
    await send(callbackUpdate(976001,conversation.thread_id,`um:w:transfer:${key}:${row.user_id}:${row.revision}`));
    const to=lastWorkspaceScreen(calls).body.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.endsWith(':8'));
    assert.ok(to);assert.ok(Buffer.byteLength(to.callback_data)<=64);
    await send(callbackUpdate(976002,conversation.thread_id,to.callback_data));
    await send(groupUpdate(976003,conversation.thread_id,'Internal context for colleague'));
    assert.equal(calls.some(c=>c.method==='copyMessage'&&c.body.chat_id===70006),false);
    const nonce=db.get('SELECT nonce FROM operator_work_inputs').nonce;
    assert.equal((await send(callbackUpdate(976004,conversation.thread_id,'um:w:noteconfirm:'+nonce))).status,200);
    assert.equal(db.get('SELECT assigned_to FROM conversation_work').assigned_to,8);
    assert.equal(db.get('SELECT note FROM conversation_work').note,'Internal context for colleague');
    const transferNotice=db.get("SELECT kind,recipient_id,note FROM service_notification_outbox WHERE kind='transfer'");
    assert.equal(transferNotice?.recipient_id,8);
    assert.equal(transferNotice?.note,'Internal context for colleague');
    db.run('UPDATE support_operators SET active=0 WHERE user_id=8');
    assert.equal(db.get('SELECT assigned_to FROM conversation_work').assigned_to,null);
  });
});

test('workspace: isolated readiness test never creates customer data or replays a completed send',async()=>{
  await withFixture(null,async({env,db,calls})=>{
    const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env),key=managementBotKey(registryValue,'folder-links');
    assert.equal((await send(callbackUpdate(977000,1,`um:w:test:${key}`))).status,200);
    const nonce=db.get('SELECT nonce FROM service_checks').nonce,start=privateUpdate(977001,7);start.message.text='/start qc_'+nonce;
    assert.equal((await send(start)).status,200);
    const row=db.get('SELECT * FROM service_checks');assert.equal(row.stage,'reply');
    const reply=groupUpdate(977002,row.thread_id,'/check '+nonce);
    assert.equal((await send(reply)).status,200);
    assert.equal(db.get('SELECT stage FROM service_checks').stage,'done');
    assert.equal(db.get('SELECT COUNT(*) n FROM conversations').n,0);assert.equal(db.get('SELECT COUNT(*) n FROM conversation_work').n,0);
    const count=calls.filter(c=>c.method==='sendMessage'&&c.body.chat_id===7).length;
    reply.update_id++;await send(reply);assert.equal(calls.filter(c=>c.method==='sendMessage'&&c.body.chat_id===7).length,count);
  });
});

test('workspace: a failed test-topic auto-close is visible and /close can safely finish it',async()=>{
  let closeAttempts=0;
  await withFixture(call=>{
    if(call.method==='closeForumTopic' && ++closeAttempts===1)
      return {ok:false,error_code:403,description:'Forbidden: missing topic permission'};
  },async({env,db,calls})=>{
    const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    const key=managementBotKey(registryValue,'folder-links');
    await send(callbackUpdate(977100,1,`um:w:test:${key}`));
    const nonce=db.get('SELECT nonce FROM service_checks').nonce;
    const start=privateUpdate(977101,7);start.message.text='/start qc_'+nonce;
    await send(start);
    const thread=db.get('SELECT thread_id FROM service_checks').thread_id;
    await send(groupUpdate(977102,thread,'/check '+nonce));
    assert.equal(db.get('SELECT stage FROM service_checks').stage,'done');
    assert.ok(calls.some(call=>call.method==='sendMessage' && call.body.chat_id===7 && call.body.text.includes('test topic could not be closed')));
    await send(groupUpdate(977103,thread,'/close@OtherBot'));
    assert.equal(closeAttempts,1);
    await send(groupUpdate(977104,thread,'/close@FolderLinksSupportBot'));
    assert.equal(closeAttempts,2);
    assert.ok(calls.some(call=>call.method==='sendMessage' && call.body.chat_id===7 && call.body.text==='Test topic closed.'));
    assert.equal(db.get('SELECT COUNT(*) n FROM conversations').n,0);
  });
});

test('workspace: an already closed test topic accepts Telegram TOPIC_NOT_MODIFIED',async()=>{
  await withFixture(call=>call.method==='closeForumTopic'
    ? {ok:false,error_code:400,description:'Bad Request: TOPIC_NOT_MODIFIED'} : null,
  async({env,db,calls})=>{
    const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    const key=managementBotKey(registryValue,'folder-links');
    await send(callbackUpdate(977110,1,`um:w:test:${key}`));
    const nonce=db.get('SELECT nonce FROM service_checks').nonce;
    const start=privateUpdate(977111,7);start.message.text='/start qc_'+nonce;
    await send(start);
    const thread=db.get('SELECT thread_id FROM service_checks').thread_id;
    await send(groupUpdate(977112,thread,'/check '+nonce));
    assert.equal(db.get('SELECT stage FROM service_checks').stage,'done');
    assert.equal(calls.some(call=>call.method==='sendMessage' && call.body.text?.includes('не удалось закрыть')),false);
    await send(groupUpdate(977113,thread,'/close@FolderLinksSupportBot'));
    assert.ok(calls.some(call=>call.method==='sendMessage' && call.body.text==='Test topic closed.'));
  });
});

for(const operational of [false,true])test(`workspace: all work actions and readiness fit real Free ingress (${operational?'operational':'basic'})`,async()=>{
  await withFixture(null,async({env,db,calls,fetchMock})=>{
    env.RECOVERY_D1_PLAN='free';
    if(operational){env.TELEGRAM_COOLDOWN_ENABLED='true';env.OPERATIONAL_HEALTH_ENABLED='true';env.RETENTION_ENABLED='true';env.STORAGE_GUARD_ENABLED='true';}
    const ingress=createControlPlaneWorker(undefined,fetchMock),send=u=>countedFreeFetch(ingress,webhookRequest('folder-links','secret-a',u),env);
    assert.equal((await send(privateUpdate(978000,70008))).status,200);
    let id=978001;const key=managementBotKey(registryValue,'folder-links');
    for(const route of ['um:w:queue:a:needs:0',`um:w:card:${key}:70008`,`um:w:problems:${key}:70008:0`,`um:w:ready:${key}`,'um:w:resume']) {
      assert.equal((await send(callbackUpdate(id++,1,route))).status,200,route);
      for(const button of lastWorkspaceScreen(calls).body.reply_markup.inline_keyboard.flat())if(button.callback_data)assert.ok(Buffer.byteLength(button.callback_data)<=64,button.callback_data);
    }
    for(const action of ['take','waiting','hour','tomorrow','needs','resolve','release']) {
      const row=db.get('SELECT * FROM conversation_work WHERE user_id=70008');
      assert.equal((await send(callbackUpdate(id++,1,`um:w:act:${action}:${key}:70008:${row.revision}`))).status,200,action);
    }
    assert.equal(db.get("SELECT COUNT(*) n FROM operator_audit WHERE action LIKE 'work_%'").n,7);
    assert.equal((await send(callbackUpdate(id++,1,`um:w:test:${key}`))).status,200);
    const nonce=db.get('SELECT nonce FROM service_checks').nonce,start=privateUpdate(id++,7);start.message.text='/start qc_'+nonce;
    assert.equal((await send(start)).status,200);
    const thread=db.get('SELECT thread_id FROM service_checks').thread_id;
    assert.equal((await send(callbackUpdate(id++,thread,'qc:reply:'+nonce))).status,200);
    assert.equal(db.get('SELECT stage FROM service_checks').stage,'done');
  });
});

test('workspace: assignment and audit roll back together',async()=>{
  await withFixture(null,async({env,db})=>{
    const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    await send(privateUpdate(979000,70009));
    const row=db.get('SELECT * FROM conversation_work'),key=managementBotKey(registryValue,row.bot_id);
    db.failOnce('INSERT INTO operator_audit(bot_id,user_id,operator_id');
    const action=callbackUpdate(979001,1,`um:w:act:take:${key}:70009:${row.revision}`);
    assert.equal((await send(action)).status,500);
    assert.equal(db.get('SELECT assigned_to FROM conversation_work').assigned_to,null);
    assert.equal((await send(action)).status,200);
    assert.equal(db.get('SELECT assigned_to FROM conversation_work').assigned_to,7);
    assert.equal(db.get("SELECT COUNT(*) n FROM operator_audit WHERE action='work_take'").n,1);
  });
});

test('workspace: expired timed protection really returns to AUTO despite a configured override',async()=>{
  await withFixture(null,async({env,db})=>{
    env.BOT_REGISTRY=JSON.stringify([{...registryValue[0],attack_mode_manual_override:'on'},registryValue[1]]);
    const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    await send(groupUpdate(980000,1,'/attack on'));
    assert.ok(db.get('SELECT override_until FROM service_attack_state').override_until);
    db.run("UPDATE service_attack_state SET override_until='2000-01-01T00:00:00Z'");
    await send(groupUpdate(980001,1,'/attack'));
    const state=db.get('SELECT * FROM service_attack_state');
    assert.equal(state.mode,'normal');assert.equal(state.manual_override,null);assert.equal(state.override_until,null);
  });
});

test('workspace: bot keyboard still classifies a reply when saving its prompt receipt failed',async()=>{
  await withFixture(null,async({env,db,calls})=>{
    seedConversation(db,'folder-links',70010,720);const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    db.failOnce('INSERT INTO operator_input_prompts');
    assert.equal((await send(groupUpdate(981000,720,'/ban'))).status,500);
    const prompt=lastWorkspaceScreen(calls).body;
    await send(groupUpdate(981001,720,'/cancel'));
    const reply=groupUpdate(981002,720,'Late internal reason');reply.message.reply_to_message={message_id:12345,from:{id:9001,is_bot:true},reply_markup:prompt.reply_markup};
    assert.equal((await send(reply)).status,200);
    assert.equal(calls.some(c=>c.method==='copyMessage'&&c.body.chat_id===70010),false);
  });
});


for(const kind of ['m','o','w'])for(const phase of ['expired','cancelled','navigated','confirmation'])test(`workspace: ${kind} ${phase} prompt replies retain their internal destination`,async()=>{
  await withFixture(null,async({env,db,calls})=>{
    seedConversation(db,'folder-links',70011,731);
    const key=managementBotKey(registryValue,'folder-links'),send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env);
    let id=982000,thread=kind==='w'?731:1;
    if(kind==='m')await send(callbackUpdate(id++,thread,`um:m:edit:${key}:w`));
    if(kind==='o')await send(callbackUpdate(id++,thread,'um:o:add'));
    if(kind==='w') {
      seedOperator(db,8);db.run("INSERT INTO conversation_work(bot_id,user_id,updated_at) VALUES('folder-links',70011,?)",new Date().toISOString());
      await send(callbackUpdate(id++,thread,`um:w:transfer:${key}:70011:0`));
      await send(callbackUpdate(id++,thread,lastWorkspaceScreen(calls).body.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.endsWith(':8')).callback_data));
    }
    assert.equal((await send(groupUpdate(id++,thread,kind==='o'?'8':'Internal draft'))).status,200);
    const prompt=db.get('SELECT * FROM operator_input_prompts ORDER BY message_id DESC LIMIT 1');assert.equal(prompt.kind,kind);
    const table={m:'bot_message_flows',o:'support_operator_flows',w:'operator_work_inputs'}[kind];
    if(phase==='expired')db.run(`UPDATE ${table} SET expires_at='2000-01-01T00:00:00.000Z'`);
    if(phase==='cancelled')await send(callbackUpdate(id++,thread,`um:${kind}:${kind==='w'?'notecancel':'cancel'}:${prompt.nonce}`));
    if(phase==='navigated')await send(callbackUpdate(id++,thread,thread===1?'um:n:home':'um:tp:info'));
    const reply=groupUpdate(id++,731,'Late internal correction');reply.message.reply_to_message={message_id:prompt.message_id};
    assert.equal((await send(reply)).status,200);
    assert.equal(calls.some(c=>c.method==='copyMessage'&&c.body.chat_id===70011),false);
  });
});

test('workspace: handoff draft survives cancellation and restores against current work revision',async()=>{
  await withFixture(null,async({env,db,calls})=>{
    seedOperator(db,8);const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env),key=managementBotKey(registryValue,'folder-links');
    await send(privateUpdate(983000,70012));const topic=db.get('SELECT thread_id FROM conversations').thread_id;
    await send(callbackUpdate(983001,topic,`um:w:transfer:${key}:70012:0`));
    await send(callbackUpdate(983002,topic,lastWorkspaceScreen(calls).body.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.endsWith(':8')).callback_data));
    await send(groupUpdate(983003,topic,'Context to preserve'));
    const flow=db.get('SELECT * FROM operator_work_inputs');
    await send(callbackUpdate(983004,topic,'um:w:notecancel:'+flow.nonce));
    assert.equal(db.get('SELECT draft FROM operator_note_drafts').draft,'Context to preserve');
    db.run('UPDATE conversation_work SET revision=revision+1');
    await send(callbackUpdate(983005,topic,'um:w:resume'));
    const restore=lastWorkspaceScreen(calls).body.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.startsWith('um:w:restorenote:'));assert.ok(restore);
    await send(callbackUpdate(983006,topic,restore.callback_data));const fresh=db.get('SELECT * FROM operator_work_inputs');
    assert.notEqual(fresh.nonce,flow.nonce);assert.equal(fresh.expected_revision,1);
    await send(callbackUpdate(983007,topic,'um:w:noteconfirm:'+fresh.nonce));
    assert.equal(db.get('SELECT assigned_to FROM conversation_work').assigned_to,8);
    assert.equal(db.get('SELECT COUNT(*) n FROM operator_note_drafts').n,0);
    assert.equal(calls.some(c=>c.method==='copyMessage'&&c.body.chat_id===70012),false);
  });
});

test('workspace: delayed delivery uses original Telegram source time in both directions',async()=>{
  await withFixture(null,async({env,db})=>{
    const send=u=>worker.fetch(webhookRequest('folder-links','secret-a',u),env),base=Math.floor(Date.now()/1000)-60;
    const incoming=privateUpdate(984000,70013);incoming.message.date=base;await send(incoming);
    const topic=db.get('SELECT thread_id FROM conversations').thread_id;
    const newer=privateUpdate(984002,70013);newer.message.date=base+20;await send(newer);
    const delayed=groupUpdate(984001,topic,'Delayed answer to the earlier question');delayed.message.date=base+10;await send(delayed);
    const row=db.get('SELECT * FROM conversation_work');assert.equal(row.state,'needs_reply');
    assert.equal(row.last_answer_at,new Date((base+10)*1000).toISOString());
    assert.equal(row.last_inbound_at,new Date((base+20)*1000).toISOString());
  });
});


test('workspace: panel alias and diagnostic commands offer recovery routes through Free ingress',async()=>{
  await withFixture(null,async({env,db,calls,fetchMock})=>{
    env.RECOVERY_D1_PLAN='free';env.RETENTION_ENABLED='true';env.STORAGE_GUARD_ENABLED='true';env.TELEGRAM_COOLDOWN_ENABLED='true';env.OPERATIONAL_HEALTH_ENABLED='true';
    const ingress=createControlPlaneWorker(undefined,fetchMock),send=u=>countedFreeFetch(ingress,webhookRequest('folder-links','secret-a',u),env);
    assert.equal((await send(groupUpdate(985000,1,'/panel'))).status,200);
    assert.ok(db.get('SELECT dashboard_message_id FROM bot_ui_state').dashboard_message_id);
    assert.equal((await send(privateUpdate(985001,70014))).status,200);
    const topic=db.get('SELECT thread_id FROM conversations').thread_id;
    let id=985002;
    for(const command of ['/info','/risk','/antispam','/help']) {
      assert.equal((await send(groupUpdate(id++,topic,command))).status,200,command);
      const screen=lastWorkspaceScreen(calls);
      assert.ok(screen.body.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='um:tp:refresh'),command);
    }
    assert.ok(lastWorkspaceScreen(calls).body.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='um:n:help:reply'));
    await send(callbackUpdate(id++,topic,'um:n:help:commands'));
    assert.match(lastWorkspaceScreen(calls).body.text,/\/user/);
  });
});


for (const direction of ['user_to_support', 'support_to_user']) {
  test(`all standard reactions: ${direction} mirrors the full Telegram catalog through Free ingress`, async () => {
    await withFixture(null, async ({ env, db, calls, fetchMock }) => {
      Object.assign(env, {
        RECOVERY_D1_PLAN: 'free', RETENTION_ENABLED: 'true', STORAGE_GUARD_ENABLED: 'true',
        TELEGRAM_COOLDOWN_ENABLED: 'true', OPERATIONAL_HEALTH_ENABLED: 'true',
      });
      seedConversation(db, 'folder-links', 71000, 741);
      db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',71000,741,201,301,?)", new Date().toISOString());
      db.run("INSERT INTO reaction_settings(bot_id,enabled,capability_verified,updated_at) VALUES('folder-links',1,1,?)", new Date().toISOString());
      const ingress = createControlPlaneWorker(undefined, fetchMock);
      const send = update => countedFreeFetch(ingress, webhookRequest('folder-links', 'secret-a', update), env);
      const group = direction === 'support_to_user';
      const chat = group ? -1001234567890 : 71000, message = group ? 301 : 201, actor = group ? 7 : 71000;
      let id = 990000;
      for (const emoji of standardReactionCatalog) {
        const reaction = [{ type: 'emoji', emoji }];
        const replacement = [{ type: 'emoji', emoji: emoji === '🔥' ? '🎉' : '🔥' }];
        for (const [next, old] of [[reaction, []], [replacement, reaction], [[], replacement]]) {
          const before = calls.filter(call => call.method === 'setMessageReaction').length;
          assert.equal((await send(reactionUpdate(id++, chat, message, actor, next, old))).status, 200, emoji);
          const sent = calls.filter(call => call.method === 'setMessageReaction');
          assert.equal(sent.length, before + 1, emoji);
          assert.deepEqual(sent.at(-1).body.reaction, next, emoji);
          assert.equal(sent.at(-1).body.chat_id, group ? 71000 : -1001234567890);
          assert.equal(sent.at(-1).body.message_id, group ? 201 : 301);
        }
      }
    });
  });
}

test('standard reactions: presentation variants normalize and a mixed array selects the last standard emoji', async () => {
  await withFixture(null, async ({ env, db, calls }) => {
    seedConversation(db, 'folder-links', 71001, 742);
    db.run("INSERT INTO message_mappings(bot_id,user_id,thread_id,user_message_id,support_message_id,created_at) VALUES('folder-links',71001,742,202,302,?)", new Date().toISOString());
    db.run("INSERT INTO reaction_settings(bot_id,enabled,capability_verified,updated_at) VALUES('folder-links',1,1,?)", new Date().toISOString());
    let id = 991000;
    const cases = [['❤️', '❤'], ['❤️‍🔥', '❤‍🔥'], ['🤷‍♀️', '🤷‍♀'], ['🤷‍♂️', '🤷‍♂'], ['☃️', '☃'], ['✍️', '✍'], ['🕊️', '🕊']];
    for (const [input, output] of cases) {
      const reactions = [
        { type: 'emoji', emoji: '🥰' }, { type: 'emoji', emoji: input },
        { type: 'custom_emoji', custom_emoji_id: 'x' }, { type: 'paid' },
      ];
      const update = reactionUpdate(id++, 71001, 202, 71001, reactions);
      assert.equal((await worker.fetch(webhookRequest('folder-links', 'secret-a', update), env)).status, 200);
      assert.deepEqual(calls.filter(call => call.method === 'setMessageReaction').at(-1).body.reaction, [{ type: 'emoji', emoji: output }]);
    }
    assert.equal(calls.filter(call => call.method === 'setMessageReaction').length, cases.length);
  });
});
