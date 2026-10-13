const iso = value => (value instanceof Date ? value : new Date(value)).toISOString();
const time = value => new Date(value).getTime();
const stamp = () => new Date().toISOString();

export async function getServiceOwners(db, botId) {
  return await db.prepare('SELECT * FROM service_responsibility WHERE bot_id=?').bind(botId).first()
    || {bot_id:botId,primary_id:null,backup_id:null,reminder_minutes:30,fallback_minutes:60};
}

export async function setServiceOwners(db,{botId,primaryId=null,backupId=null,reminderMinutes=30,fallbackMinutes=60,at=new Date()}) {
  if (!botId || (primaryId != null && (!Number.isSafeInteger(Number(primaryId)) || Number(primaryId)<=0))
    || (backupId != null && (!Number.isSafeInteger(Number(backupId)) || Number(backupId)<=0))
    || (primaryId != null && Number(primaryId)===Number(backupId))
    || !Number.isInteger(reminderMinutes) || reminderMinutes<1 || reminderMinutes>10080
    || !Number.isInteger(fallbackMinutes) || fallbackMinutes<=reminderMinutes || fallbackMinutes>20160) throw new Error('Invalid service responsibility');
  await db.prepare(`INSERT INTO service_responsibility(bot_id,primary_id,backup_id,reminder_minutes,fallback_minutes,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET primary_id=excluded.primary_id,backup_id=excluded.backup_id,
    reminder_minutes=excluded.reminder_minutes,fallback_minutes=excluded.fallback_minutes,updated_at=excluded.updated_at`)
    .bind(botId,primaryId,backupId,reminderMinutes,fallbackMinutes,iso(at)).run();
  return getServiceOwners(db,botId);
}

export async function markManagerDmStarted(db,{operatorId,firstName=null,username=null,at=new Date()}) {
  const timestamp=iso(at);
  await db.prepare(`INSERT INTO manager_dm_status(operator_id,started_at,available,updated_at,first_name,username) VALUES(?,?,1,?,?,?)
    ON CONFLICT(operator_id) DO UPDATE SET started_at=excluded.started_at,unreachable_at=NULL,
      first_name=COALESCE(excluded.first_name,manager_dm_status.first_name),
      username=COALESCE(excluded.username,manager_dm_status.username),updated_at=excluded.updated_at`)
    .bind(operatorId,timestamp,timestamp,firstName,username).run();
}

export async function setOperatorAvailability(db,{operatorId,available,adminId=null,at=new Date()}) {
  const timestamp=iso(at);
  await db.prepare(`INSERT INTO manager_dm_status(operator_id,available,updated_at) VALUES(?,?,?)
    ON CONFLICT(operator_id) DO UPDATE SET available=excluded.available,updated_at=excluded.updated_at`)
    .bind(operatorId,available?1:0,timestamp).run();
  if (!available && adminId != null && Number(operatorId)!==Number(adminId)) {
    const replacementSql=`COALESCE(
      (SELECT p.primary_id FROM service_responsibility p JOIN manager_dm_status d ON d.operator_id=p.primary_id
        LEFT JOIN support_operators o ON o.user_id=p.primary_id WHERE p.bot_id=conversation_work.bot_id
        AND p.primary_id<>? AND d.started_at IS NOT NULL AND d.available=1 AND d.unreachable_at IS NULL
        AND (p.primary_id=? OR o.active=1)),
      (SELECT p.backup_id FROM service_responsibility p JOIN manager_dm_status d ON d.operator_id=p.backup_id
        LEFT JOIN support_operators o ON o.user_id=p.backup_id WHERE p.bot_id=conversation_work.bot_id
        AND p.backup_id<>? AND d.started_at IS NOT NULL AND d.available=1 AND d.unreachable_at IS NULL
        AND (p.backup_id=? OR o.active=1)),?)`;
    const replacementArgs=[operatorId,adminId,operatorId,adminId,adminId];
    // Three bounded statements cover the entire queue, independent of its size.
    // A partial interruption is recovered by Cron; a stale recipient cannot be claimed.
    await db.prepare(`UPDATE service_notification_outbox SET status='cancelled'
      WHERE recipient_id=? AND status IN ('pending','retryable')`).bind(operatorId).run();
    await db.prepare(`INSERT INTO service_notification_outbox
      (bot_id,user_id,notification_cycle,kind,recipient_id,group_id,thread_id,available_at,created_at)
      SELECT conversation_work.bot_id,conversation_work.user_id,conversation_work.notification_cycle,
        'transfer',${replacementSql},c.support_group_id,c.thread_id,?,?
      FROM conversation_work JOIN conversations c ON c.bot_id=conversation_work.bot_id
        AND c.user_id=conversation_work.user_id
      WHERE conversation_work.assigned_to=? AND conversation_work.state<>'resolved'
        AND conversation_work.notification_cycle>0 AND c.thread_id>1
      ON CONFLICT(bot_id,user_id,notification_cycle,kind,recipient_id) DO NOTHING`)
      .bind(...replacementArgs,timestamp,timestamp,operatorId).run();
    await db.prepare(`UPDATE conversation_work SET assigned_to=${replacementSql},revision=revision+1,updated_at=?
      WHERE assigned_to=? AND state<>'resolved'`)
      .bind(...replacementArgs,timestamp,operatorId).run();
  }
}

