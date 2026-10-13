const DELIVERY_DIRECTION = "support_to_user";
const UNKNOWN_OUTCOME = "telegram_delivery_outcome_unknown";

async function first(db, sql, ...params) {
  const statement = db.prepare(sql);
  if (typeof statement.bind === "function") return statement.bind(...params).first();
  return statement.get(...params) ?? null;
}

function statusFromAttempt(row) {
  if (!row) return null;
  if (row.completed_at && row.target_message_id != null) {
    return { status: "confirmed", targetMessageId: Number(row.target_message_id), timestamp: row.completed_at };
  }
  if (row.failure_code === UNKNOWN_OUTCOME || (row.request_started_at && !row.completed_at)) {
    return { status: "unknown", reasonCode: row.failure_code || UNKNOWN_OUTCOME, timestamp: row.request_started_at || row.started_at };
  }
  if (row.failure_code) {
    return { status: "failed", reasonCode: row.failure_code, timestamp: row.completed_at || row.started_at };
  }
  return { status: "retryable", timestamp: row.started_at };
}

/** Read the persisted delivery outcome for one operator message in a support topic. */
export async function getOperatorMessageDeliveryStatus(db, { botId, sourceChatId, sourceMessageId }) {
  if (!db || botId == null || sourceChatId == null || sourceMessageId == null) {
    throw new TypeError("db, botId, sourceChatId, and sourceMessageId are required");
  }

  const attempt = await first(db, `SELECT started_at, request_started_at, completed_at, target_message_id, failure_code
    FROM message_delivery_attempts
    WHERE bot_id = ? AND direction = ? AND source_chat_id = ? AND source_message_id = ?`,
  String(botId), DELIVERY_DIRECTION, Number(sourceChatId), Number(sourceMessageId));
  const attemptStatus = statusFromAttempt(attempt);
  if (attemptStatus) return { ...attemptStatus, sourceMessageId: Number(sourceMessageId), sourceChatId: Number(sourceChatId), botId: String(botId), kind: "message" };

  const album = await first(db, `SELECT i.delivered_at, i.target_message_id, i.delivery_uncertain_at,
      i.delivery_attempt_started_at, g.request_started_at, g.delivery_completed_at, g.delivery_uncertain_at AS group_uncertain_at
    FROM media_group_items i
    LEFT JOIN media_groups g ON g.bot_id = i.bot_id AND g.direction = i.direction
      AND g.media_group_id = i.media_group_id AND g.source_chat_id = i.source_chat_id
    WHERE i.bot_id = ? AND i.direction = ? AND i.source_chat_id = ? AND i.message_id = ?`,
  String(botId), DELIVERY_DIRECTION, Number(sourceChatId), Number(sourceMessageId));
  if (album) {
    let result;
    if (album.delivered_at && album.target_message_id != null) {
      result = { status: "confirmed", targetMessageId: Number(album.target_message_id), timestamp: album.delivered_at };
    } else if (album.delivery_uncertain_at || album.group_uncertain_at || album.request_started_at) {
      result = { status: "unknown", timestamp: album.delivery_uncertain_at || album.group_uncertain_at || album.request_started_at };
    } else {
      result = { status: "retryable", timestamp: album.delivery_attempt_started_at || null };
    }
    return { ...result, sourceMessageId: Number(sourceMessageId), sourceChatId: Number(sourceChatId), botId: String(botId), kind: "album_item" };
  }

  // Absence of a durable record cannot establish whether Telegram received the message.
  return { status: "unknown", reasonCode: "delivery_record_missing", sourceMessageId: Number(sourceMessageId), sourceChatId: Number(sourceChatId), botId: String(botId), kind: "message" };
}

/** Plain-language text suitable for an operator card; never claims the client read it. */
export function formatOperatorMessageDeliveryStatus(result, locale = 'en') {
  const copy = {
    en: { confirmed: 'Delivered through Telegram; customer read status is unavailable.', retryable: 'Waiting for a safe delivery attempt.', failed: 'Not delivered: a permanent error needs attention.', unknown: 'The send result is unconfirmed. Check delivery manually; automatic retry is disabled.' },
    ru: { confirmed: 'Доставлено через Telegram; прочтение клиентом не подтверждается.', retryable: 'Ожидает безопасной попытки доставки.', failed: 'Не доставлено: требуется исправить постоянную ошибку.', unknown: 'Результат отправки не подтверждён. Проверьте доставку вручную; автоматический повтор запрещён.' },
    es: { confirmed: 'Entregado por Telegram; no se puede confirmar si el cliente lo leyó.', retryable: 'En espera de un intento de entrega seguro.', failed: 'No entregado: hay que corregir un error permanente.', unknown: 'No se confirmó el resultado del envío. Compruebe la entrega manualmente; el reintento automático está desactivado.' },
    zh: { confirmed: '已通过 Telegram 送达；无法确认客户是否已阅读。', retryable: '等待安全的投递尝试。', failed: '未送达：需要修复永久性错误。', unknown: '发送结果尚未确认。请手动检查投递状态；自动重试已禁用。' },
  }[locale] || {
    confirmed: 'Delivered through Telegram; customer read status is unavailable.', retryable: 'Waiting for a safe delivery attempt.', failed: 'Not delivered: a permanent error needs attention.', unknown: 'The send result is unconfirmed. Check delivery manually; automatic retry is disabled.',
  };
  return copy[result?.status] || copy.unknown;
}

/** Stable callback descriptor for a card's refresh/check action. */
export function operatorMessageDeliveryRefreshAction({ botId, sourceChatId, sourceMessageId }) {
  return { action: "delivery_status_refresh", botId: String(botId), sourceChatId: Number(sourceChatId), sourceMessageId: Number(sourceMessageId) };
}
