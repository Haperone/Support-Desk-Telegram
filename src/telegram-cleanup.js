export async function prepareTelegramCleanup(db, bot, body) {
  if (!Number.isSafeInteger(Number(body.chat_id)) || !Number.isSafeInteger(Number(body.message_id))) return false;
  db.recoveryCheckpoint?.(4);
  await db.prepare(`INSERT OR IGNORE INTO telegram_cleanup_jobs(bot_id, chat_id, message_id, created_at)
    VALUES (?, ?, ?, ?)`).bind(bot.id, Number(body.chat_id), Number(body.message_id), new Date().toISOString()).run();
  return true;
}
export async function settleTelegramCleanup(db, bot, body, result) {
  const terminal = isConfirmedMessageDeletion(result);
  const retry = result.retryable || result.deliveryUncertain || result.deferred;
  await db.prepare(`UPDATE telegram_cleanup_jobs SET completed_at = ?, last_error = ?
    WHERE bot_id = ? AND chat_id = ? AND message_id = ?`)
    .bind(terminal || !retry ? new Date().toISOString() : null, terminal ? null : String(result.description || '').slice(0, 200), bot.id, Number(body.chat_id), Number(body.message_id)).run();
}
export function isConfirmedMessageDeletion(result) {
  return result.ok || Number(result.errorCode) === 400
    && !result.retryable && !result.deliveryUncertain && !result.deferred && !result.rateLimited
    && /^(?:Bad Request: )?message to delete not found$/i.test(result.description || '');
}