async function canReceive(db,operatorId,adminId) {
  if (operatorId == null) return false;
  const row=await db.prepare(`SELECT d.started_at,d.available,d.unreachable_at,o.active
    FROM manager_dm_status d LEFT JOIN support_operators o ON o.user_id=d.operator_id WHERE d.operator_id=?`)
    .bind(operatorId).first();
  return Boolean(row?.started_at && row.available && !row.unreachable_at &&
    (Number(operatorId)===Number(adminId) || row.active===1));
}

async function preferredAssignee(db,botId,adminId,exclude=null) {
  const owners=await getServiceOwners(db,botId);
  for (const id of [owners.primary_id,owners.backup_id]) {
    if (id!=null && Number(id)!==Number(exclude) && await canReceive(db,id,adminId)) return Number(id);
  }
  return Number(adminId);
}

export async function ensureServiceAssignee(db,{botId,userId,adminId,at=new Date()}) {
  const work=await db.prepare('SELECT * FROM conversation_work WHERE bot_id=? AND user_id=?').bind(botId,userId).first();
  if (!work || work.state==='resolved') return work;
  if (work.assigned_to!=null && await canReceive(db,work.assigned_to,adminId)) return work;
  const selected=await preferredAssignee(db,botId,adminId,work.assigned_to);
  if (Number(work.assigned_to)===selected) return work;
  await db.prepare(`UPDATE conversation_work SET assigned_to=?,revision=revision+1,updated_at=?
    WHERE bot_id=? AND user_id=? AND revision=? AND state<>'resolved'`)
    .bind(selected,iso(at),botId,userId,work.revision).run();
  return db.prepare('SELECT * FROM conversation_work WHERE bot_id=? AND user_id=?').bind(botId,userId).first();
}

