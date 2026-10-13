import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { createReactionChecks, reactionSummary, REACTION_EXTRA_TRANSLATIONS } from '../src/reaction-checks.js';
import { serviceChecks, SERVICE_CHECK_TRANSLATIONS } from '../src/service-checks.js';

const locales=['en','ru','es','zh'];
const hasRussian=text=>/[А-Яа-яЁё]/.test(text);

test('reaction-check Spanish and Chinese catalogs have matching keys and no English fallback',()=>{
  assert.deepEqual(Object.keys(REACTION_EXTRA_TRANSLATIONS.es).sort(),Object.keys(REACTION_EXTRA_TRANSLATIONS.zh).sort());
  for(const locale of ['es','zh']) for(const [key,value] of Object.entries(REACTION_EXTRA_TRANSLATIONS[locale])) {
    assert.ok(value);assert.notEqual(value,key,`${locale} fallback for ${key}`);assert.equal(hasRussian(value),false,`${locale} Russian copy for ${key}`);
  }
});

test('reaction-check screens, summaries, and invalid button alerts preserve all four locales',async()=>{
  const db=new SqliteD1(new URL('../migrations/',import.meta.url));
  const now=Date.now();
  try {
    for(const locale of locales) {
      const sent=[];
      const env={SUPPORT_DB:db,SUPPORT_GROUP_ID:'-1001234567890'};
      const check=createReactionChecks(env,{primaryId:7,resolveBot:id=>({id,locale,username:'support_bot',displayName:'Support'}),telegram:async(_bot,method,body)=>{sent.push({method,body});return {ok:true};},subscribe:async()=>{},receiverId:()=>1});
      const row={nonce:'a'.repeat(16),bot_id:'bot',owner_id:7,group_id:-1001234567890,receiver_bot_id:1,state:'ready',expires_at:new Date(now+60000).toISOString(),support_step:1,user_step:2,support_message_id:20,private_message_id:21,group_message_id:22,private_chat_id:7,group_chat_id:-1001234567890,support_error:null,user_error:null};
      const screen=check.screen(row,'general');
      const summary=reactionSummary({support_to_user_enabled:1,support_to_user_verified:1,user_to_support_enabled:0,user_to_support_verified:0},locale);
      assert.ok(screen.text.length>0);assert.ok(summary.length>0);
      if(locale==='es') {assert.match(screen.text,/Comprobación de reacciones/);assert.match(screen.text,/Soporte → usuario/);assert.match(summary,/activado y verificado/);}
      if(locale==='zh') {assert.match(screen.text,/表情反应检查/);assert.match(screen.text,/支持人员/);assert.match(summary,/已启用并验证/);}
      if(locale==='ru') assert.match(screen.text,/Проверка реакций/);
      if(locale==='en') assert.match(screen.text,/Reaction check/);
      if(locale==='es'||locale==='zh') {assert.equal(hasRussian(screen.text),false);assert.equal(hasRussian(summary),false);}
      const managerScreen=check.screen(row,'manager',locale==='en'?'es':locale);
      if(locale==='es'||locale==='zh') assert.equal(hasRussian(managerScreen.text),false);
      assert.equal(managerScreen.text.includes('Traducción pendiente')||managerScreen.text.includes('缺少翻译'),false);
      const waiting=check.screen({...row,state:'waiting'},'private');
      assert.equal(waiting.text.includes('Traducción pendiente')||waiting.text.includes('缺少翻译'),false);
      await check.callback('bot',{id:'q',from:{id:8},data:'rx:refresh:bad',message:{chat:{id:8,type:'private'},message_id:1}});
      const alert=sent.find(call=>call.method==='answerCallbackQuery').body;
      assert.equal(alert.show_alert,true);
      if(locale==='es') assert.match(alert.text,/no está disponible/);
      if(locale==='zh') assert.match(alert.text,/不可用/);
      if(locale==='ru') assert.match(alert.text,/недоступна/);
      if(locale==='en') assert.match(alert.text,/unavailable/);
    }
  } finally {db.close();}
});

