const COPY = {
  ru: {
    audit: 'Удаление сообщения',
    warning: '⚠️ Обычное удаление в Telegram оставляет сообщение у клиента. Для удаления у клиента и в теме ответьте на своё сообщение командой {command}. Обычно доступно до 48 часов после отправки.',
    reply: 'Ответьте командой /delete на своё отправленное сообщение в этой теме.',
    own: 'Можно удалить только своё сообщение, отправленное клиенту из этой темы.',
    missing: 'Подтверждённая копия у клиента не найдена. Сообщение в теме сохранено. Проверьте доставку; не удаляйте оригинал через меню Telegram.',
    failed: 'Удаление у клиента не подтверждено. Оригинал в теме сохранён. Повторите /delete ответом на него. Telegram обычно разрешает удаление до 48 часов; также возможны временные ошибки.',
    partial: 'Сообщение у клиента удалено, но удаление оригинала в теме не подтверждено. Если он остался, проверьте у сервисного бота право «Удаление сообщений» и повторите /delete ответом на оригинал.',
    done: '✅ Сообщение удалено у клиента и в теме.',
  },
  en: {
    audit: 'Message deletion',
    warning: '⚠️ Deleting through Telegram leaves the message with the customer. To delete it for the customer and in this topic, reply to your own message with {command}. Usually available within 48 hours of sending.',
    reply: 'Reply with /delete to your own sent message in this topic.',
    own: 'You can only delete your own message sent to the customer from this topic.',
    missing: 'No confirmed customer copy was found. The topic message was kept. Check delivery; do not delete the original through Telegram.',
    failed: 'Deletion for the customer was not confirmed. The topic original was kept. Reply to it with /delete again. Telegram usually allows deletion within 48 hours; temporary errors are also possible.',
    partial: 'The customer message was deleted, but deletion of the topic original was not confirmed. If it remains, check the service bot’s Delete Messages permission and reply to the original with /delete again.',
    done: '✅ Message deleted for the customer and in the topic.',
  },
  es: {
    audit: 'Eliminación de mensaje',
    warning: '⚠️ Borrar desde Telegram deja el mensaje al cliente. Para eliminarlo del chat del cliente y del tema, responde a tu propio mensaje con {command}. Normalmente está disponible durante las 48 horas posteriores al envío.',
    reply: 'Responde con /delete a tu propio mensaje enviado en este tema.',
    own: 'Solo puedes eliminar tu propio mensaje enviado al cliente desde este tema.',
    missing: 'No se encontró una copia confirmada para el cliente. Se conservó el mensaje del tema. Revisa la entrega; no borres el original desde Telegram.',
    failed: 'No se confirmó la eliminación para el cliente. Se conservó el original del tema. Vuelve a responder con /delete. Telegram normalmente permite borrar durante 48 horas; también puede haber errores temporales.',
    partial: 'Se eliminó el mensaje del cliente, pero no se confirmó la eliminación del original del tema. Si sigue ahí, comprueba el permiso Borrar mensajes del bot del servicio y vuelve a responder al original con /delete.',
    done: '✅ Mensaje eliminado del chat del cliente y del tema.',
  },
  zh: {
    audit: '删除消息',
    warning: '⚠️ 通过 Telegram 删除后，客户仍保留消息。要同时删除客户聊天和话题中的消息，请回复自己发送的消息并输入 {command}。通常仅限发送后 48 小时内。',
    reply: '请在此话题中回复自己发送的消息并输入 /delete。',
    own: '只能删除自己从此话题发送给客户的消息。',
    missing: '未找到已确认送达客户的消息副本。话题中的消息已保留。请检查投递状态，不要通过 Telegram 删除原消息。',
    failed: '尚未确认客户消息已删除。话题中的原消息已保留。请再次回复原消息并输入 /delete。Telegram 通常仅允许在发送后 48 小时内删除，也可能发生临时错误。',
    partial: '客户消息已删除，但尚未确认话题中的原消息已删除。如果原消息仍在，请检查服务机器人的删除消息权限，然后再次回复原消息并输入 /delete。',
    done: '✅ 客户聊天和话题中的消息均已删除。',
  },
};

export function messageDeletionText(locale, key) {
  return (COPY[locale] || COPY.en)[key];
}

export function messageDeletionWarning(locale, username) {
  const name = String(username || '').replace(/^@/, '');
  const command = /^\w+$/.test(name) ? `/delete@${name}` : '/delete';
  return messageDeletionText(locale, 'warning').replace('{command}', command);
}