export async function reassignUnavailableWork(db,{adminId,botId=null,at=new Date(),limit=100}) {
  const serviceFilter=botId==null?'':' AND w.bot_id=?';
  const rows=(await db.prepare(`SELECT w.bot_id,w.user_id,w.assigned_to FROM conversation_work w
    LEFT JOIN manager_dm_status d ON d.operator_id=w.assigned_to
    LEFT JOIN support_operators o ON o.user_id=w.assigned_to
    WHERE w.assigned_to IS NOT NULL AND w.assigned_to<>? AND w.state<>'resolved'${serviceFilter}
      AND (d.started_at IS NULL OR d.available=0 OR d.unreachable_at IS NOT NULL
        OR COALESCE(o.active,0)=0)
    ORDER BY w.updated_at LIMIT ?`).bind(adminId,...(botId==null?[]:[botId]),Math.max(1,Math.min(500,limit))).all()).results||[];
  let changed=0;
  for (const row of rows) {
    if (await canReceive(db,row.assigned_to,adminId)) continue;
    const next=await ensureServiceAssignee(db,{botId:row.bot_id,userId:row.user_id,adminId,at});
    if (next?.assigned_to!==row.assigned_to) {
      changed++;
      const route=await db.prepare('SELECT support_group_id,thread_id FROM conversations WHERE bot_id=? AND user_id=?')
        .bind(row.bot_id,row.user_id).first();
      if (route) await queueTransferNotice(db,{botId:row.bot_id,userId:row.user_id,
        groupId:route.support_group_id,threadId:route.thread_id,at});
    }
  }
  return changed;
}

async function insertNotice(db,{botId,userId,cycle,kind,recipientId,groupId,threadId,note=null,at}) {
  if (!Number.isSafeInteger(Number(groupId)) || !Number.isSafeInteger(Number(threadId)) || Number(threadId)===1) return null;
  await db.prepare(`INSERT INTO service_notification_outbox
    (bot_id,user_id,notification_cycle,kind,recipient_id,group_id,thread_id,note,available_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_id,user_id,notification_cycle,kind,recipient_id)
    DO UPDATE SET status=CASE WHEN service_notification_outbox.status='cancelled' THEN 'pending'
        ELSE service_notification_outbox.status END,
      available_at=CASE WHEN service_notification_outbox.status='cancelled' THEN excluded.available_at
        ELSE service_notification_outbox.available_at END,
      group_id=excluded.group_id,thread_id=excluded.thread_id,
      note=COALESCE(excluded.note,service_notification_outbox.note)
    WHERE service_notification_outbox.status IN ('cancelled','pending','retryable')`)
    .bind(botId,userId,cycle,kind,recipientId,groupId,threadId,note,iso(at),iso(at)).run();
  return db.prepare(`SELECT * FROM service_notification_outbox WHERE bot_id=? AND user_id=?
    AND notification_cycle=? AND kind=? AND recipient_id=?`).bind(botId,userId,cycle,kind,recipientId).first();
}

// Call only after the customer message has a confirmed destination in the support topic.
export async function queueInboundNotice(db,{botId,userId,adminId,groupId,threadId,delivered=false,at=new Date()}) {
  if (!delivered) return null;
  const work=await ensureServiceAssignee(db,{botId,userId,adminId,at});
  if (!work || work.state==='resolved' || work.notification_cycle<1 || !work.cycle_started_at) return null;
  const notice=await insertNotice(db,{botId,userId,cycle:work.notification_cycle,kind:work.notification_cycle===1?'new':'reply',
    recipientId:work.assigned_to,groupId,threadId,at});
  await markSentNoticeLinksForRoute(db,{botId,userId,groupId,threadId});
  if (notice && Number(notice.group_id)!==Number(groupId)) {
    return queueTransferNotice(db,{botId,userId,groupId,threadId,
      note:'Группа сервиса изменилась. Откройте актуальную тему.',at});
  }
  return notice;
}

export async function markSentNoticeLinksForRoute(db,{botId,userId,groupId,threadId}) {
  return db.prepare(`UPDATE service_notification_outbox
    SET group_id=?,thread_id=?,error_code='link_refresh_pending'
    WHERE bot_id=? AND user_id=? AND status='sent'
      AND notification_cycle=(SELECT notification_cycle FROM conversation_work WHERE bot_id=? AND user_id=?)
      AND (group_id<>? OR thread_id<>?)`)
    .bind(groupId,threadId,botId,userId,botId,userId,groupId,threadId).run();
}