test('service-check Spanish and Chinese catalogs cover every key without English fallback',()=>{
  assert.deepEqual(Object.keys(SERVICE_CHECK_TRANSLATIONS.es).sort(),Object.keys(SERVICE_CHECK_TRANSLATIONS.zh).sort());
  for(const locale of ['es','zh']) for(const [key,value] of Object.entries(SERVICE_CHECK_TRANSLATIONS[locale])) {
    assert.ok(value);assert.notEqual(value,key,`${locale} fallback for ${key}`);assert.equal(hasRussian(value),false,`${locale} Russian copy for ${key}`);
  }
});

test('service-check instructions, buttons, completion, and close notice render in all locales',async()=>{
  const db=new SqliteD1(new URL('../migrations/',import.meta.url));
  try {
    for(const locale of locales) {
      const sent=[];
      const checks=serviceChecks(db,{primaryId:7,groupId:-1001234567890,locale:()=>locale,send:async(_bot,method,body)=>{
        sent.push({method,body});
        return method==='createForumTopic'?{ok:true,result:{message_thread_id:44}}:{ok:true,result:{message_id:sent.length}};
      }});
      const nonce=await checks.start('bot',7);
      await checks.message('bot',{from:{id:7},chat:{id:7,type:'private'},text:`/start qc_${nonce}`});
      const prompt=sent.find(call=>call.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==='qc:reply:'+nonce);
      assert.ok(prompt);
      assert.ok(prompt.body.reply_markup.inline_keyboard[0][0].text);
      await checks.message('bot',{from:{id:7},chat:{id:-1001234567890},message_thread_id:44,text:`/check ${nonce}`});
      await checks.message('bot',{from:{id:7},chat:{id:-1001234567890},message_thread_id:44,text:'/close'});
      const allText=sent.map(call=>[call.body.text||'',...(call.body.reply_markup?.inline_keyboard?.flat().map(button=>button.text)||[])].join(' ')).join('\n');
      if(locale==='es') {assert.match(allText,/Comprobación aislada/);assert.match(allText,/Comprobar respuesta/);assert.match(allText,/Tema de prueba cerrado/);}
      if(locale==='zh') {assert.match(allText,/独立检查/);assert.match(allText,/检查回复/);assert.match(allText,/测试话题已关闭/);}
      if(locale==='ru') {assert.match(allText,/Изолированная проверка/);assert.match(allText,/Проверить ответ/);assert.match(allText,/Тестовая тема закрыта/);}
      if(locale==='en') {assert.match(allText,/Isolated check/);assert.match(allText,/Check reply/);assert.match(allText,/Test topic closed/);}
      if(locale==='es'||locale==='zh') assert.equal(hasRussian(allText),false);
      assert.equal(allText.includes('Traducción pendiente')||allText.includes('缺少翻译'),false);
    }
  } finally {db.close();}
});

test('service-check close failures do not expose raw Telegram descriptions',async()=>{
  const db=new SqliteD1(new URL('../migrations/',import.meta.url));
  try {
    for(const locale of locales) {
      const sent=[];
      const checks=serviceChecks(db,{primaryId:7,groupId:-1001234567890,locale:()=>locale,send:async(_bot,method,body)=>{
        sent.push({method,body});
        if(method==='createForumTopic') return {ok:true,result:{message_thread_id:44}};
        if(method==='closeForumTopic') return {ok:false,errorCode:400,description:'Not enough rights to manage topics'};
        return {ok:true,result:{message_id:sent.length}};
      }});
      const nonce=await checks.start(`bot-${locale}`,7);
      await checks.message(`bot-${locale}`,{from:{id:7},chat:{id:7,type:'private'},text:`/start qc_${nonce}`});
      await checks.message(`bot-${locale}`,{from:{id:7},chat:{id:-1001234567890},message_thread_id:44,text:`/check ${nonce}`});
      const notice=sent.filter(call=>call.method==='sendMessage'&&call.body.chat_id===7).at(-1).body.text;
      assert.doesNotMatch(notice,/Not enough rights to manage topics/);
      assert.match(notice,({en:/permissions/,ru:/права/,es:/permisos/,zh:/权限/})[locale]);
    }
  } finally {db.close();}
});
