const checkTranslations = {
  es: {
    '🧪 Check ': '🧪 Comprobación ',
    'Isolated check: incoming received, topic created. Press the button for a control reply to your private chat.': 'Comprobación aislada: se recibió el mensaje y se creó el tema. Pulse el botón para comprobar la respuesta en su chat privado.',
    'Check reply': 'Comprobar respuesta',
    'Incoming received. Finish the check in the test topic.': 'Mensaje recibido. Complete la comprobación en el tema de prueba.',
    'Test topic': 'Tema de prueba',
    '✅ Isolated check completed: incoming → topic → confirmed reply.': '✅ Comprobación aislada completada: mensaje entrante → tema → respuesta confirmada.',
    '✅ Telegram confirmed the reply. Closing the test topic.': '✅ Telegram confirmó la respuesta. Cerrando el tema de prueba.',
    'Reply outcome is unconfirmed. Inspect the private chat before starting another check.': 'No se confirmó el resultado de la respuesta. Revise el chat privado antes de iniciar otra comprobación.',
    'Primary administrator only.': 'Solo el administrador principal.',
  },
  zh: {
    '🧪 Check ': '🧪 检查 ',
    'Isolated check: incoming received, topic created. Press the button for a control reply to your private chat.': '独立检查：已收到消息并创建话题。点击按钮，检查私人聊天中的回复。',
    'Check reply': '检查回复',
    'Incoming received. Finish the check in the test topic.': '已收到消息。请在测试话题中完成检查。',
    'Test topic': '测试话题',
    '✅ Isolated check completed: incoming → topic → confirmed reply.': '✅ 独立检查已完成：收到消息 → 创建话题 → 确认回复。',
    '✅ Telegram confirmed the reply. Closing the test topic.': '✅ Telegram 已确认回复。正在关闭测试话题。',
    'Reply outcome is unconfirmed. Inspect the private chat before starting another check.': '回复结果尚未确认。开始新检查前请查看私人聊天。',
    'Primary administrator only.': '仅主管理员可操作。',
  },
};
export const SERVICE_CHECK_TRANSLATIONS = checkTranslations;
const checkText = (language, ru, en) => language === 'ru' ? ru : ['es','zh'].includes(language)
  ? checkTranslations[language]?.[en] || (language === 'es' ? 'Traducción pendiente' : '缺少翻译')
  : en;