// Editing an existing button is idempotent even when Telegram's response is lost.
// The route comparison prevents a late edit result from clearing a newer move.
export async function syncNextSentNoticeLink(db,{botId=null,edit}) {
  const serviceFilter=botId==null?'':' AND bot_id=?';
  const row=await db.prepare(`SELECT n.id,n.recipient_id,n.telegram_message_id,n.group_id,n.thread_id,
      COALESCE(p.language,'en') AS recipient_locale
    FROM service_notification_outbox n LEFT JOIN manager_operator_preferences p ON p.operator_id=n.recipient_id
    WHERE n.status='sent' AND n.error_code='link_refresh_pending'
      ${serviceFilter} ORDER BY id LIMIT 1`).bind(...(botId==null?[]:[botId])).first();
  if (!row) return null;
  let result;
  try { result=await edit(row); }
  catch (error) { result={ok:false,deliveryUncertain:true,description:error?.message||'edit_exception'}; }
  const confirmed=result?.ok || /message is not modified/i.test(result?.description||'');
  if (confirmed) await db.prepare(`UPDATE service_notification_outbox SET error_code=NULL
    WHERE id=? AND group_id=? AND thread_id=? AND error_code='link_refresh_pending'`)
    .bind(row.id,row.group_id,row.thread_id).run();
  else if (!result?.deliveryUncertain && Number(result?.errorCode||result?.httpStatus)===400)
    await db.prepare(`UPDATE service_notification_outbox SET error_code='link_refresh_failed'
      WHERE id=? AND group_id=? AND thread_id=? AND error_code='link_refresh_pending'`)
      .bind(row.id,row.group_id,row.thread_id).run();
  return {row,confirmed};
}

export async function queueTransferNotice(db,{botId,userId,groupId,threadId,note='',at=new Date()}) {
  const work=await db.prepare('SELECT * FROM conversation_work WHERE bot_id=? AND user_id=?').bind(botId,userId).first();
  if (!work || work.state==='resolved' || !work.assigned_to || work.notification_cycle<1) return null;
  await db.prepare(`UPDATE service_notification_outbox SET status='cancelled' WHERE bot_id=? AND user_id=?
    AND notification_cycle=? AND status IN ('pending','retryable') AND recipient_id<>?`)
    .bind(botId,userId,work.notification_cycle,work.assigned_to).run();
  return insertNotice(db,{botId,userId,cycle:work.notification_cycle,kind:'transfer',recipientId:work.assigned_to,groupId,threadId,note,at});
}

