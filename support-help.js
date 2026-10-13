import { messageDeletionWarning } from './message-deletion-copy.js';

const HELP = {
  ru: {
    reply: ['Как ответить?', 'Откройте «Нужен ответ», выберите обращение и нажмите «Открыть переписку». Отправьте сообщение или файл в теме пользователя.\n\nСообщение из закрытой темы тоже отправляется клиенту. Тема открывается, когда клиент отвечает. Кнопки управления и команды клиенту не пересылаются.'],
    transfer: ['Как передать обращение?', 'В карточке нажмите «Передать», выберите коллегу и добавьте внутреннюю заметку. Проверьте текст и подтвердите передачу. Клиент заметку не получит.\n\n«Мои» показывает назначенные вам обращения. «Отложить» вернёт обращение в очередь через час или завтра в 09:00 по Будапешту.'],
    access: ['Как ограничить пользователя?', 'Найдите пользователя через поиск или откройте «Ещё → Доступ и модерация» в карточке обращения. Выберите действие и проверьте его последствия перед подтверждением.\n\nБлокировка запрещает новые входящие. Ограничение действует заданный срок. Доверие и проверка CAPTCHA управляются отдельно.'],
    delivery: ['Почему сообщение задержалось?', 'В карточке откройте «Ещё → Доставка». Экран показывает причину: проверка CAPTCHA, ограничения, отключённый сервис или ошибка доставки.\n\nЕсли результат отправки неизвестен, сначала проверьте переписку. Повтор уже доставленного сообщения может создать дубль. Главный администратор может открыть «Система → Проблемы доставки» и повторить доступные сообщения.'],
    drafts: ['Как продолжить черновик?', 'На главном экране откройте «Черновики» и выберите сохранённый ввод. «Отложить ввод» сохраняет текст и позволяет продолжать работу.\n\nЗаметку или внутреннюю причину отправляйте ответом на запрос бота. /cancel отменяет текущий ввод; сохранённые черновики остаются доступны.'],
    commands: (primary, managerActive) => ['Список команд', managerActive
      ? '/menu — карточка текущей темы\n/info, /risk, /audit — информация о пользователе в теме\n/ban, /unban, /restrict, /unrestrict — ограничения в теме\n/trust, /untrust, /riskreset — доверие и восстановление в теме\n/cancel — отменить ввод\n\nВ личке Админушки: /menu — обращения, /users — список, /user — поиск, /audit — журнал действий, /storage — хранилище. Настройки сервисов и реакций — в карточке сервиса.'
      : '/menu — меню или карточка темы\n/user <ID | @username | имя> — поиск\n/users — пользователи\n/info, /risk, /audit — информация о пользователе\n/ban, /unban, /restrict, /unrestrict — ограничения\n/trust, /untrust, /riskreset — доверие и восстановление\n/close, /open — закрыть или открыть тему\n/attack on|off|auto — защита сервиса\n/cancel — отменить ввод'+(primary?'\n\n/bots — сервисы\n/operators — команда\n/messages — сообщения сервисов\n/storage — хранилище\n/selfcheck — проверка подключения':'')],
  },
  en: {
    reply: ['How do I reply?', 'Open Needs reply, choose a conversation and press Open conversation. Send a message or file in the user’s topic.\n\nMessages sent in a closed topic still reach the customer. The topic reopens when the customer replies. Management buttons and commands are not relayed to customers.'],
    transfer: ['How do I transfer work?', 'In the work card, press Transfer, choose a colleague and add an internal note. Review the text and confirm the transfer. The customer will not receive the note.\n\nMine shows your assigned conversations. Snooze returns work to the queue in one hour or tomorrow at 09:00 Budapest time.'],
    access: ['How do I restrict a user?', 'Find the user using search, or open More → Access and moderation in a work card. Choose an action and review its consequences before confirming.\n\nA block stops new incoming messages. A restriction lasts for the selected period. Trust and CAPTCHA are managed separately.'],
    delivery: ['Why is a message delayed?', 'Open More → Delivery in the work card. It shows the cause: CAPTCHA, restrictions, a disabled service or a delivery error.\n\nIf the send result is unknown, check the conversation first. Retrying a delivered message may duplicate it. The primary administrator can open System → Delivery issues and retry eligible messages.'],
    drafts: ['How do I resume a draft?', 'Open Drafts on the home screen and select the saved input. Pause input retains the text so you can continue working.\n\nSend internal notes and reasons as replies to the bot’s prompt. /cancel cancels the current input; saved drafts remain available.'],
    commands: (primary, managerActive) => ['Command reference', managerActive
      ? '/menu — current topic card\n/info, /risk, /audit — user information in the topic\n/ban, /unban, /restrict, /unrestrict — restrictions in the topic\n/trust, /untrust, /riskreset — trust and recovery in the topic\n/cancel — cancel input\n\nIn the manager bot DM: /menu — work queue, /users — list, /user — search, /audit — action log, /storage — storage. Service and reaction settings are in the service card.'
      : '/menu — menu or topic card\n/user <ID | @username | name> — search\n/users — users\n/info, /risk, /audit — user information\n/ban, /unban, /restrict, /unrestrict — restrictions\n/trust, /untrust, /riskreset — trust and recovery\n/close, /open — close or open a topic\n/attack on|off|auto — service protection\n/cancel — cancel input'+(primary?'\n\n/bots — services\n/operators — team\n/messages — service messages\n/storage — storage\n/selfcheck — connection check':'')],
  },
  es: {
    reply: ['¿Cómo respondo?', 'Abre «Pendientes de respuesta», elige una conversación y pulsa «Abrir conversación». Envía el mensaje o archivo en el tema del usuario.\n\nLos mensajes enviados en un tema cerrado también llegan al cliente. El tema se vuelve a abrir cuando el cliente responde. Los botones de administración y los comandos no se reenvían al cliente.'],
    transfer: ['¿Cómo transfiero una conversación?', 'En la ficha, pulsa «Transferir», elige a un compañero y añade una nota interna. Revisa el texto y confirma la transferencia. El cliente no recibirá la nota.\n\n«Mías» muestra las conversaciones asignadas a ti. «Posponer» devuelve el trabajo a la cola en una hora o mañana a las 09:00, hora de Budapest.'],
    access: ['¿Cómo restrinjo a un usuario?', 'Busca al usuario o abre «Más → Acceso y moderación» en la ficha de la conversación. Elige una acción y revisa sus consecuencias antes de confirmarla.\n\nEl bloqueo impide nuevos mensajes entrantes. La restricción dura el periodo seleccionado. La confianza y la verificación CAPTCHA se gestionan por separado.'],
    delivery: ['¿Por qué se retrasó un mensaje?', 'Abre «Más → Entrega» en la ficha. La pantalla muestra el motivo: verificación CAPTCHA, restricciones, servicio desactivado o error de entrega.\n\nSi no se conoce el resultado del envío, revisa primero la conversación. Repetir un mensaje ya entregado puede duplicarlo. El administrador principal puede abrir «Sistema → Problemas de entrega» y reintentar los mensajes disponibles.'],
    drafts: ['¿Cómo continúo un borrador?', 'Abre «Borradores» en la pantalla principal y selecciona la entrada guardada. «Pausar entrada» conserva el texto para que puedas continuar después.\n\nEnvía las notas internas y los motivos respondiendo al mensaje del bot. /cancel cancela la entrada actual; los borradores guardados siguen disponibles.'],
    commands: (primary, managerActive) => ['Referencia de comandos', managerActive
      ? '/menu — ficha del tema actual\n/info, /risk, /audit — información del usuario en el tema\n/ban, /unban, /restrict, /unrestrict — restricciones en el tema\n/trust, /untrust, /riskreset — confianza y restablecimiento en el tema\n/cancel — cancelar la entrada\n\nEn el chat privado del bot administrador: /menu — cola de trabajo, /users — lista, /user — búsqueda, /audit — registro de acciones, /storage — almacenamiento. Los ajustes del servicio y las reacciones están en la ficha del servicio.'
      : '/menu — menú o ficha del tema\n/user <ID | @username | nombre> — buscar\n/users — usuarios\n/info, /risk, /audit — información del usuario\n/ban, /unban, /restrict, /unrestrict — restricciones\n/trust, /untrust, /riskreset — confianza y restablecimiento\n/close, /open — cerrar o abrir un tema\n/attack on|off|auto — protección del servicio\n/cancel — cancelar la entrada'+(primary?'\n\n/bots — servicios\n/operators — equipo\n/messages — mensajes del servicio\n/storage — almacenamiento\n/selfcheck — comprobar conexión':'')],
  },
  zh: {
    reply: ['如何回复？', '打开“待回复”，选择一条会话，然后点击“打开会话”。在用户的话题中发送消息或文件。\n\n在已关闭的话题中发送的消息仍会送达客户。客户回复后，话题会重新开启。管理按钮和命令不会转发给客户。'],
    transfer: ['如何转交会话？', '在工作卡片中点击“转交”，选择同事并添加内部备注。检查内容后确认转交。客户不会收到该备注。\n\n“我的”显示分配给你的会话。“稍后处理”会在一小时后或布达佩斯时间明天 09:00 将会话放回队列。'],
    access: ['如何限制用户？', '搜索用户，或在会话卡片中打开“更多 → 访问权限与审核”。选择操作，并在确认前查看其影响。\n\n封禁会阻止新的入站消息。限制会持续所选时长。信任状态和 CAPTCHA 验证分别管理。'],
    delivery: ['消息为何延迟？', '在工作卡片中打开“更多 → 投递”。页面会显示原因：CAPTCHA 验证、访问限制、服务已停用或投递错误。\n\n如果发送结果未知，请先检查会话。重试已送达的消息可能造成重复。主管理员可以打开“系统 → 投递问题”并重试符合条件的消息。'],
    drafts: ['如何继续草稿？', '在主屏幕打开“草稿”，然后选择已保存的输入。“暂存输入”会保留文本，方便稍后继续。\n\n内部备注和原因请回复机器人发出的提示。/cancel 会取消当前输入；已保存的草稿仍可使用。'],
    commands: (primary, managerActive) => ['命令说明', managerActive
      ? '/menu — 当前话题卡片\n/info、/risk、/audit — 话题中的用户信息\n/ban、/unban、/restrict、/unrestrict — 话题中的限制操作\n/trust、/untrust、/riskreset — 话题中的信任与恢复操作\n/cancel — 取消输入\n\n在管理机器人私聊中：/menu — 工作队列，/users — 用户列表，/user — 搜索，/audit — 操作记录，/storage — 存储。服务和表情反应设置位于服务卡片中。'
      : '/menu — 菜单或话题卡片\n/user <ID | @username | 姓名> — 搜索\n/users — 用户列表\n/info、/risk、/audit — 用户信息\n/ban、/unban、/restrict、/unrestrict — 限制操作\n/trust、/untrust、/riskreset — 信任与恢复\n/close、/open — 关闭或开启话题\n/attack on|off|auto — 服务防护\n/cancel — 取消输入'+(primary?'\n\n/bots — 服务\n/operators — 团队\n/messages — 服务消息\n/storage — 存储\n/selfcheck — 检查连接':'')],
  },
};

export function supportHelp(locale, primary, section = '', managerActive = false) {
  // Keep the historic boolean API for callers outside the worker.
  const language = locale === true ? 'ru' : locale === false ? 'en' : locale;
  const topics = HELP[language] || HELP.en;
  const topic = typeof topics[section] === 'function' ? topics[section](primary, managerActive) : topics[section];
  const labels = Object.entries(topics).map(([key, value]) => [key, ...(typeof value === 'function' ? value(primary, managerActive) : value)]);
  return {
    text: topic ? topic.join('\n\n') + (['reply', 'commands'].includes(section) ? '\n\n' + messageDeletionWarning(language) : '') : (language === 'ru' ? 'Помощь\n\nВыберите задачу, с которой нужна помощь.' : language === 'es' ? 'Ayuda\n\nElige el tema en el que necesitas ayuda.' : language === 'zh' ? '帮助\n\n请选择需要帮助的事项。' : 'Help\n\nChoose what you need help with.'),
    inline_keyboard: topic ? [] : labels.map(([key, text]) => [{ text, callback_data: `um:n:help:${key}` }]),
  };
}