// Isolated round trip: no customer profile, work item, greeting or auto-reply is created.
export function serviceChecks(db, {primaryId, groupId, send, managerActive=false, locale=()=> 'en', username=()=>null}) {
  const one=(sql,...args)=>db.prepare(sql).bind(...args).first();
  const run=(sql,...args)=>db.prepare(sql).bind(...args).run();
  const now=()=>new Date().toISOString();
  const alreadyClosed=result=>/(?:topic is already closed|topic already closed|topic is closed|topic_not_modified|topic_closed)/i
    .test(String(result.description||''));
  const closeFailure=(result, language)=>{
    const reason=String(result.description||'');
    const kind=result.rateLimited||Number(result.errorCode||result.error_code)===429 ? 'limited'
      : /(?:not enough rights|not enough permissions|administrator rights|chat_admin_required)/i.test(reason) ? 'permission' : 'unknown';
    const words={
      en:{limited:'Telegram temporarily limited requests',permission:'Telegram rejected the bot permissions',unknown:'Telegram did not confirm the action'},
      ru:{limited:'Telegram временно ограничил запросы',permission:'Telegram отклонил права бота',unknown:'Telegram не подтвердил действие'},
      es:{limited:'Telegram limitó temporalmente las solicitudes',permission:'Telegram rechazó los permisos del bot',unknown:'Telegram no confirmó la acción'},
      zh:{limited:'Telegram 暂时限制了请求',permission:'Telegram 拒绝了机器人的权限',unknown:'Telegram 未确认此操作'},
    };
    const code=Number(result.errorCode||result.error_code);
    return `${(words[language]||words.en)[kind]}${Number.isInteger(code)&&code>0?` (Telegram ${code})`:''}`;
  };
  const checks = {
    async start(botId, actor) {
      if(actor!==primaryId) throw new Error('Primary administrator required');
      const nonce=crypto.randomUUID().replaceAll('-','').slice(0,16);
      await run("INSERT INTO service_checks(nonce,bot_id,owner_id,group_id,stage,expires_at) VALUES(?,?,?,?,'waiting',?)",nonce,botId,actor,groupId,new Date(Date.now()+20*60000).toISOString());
      return nonce;
    },
    async message(botId,message) {
      const close=/^\/close(?:@([a-z0-9_]+))?\s*$/i.exec(message.text||'');
      if(close && String(message.chat?.id)===String(groupId) && Number.isSafeInteger(Number(message.message_thread_id))) {
        if (managerActive) return false;
        if(close[1] && close[1].toLowerCase()!==String(username(botId)||'').toLowerCase()) return false;
        const check=await one("SELECT owner_id FROM service_checks WHERE bot_id=? AND group_id=? AND thread_id=? AND stage='done' LIMIT 1",
          botId,groupId,Number(message.message_thread_id));
        if(!check) return false;
        if(message.from?.id!==primaryId || check.owner_id!==primaryId) return true;
        const result=await send(botId,'closeForumTopic',{chat_id:groupId,message_thread_id:Number(message.message_thread_id)});
        const closed=result.ok || alreadyClosed(result);
        const language=locale(botId);
        const closedCopy={ru:'Тестовая тема закрыта.',en:'Test topic closed.',es:'Tema de prueba cerrado.',zh:'测试话题已关闭。'};
        const failure=closeFailure(result, language);
        const failedCopy={ru:`Не удалось закрыть тестовую тему: ${failure}. Проверьте права сервисного бота и повторите /close в теме.`,
          en:`Could not close the test topic: ${failure}. Check the service bot permissions and retry /close in the topic.`,
          es:`No se pudo cerrar el tema de prueba: ${failure}. Revise los permisos del bot de soporte y repita /close en el tema.`,
          zh:`无法关闭测试话题：${failure}。请检查服务机器人的权限，并在话题中重试 /close。`};
        await send(botId,'sendMessage',{chat_id:primaryId,text:closed
          ? closedCopy[language] || closedCopy.en : failedCopy[language] || failedCopy.en});
        return true;
      }
      const match=/^\/start(?:@\w+)? qc_([a-f0-9]{16})$/.exec(message.text||'');
      const reply=/^\/check ([a-f0-9]{16})$/.exec(message.text||'');
      if(!match&&!reply)return false;
      const nonce=(match||reply)[1],say=(r,e)=>checkText(locale(botId),r,e);
      const row=await one('SELECT * FROM service_checks WHERE nonce=? AND bot_id=?',nonce,botId);
      if(message.from?.id!==primaryId || !row || row.owner_id!==primaryId || row.group_id!=null && Number(row.group_id)!==Number(groupId))return true;
      if(match && message.chat?.type!=='private' || reply && (String(message.chat?.id)!==String(groupId)||Number(message.message_thread_id)!==row.thread_id))return true;
      if(row.expires_at<=now() || ![match?'waiting':'reply'].includes(row.stage))return true;
      // Claim before Telegram. An unknown outcome stays explicit and is never replayed.
      const claimed=await one('UPDATE service_checks SET stage=? WHERE nonce=? AND stage=? RETURNING nonce',match?'creating':'sending',nonce,row.stage);
      if(!claimed)return true;
      if(match) {
        const topic=await send(botId,'createForumTopic',{chat_id:groupId,name:say('🧪 Проверка ','🧪 Check ')+nonce.slice(0,6)});
        if(!topic.ok || !topic.result?.message_thread_id) {await run("UPDATE service_checks SET stage='unconfirmed' WHERE nonce=?",nonce);return true;}
        const thread=topic.result.message_thread_id;
        await run('UPDATE service_checks SET thread_id=?,inbound_at=? WHERE nonce=?',thread,now(),nonce);
        const shown=await send(botId,'sendMessage',{chat_id:groupId,message_thread_id:thread,text:say('Изолированная проверка: входящее получено, тема создана. Нажмите кнопку для контрольного ответа в ваш личный чат.','Isolated check: incoming received, topic created. Press the button for a control reply to your private chat.'),reply_markup:{inline_keyboard:[[{text:say('Проверить ответ','Check reply'),callback_data:'qc:reply:'+nonce}]]}});
        await run('UPDATE service_checks SET stage=? WHERE nonce=?',shown.ok?'reply':'unconfirmed',nonce);
        await send(botId,'sendMessage',{chat_id:primaryId,text:say('Входящее получено. Завершите проверку в тестовой теме.','Incoming received. Finish the check in the test topic.'),reply_markup:{inline_keyboard:[[{text:say('Тестовая тема','Test topic'),url:`https://t.me/c/${String(groupId).replace(/^-100/,'')}/${thread}`}]]}});
      } else {
        const sent=await send(botId,'sendMessage',{chat_id:primaryId,text:say('✅ Изолированная проверка завершена: входящее → тема → подтверждённый ответ.','✅ Isolated check completed: incoming → topic → confirmed reply.')});
        await run('UPDATE service_checks SET stage=?,outbound_at=? WHERE nonce=?',sent.ok?'done':'unconfirmed',sent.ok?now():null,nonce);
        await send(botId,'sendMessage',{chat_id:groupId,message_thread_id:row.thread_id,text:sent.ok?say('✅ Telegram подтвердил ответ. Тестовая тема закрывается.','✅ Telegram confirmed the reply. Closing the test topic.'):say('Результат ответа не подтверждён. Проверяйте личный чат перед новым тестом.','Reply outcome is unconfirmed. Inspect the private chat before starting another check.')});
        if(sent.ok) {
          const closed=await send(botId,'closeForumTopic',{chat_id:groupId,message_thread_id:row.thread_id});
          if(!closed.ok && !alreadyClosed(closed))
            await send(botId,'sendMessage',{chat_id:primaryId,text:({
              ru:`Контрольный обмен завершён, но тестовую тему не удалось закрыть: ${closeFailure(closed,'ru')}. Повторите /close в этой теме.`,
              en:`The check finished, but the test topic could not be closed: ${closeFailure(closed,'en')}. Retry /close in that topic.`,
              es:`La comprobación terminó, pero no se pudo cerrar el tema de prueba: ${closeFailure(closed,'es')}. Repita /close en ese tema.`,
              zh:`检查已完成，但无法关闭测试话题：${closeFailure(closed,'zh')}。请在该话题中重试 /close。`,
            })[locale(botId)] || `The check finished, but the test topic could not be closed: ${closeFailure(closed,'en')}. Retry /close in that topic.`});
        }
      }
      return true;
    },
    async callback(botId,query) {
      const nonce=/^qc:reply:([a-f0-9]{16})$/.exec(query.data||'')?.[1];
      if(!nonce)return;
      await send(botId,'answerCallbackQuery',{callback_query_id:query.id,text:query.from?.id===primaryId?'':checkText(locale(botId),'Только главный администратор.','Primary administrator only.')});
      return checks.message(botId,{...query.message,from:query.from,text:'/check '+nonce});
    },
  };
  return checks;
}