export async function stageDueNotices(db,{adminId,botId=null,at=new Date(),limit=50}) {
  const timestamp=iso(at);
  await reassignUnavailableWork(db,{adminId,botId,at,limit});
  const serviceFilter=botId==null?'':' AND bot_id=?';
  const unassigned=(await db.prepare(`SELECT bot_id,user_id FROM conversation_work
    WHERE assigned_to IS NULL AND notification_cycle>0 AND state='needs_reply'
      ${serviceFilter}
    ORDER BY cycle_started_at LIMIT ?`).bind(...(botId==null?[]:[botId]),Math.max(1,Math.min(500,limit))).all()).results||[];
  for (const row of unassigned) await ensureServiceAssignee(db,{botId:row.bot_id,userId:row.user_id,adminId,at});
  await db.prepare(`UPDATE service_notification_outbox SET status='cancelled' WHERE status IN ('pending','retryable')
    ${serviceFilter}
    AND NOT EXISTS(SELECT 1 FROM conversation_work w WHERE w.bot_id=service_notification_outbox.bot_id
    AND w.user_id=service_notification_outbox.user_id AND w.notification_cycle=service_notification_outbox.notification_cycle
    AND (service_notification_outbox.kind='transfer' AND w.state<>'resolved'
      OR w.state='needs_reply' OR (w.state='snoozed' AND w.snoozed_until<=?))
    AND (service_notification_outbox.kind='fallback' OR service_notification_outbox.recipient_id=w.assigned_to)
    AND NOT (service_notification_outbox.kind='fallback' AND service_notification_outbox.recipient_id<>?
      AND (EXISTS(SELECT 1 FROM manager_dm_status d WHERE d.operator_id=service_notification_outbox.recipient_id
        AND (d.available=0 OR d.unreachable_at IS NOT NULL))
        OR EXISTS(SELECT 1 FROM support_operators o WHERE o.user_id=service_notification_outbox.recipient_id AND o.active=0))))`)
    .bind(...(botId==null?[]:[botId]),timestamp,adminId).run();
  const rows=(await db.prepare(`SELECT w.bot_id,w.user_id,w.notification_cycle,w.cycle_started_at,w.assigned_to,
    c.support_group_id group_id,c.thread_id,COALESCE(p.reminder_minutes,30) reminder_minutes,
    COALESCE(p.fallback_minutes,60) fallback_minutes,p.backup_id,
    EXISTS(SELECT 1 FROM service_notification_outbox t WHERE t.bot_id=w.bot_id AND t.user_id=w.user_id
      AND t.notification_cycle=w.notification_cycle AND t.kind='transfer' AND t.recipient_id=w.assigned_to
      AND t.status<>'cancelled') has_transfer,
    EXISTS(SELECT 1 FROM service_notification_outbox n WHERE n.bot_id=w.bot_id AND n.user_id=w.user_id
      AND n.notification_cycle=w.notification_cycle AND n.recipient_id=w.assigned_to
      AND n.kind IN ('new','reply') AND n.status IN ('sent','uncertain')
      AND n.group_id<>c.support_group_id) moved_notice
    FROM conversation_work w JOIN conversations c ON c.bot_id=w.bot_id AND c.user_id=w.user_id
    LEFT JOIN service_responsibility p ON p.bot_id=w.bot_id
    WHERE w.notification_cycle>0 AND w.cycle_started_at IS NOT NULL AND w.assigned_to IS NOT NULL
    ${botId==null?'':' AND w.bot_id=?'}
    AND (w.state='needs_reply' OR (w.state='snoozed' AND w.snoozed_until<=?))
    AND (EXISTS(SELECT 1 FROM message_delivery_attempts a WHERE a.bot_id=w.bot_id AND a.user_id=w.user_id
      AND a.direction='user_to_support' AND a.completed_at IS NOT NULL AND a.target_message_id IS NOT NULL
      AND a.target_chat_id=c.support_group_id AND COALESCE(a.source_created_at,a.started_at)>=w.cycle_started_at)
      OR EXISTS(SELECT 1 FROM media_group_items m JOIN media_groups g ON g.bot_id=m.bot_id
        AND g.direction=m.direction AND g.media_group_id=m.media_group_id AND g.source_chat_id=m.source_chat_id
        WHERE m.bot_id=w.bot_id AND m.source_chat_id=w.user_id AND g.target_chat_id=c.support_group_id
      AND m.direction='user_to_support' AND m.delivered_at IS NOT NULL AND m.target_message_id IS NOT NULL
      AND COALESCE(m.source_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',m.received_at/1000.0,'unixepoch'))>=w.cycle_started_at)
      OR EXISTS(SELECT 1 FROM pending_messages p WHERE p.bot_id=w.bot_id AND p.user_id=w.user_id
        AND p.delivery_completed_at IS NOT NULL AND p.target_message_id IS NOT NULL
        AND p.target_thread_id=c.thread_id AND COALESCE(p.source_created_at,p.created_at)>=w.cycle_started_at)
      OR EXISTS(SELECT 1 FROM message_mappings mm WHERE mm.bot_id=w.bot_id AND mm.user_id=w.user_id
        AND mm.thread_id=c.thread_id AND mm.user_message_id=w.last_inbound_message_id AND mm.support_message_id IS NOT NULL
        AND mm.created_at>=w.cycle_started_at))
    AND ((NOT EXISTS(SELECT 1 FROM service_notification_outbox n WHERE n.bot_id=w.bot_id AND n.user_id=w.user_id
        AND n.notification_cycle=w.notification_cycle AND n.kind=CASE WHEN w.notification_cycle=1 THEN 'new' ELSE 'reply' END
        AND n.recipient_id=w.assigned_to)
      AND NOT EXISTS(SELECT 1 FROM service_notification_outbox t WHERE t.bot_id=w.bot_id AND t.user_id=w.user_id
        AND t.notification_cycle=w.notification_cycle AND t.kind='transfer' AND t.recipient_id=w.assigned_to
        AND t.status<>'cancelled'))
      OR (strftime('%s',?) - strftime('%s',w.cycle_started_at)>=60*COALESCE(p.reminder_minutes,30)
      AND NOT EXISTS(SELECT 1 FROM service_notification_outbox n WHERE n.bot_id=w.bot_id AND n.user_id=w.user_id
        AND n.notification_cycle=w.notification_cycle AND n.kind='reminder' AND n.recipient_id=w.assigned_to))
      OR (w.assigned_to<>? AND strftime('%s',?) - strftime('%s',w.cycle_started_at)>=60*COALESCE(p.fallback_minutes,60)
      AND NOT EXISTS(SELECT 1 FROM service_notification_outbox n WHERE n.bot_id=w.bot_id AND n.user_id=w.user_id
        AND n.notification_cycle=w.notification_cycle AND n.kind='fallback' AND n.status<>'cancelled'))
      OR (EXISTS(SELECT 1 FROM service_notification_outbox n WHERE n.bot_id=w.bot_id AND n.user_id=w.user_id
        AND n.notification_cycle=w.notification_cycle AND n.recipient_id=w.assigned_to
        AND n.kind IN ('new','reply') AND n.status IN ('sent','uncertain')
        AND n.group_id<>c.support_group_id)))
    ORDER BY w.cycle_started_at LIMIT ?`).bind(...(botId==null?[]:[botId]),timestamp,timestamp,adminId,timestamp,Math.max(1,Math.min(500,limit))).all()).results||[];
  let staged=0;
  for (const row of rows) {
    const elapsed=time(timestamp)-time(row.cycle_started_at);
    if (row.moved_notice) await markSentNoticeLinksForRoute(db,{
      botId:row.bot_id,userId:row.user_id,groupId:row.group_id,threadId:row.thread_id});
    if (!row.has_transfer) await insertNotice(db,{botId:row.bot_id,userId:row.user_id,cycle:row.notification_cycle,
      kind:row.notification_cycle===1?'new':'reply',recipientId:row.assigned_to,
      groupId:row.group_id,threadId:row.thread_id,at});
    if (row.moved_notice && !row.has_transfer) await queueTransferNotice(db,{
      botId:row.bot_id,userId:row.user_id,groupId:row.group_id,threadId:row.thread_id,
      note:'Группа сервиса изменилась. Откройте актуальную тему.',at});
    if (elapsed>=row.reminder_minutes*60000) {
      await insertNotice(db,{botId:row.bot_id,userId:row.user_id,cycle:row.notification_cycle,kind:'reminder',
        recipientId:row.assigned_to,groupId:row.group_id,threadId:row.thread_id,at});
      staged++;
    }
    if (elapsed>=row.fallback_minutes*60000) {
      const recipient=row.backup_id && Number(row.backup_id)!==Number(row.assigned_to)
        && await canReceive(db,row.backup_id,adminId)?Number(row.backup_id):Number(adminId);
      if (recipient!==Number(row.assigned_to)) {
        await insertNotice(db,{botId:row.bot_id,userId:row.user_id,cycle:row.notification_cycle,kind:'fallback',
          recipientId:recipient,groupId:row.group_id,threadId:row.thread_id,at});
        staged++;
      }
    }
  }
  return staged;
}

export async function markExpiredClaimsUncertain(db,{botId=null,at=new Date(),claimMinutes=10}={}) {
  const cutoff=new Date(time(at)-claimMinutes*60000).toISOString();
  const serviceFilter=botId==null?'':' AND bot_id=?';
  return db.prepare(`UPDATE service_notification_outbox SET status='uncertain',claim_token=NULL,error_code='claim_expired'
    WHERE status='sending' AND claimed_at<=?${serviceFilter}`).bind(cutoff,...(botId==null?[]:[botId])).run();
}

// Retain the current unresolved cycle: its terminal rows still prevent a
// reminder or fallback from being staged and sent a second time.
export function terminalNoticePruneStatement(db,{at=new Date(),limit=100}={}) {
  const days=amount=>new Date(time(at)-amount*86_400_000).toISOString();
  return db.prepare(`DELETE FROM service_notification_outbox WHERE id IN (
    SELECT n.id FROM service_notification_outbox n
    WHERE ((n.status IN ('sent','cancelled') AND n.created_at<?)
      OR (n.status IN ('failed','uncertain') AND n.created_at<?))
      AND NOT EXISTS(SELECT 1 FROM conversation_work w
        WHERE w.bot_id=n.bot_id AND w.user_id=n.user_id
          AND w.notification_cycle=n.notification_cycle AND w.state<>'resolved')
    ORDER BY n.created_at,n.id LIMIT ?
  )`).bind(days(30),days(180),Math.max(1,Math.min(100,limit)));
}

export async function claimNextNotice(db,{at=new Date(),botId=null}={}) {
  await markExpiredClaimsUncertain(db,{botId,at});
  const token=crypto.randomUUID(),timestamp=iso(at);
  const serviceFilter=botId==null?'':' AND n.bot_id=?';
  return db.prepare(`UPDATE service_notification_outbox SET status='sending',claim_token=?,claimed_at=?
    WHERE id=(SELECT n.id FROM service_notification_outbox n JOIN conversation_work w
      ON w.bot_id=n.bot_id AND w.user_id=n.user_id AND w.notification_cycle=n.notification_cycle
      WHERE n.status IN ('pending','retryable') AND n.available_at<=?${serviceFilter}
        AND (n.kind='transfer' AND w.state<>'resolved'
          OR w.state='needs_reply' OR (w.state='snoozed' AND w.snoozed_until<=?))
        AND (n.kind='fallback' OR n.recipient_id=w.assigned_to)
        AND NOT EXISTS(SELECT 1 FROM manager_dm_status d WHERE d.operator_id=n.recipient_id
          AND (d.available=0 OR d.unreachable_at IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM support_operators o WHERE o.user_id=n.recipient_id AND o.active=0)
      ORDER BY n.available_at,n.id LIMIT 1)
    AND status IN ('pending','retryable') RETURNING *`).bind(token,timestamp,timestamp,...(botId==null?[]:[botId]),timestamp).first();
}

export async function dispatchNextNotice(db,{botId,adminId,send,at=new Date()}) {
  const notice=await claimNextNotice(db,{botId,at});
  if (!notice) return null;
  let result;
  try { result=await send(notice); }
  catch (error) { result={ok:false,deliveryUncertain:true,description:error?.message||'send_exception'}; }
  const key={id:notice.id,claimToken:notice.claim_token};
  if (result?.ok) {
    const messageId=Number(result.result?.message_id);
    if (Number.isSafeInteger(messageId) && messageId>0)
      return markNoticeSent(db,{...key,telegramMessageId:messageId,at});
    return markNoticeUncertain(db,{...key,errorCode:'missing_message_id'});
  }
  const code=Number(result?.errorCode||result?.httpStatus)||0;
  if (result?.deliveryUncertain || (code>=500 && code<600))
    return markNoticeUncertain(db,{...key,errorCode:code?`telegram_${code}`:'telegram_outcome_unknown'});
  if (code===429 || result?.rateLimited) {
    const wait=Math.max(1,Number(result?.retryAfterSeconds)||60);
    return markNoticeRetryable(db,{...key,after:new Date(time(at)+wait*1000),errorCode:'telegram_429'});
  }
  return markNoticeFailed(db,{...key,errorCode:code?`telegram_${code}`:'telegram_failed',
    unreachable:code===400||code===403,adminId,at});
}

export async function markNoticeSent(db,{id,claimToken,telegramMessageId,at=new Date()}) {
  if (!Number.isSafeInteger(Number(telegramMessageId)) || Number(telegramMessageId)<=0) throw new Error('Telegram message ID required');
  return db.prepare(`UPDATE service_notification_outbox SET status='sent',telegram_message_id=?,sent_at=?,claim_token=NULL,
      error_code=CASE WHEN EXISTS(SELECT 1 FROM conversations c WHERE c.bot_id=service_notification_outbox.bot_id
        AND c.user_id=service_notification_outbox.user_id
        AND (c.support_group_id<>service_notification_outbox.group_id OR c.thread_id<>service_notification_outbox.thread_id))
        THEN 'link_refresh_pending' ELSE NULL END,
      group_id=COALESCE((SELECT c.support_group_id FROM conversations c WHERE c.bot_id=service_notification_outbox.bot_id
        AND c.user_id=service_notification_outbox.user_id),group_id),
      thread_id=COALESCE((SELECT c.thread_id FROM conversations c WHERE c.bot_id=service_notification_outbox.bot_id
        AND c.user_id=service_notification_outbox.user_id),thread_id)
    WHERE id=? AND claim_token=? AND status='sending' RETURNING *`)
    .bind(telegramMessageId,iso(at),id,claimToken).first();
}

export async function markNoticeRetryable(db,{id,claimToken,after,errorCode='retryable'}) {
  return db.prepare(`UPDATE service_notification_outbox SET status='retryable',available_at=?,claim_token=NULL,error_code=?
    WHERE id=? AND claim_token=? AND status='sending' RETURNING *`)
    .bind(iso(after),errorCode,id,claimToken).first();
}

export async function markNoticeUncertain(db,{id,claimToken,errorCode='unknown'}) {
  return db.prepare(`UPDATE service_notification_outbox SET status='uncertain',claim_token=NULL,error_code=?
    WHERE id=? AND claim_token=? AND status='sending' RETURNING *`)
    .bind(errorCode,id,claimToken).first();
}

export async function markNoticeFailed(db,{id,claimToken,errorCode='failed',unreachable=false,adminId=null,at=new Date()}) {
  const result=await db.prepare(`UPDATE service_notification_outbox SET status='failed',claim_token=NULL,error_code=?
    WHERE id=? AND claim_token=? AND status='sending' RETURNING *`).bind(errorCode,id,claimToken).first();
  if (result && unreachable) {
    await db.prepare(`UPDATE manager_dm_status SET unreachable_at=?,updated_at=? WHERE operator_id=?`)
      .bind(iso(at),iso(at),result.recipient_id).run();
    if (adminId!=null) {
      if (result.kind==='fallback' && Number(result.recipient_id)!==Number(adminId))
        await insertNotice(db,{botId:result.bot_id,userId:result.user_id,cycle:result.notification_cycle,
          kind:'fallback',recipientId:Number(adminId),groupId:result.group_id,threadId:result.thread_id,at});
      const work=await ensureServiceAssignee(db,{botId:result.bot_id,userId:result.user_id,adminId,at});
      if (result.kind!=='fallback' && work?.assigned_to && Number(work.assigned_to)!==Number(result.recipient_id))
        await insertNotice(db,{botId:result.bot_id,userId:result.user_id,cycle:result.notification_cycle,
          kind:result.kind,recipientId:work.assigned_to,
          groupId:result.group_id,threadId:result.thread_id,note:result.note,at});
    }
  }
  return result;
}
