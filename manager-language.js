import { languageOrDefault, supportedLanguage } from './language.js';
import { messageDeletionWarning } from './message-deletion-copy.js';
import { MANAGER_LIFECYCLE_COPY } from './manager-lifecycle-copy.js';
import { MANAGER_USER_COPY } from './manager-user-copy.js';
import { MANAGER_DIAGNOSTICS_COPY } from './manager-diagnostics-copy.js';

export async function getManagerLanguage(db, actorId) {
  if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) <= 0) return 'en';
  const row = await db.prepare('SELECT language FROM manager_operator_preferences WHERE operator_id=?')
    .bind(Number(actorId)).first();
  return languageOrDefault(row?.language);
}

export async function setManagerLanguage(db, actorId, language) {
  if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) <= 0 || !supportedLanguage(language)) return false;
  await db.prepare(`INSERT INTO manager_operator_preferences(operator_id,language,updated_at)
    VALUES(?,?,?) ON CONFLICT(operator_id) DO UPDATE SET language=excluded.language,updated_at=excluded.updated_at`)
    .bind(Number(actorId), language, new Date().toISOString()).run();
  return true;
}

// Mark authored/configured content so it bypasses UI catalog matching even
// when its value happens to equal a translatable label.
export function opaqueManagerText(value) {
  return `\uE100${JSON.stringify(String(value ?? ''))}\uE101`;
}

const translations = {
  en: {
    'Статистика': 'Statistics', 'Управление поддержкой': 'Support management', 'Выберите действие или раздел.': 'Choose an action or section.',
    'Выберите сервис. Обращения клиентов остаются в темах его группы.': 'Choose a service. Customer conversations stay in that service group’s topics.',
    'Мои обращения': 'My conversations', 'Все обращения': 'All conversations', 'Просроченные': 'Overdue',
    'Просроченные обращения': 'Overdue conversations', 'Все просроченные': 'All overdue', 'Мои просроченные': 'My overdue',
    'Очереди, доставка, черновики': 'Queues, delivery, drafts', 'Очереди, доставка и черновики': 'Queues, delivery, and drafts',
    'Очереди': 'Queues', 'Пользователи': 'Users', 'Поиск': 'Search', 'Операторы': 'Operators',
    'Управление ботами поддержки': 'Support bots', 'Алерты': 'Alerts', 'Контроль и восстановление': 'Monitoring and recovery',
    'План и хранилище': 'Plan and storage', 'Журнал действий': 'Activity log', 'Помощь': 'Help', 'Меню': 'Menu',
    'Выберите язык интерфейса:': 'Choose the interface language:', 'Язык интерфейса': 'Interface language',
    'Язык сохранён.': 'Language saved.', 'Назад': 'Back', 'К сервису': 'Service', 'К списку': 'Back to list',
    'Все сервисы': 'All services', 'Фильтры': 'Filters', 'Отмена': 'Cancel', 'Подтвердить': 'Confirm',
    'Справка Админушки': 'Adminushka help', 'История устарела. Откройте карточку пользователя заново.': 'This history has expired. Reopen the user card.',
    'Записей нет.': 'No records found.', 'Скрыть коды': 'Hide codes', 'Технические коды': 'Technical codes',
    'Сервис больше не подключён.': 'This service is no longer connected.', 'Карточка устарела. Откройте список заново.': 'This card has expired. Reopen the list.',
    'Профиль больше не найден.': 'Profile not found.', 'Поиск профиля': 'Search profiles',
    'Профиль не найден.': 'Profile not found.', 'Заблокированы': 'Blocked', 'Ограниченные': 'Restricted',
    'На проверке': 'Under review', 'Подозрительные': 'Flagged', 'Доверенные': 'Trusted', 'Недавние': 'Recent',
    'обычный': 'normal', 'заблокирован': 'blocked', 'доверенный': 'trusted', 'подозрительный': 'flagged',
    'История пользователя': 'User history', 'Записей': 'Records', 'страница': 'page', 'Найдено профилей': 'Profiles found',
    'Справка': 'Help', 'Команды': 'Commands', 'Здоровье системы': 'System health', 'Черновики': 'Drafts',
    'Выберите язык интерфейса.': 'Choose the interface language.', '← Назад': '← Back',
    'Ограничены': 'Restricted', 'Состояние уже изменилось.': 'The state has changed.',
    'Людей': 'People', 'Откройте меню заново.': 'Reopen the menu.',
    'Один пользователь может иметь профиль в нескольких сервисах.': 'A user can have a profile in multiple services.',
    'Пользователей нет.': 'No users found.', 'обращение:': 'conversation:', 'открыто': 'open', 'закрыто': 'closed', 'нет темы': 'no topic',
  },
  es: {
    'Статистика': 'Estadísticas',
    'Управление поддержкой': 'Gestión de soporte', 'Выберите действие или раздел.': 'Elige una acción o sección.',
    'Выберите сервис. Обращения клиентов остаются в темах его группы.': 'Elige un servicio. Las conversaciones permanecen en los temas de su grupo.',
    'Мои обращения': 'Mis conversaciones', 'Все обращения': 'Todas las conversaciones', 'Просроченные': 'Vencidas',
    'Просроченные обращения': 'Conversaciones vencidas', 'Все просроченные': 'Todas las vencidas', 'Мои просроченные': 'Mis vencidas',
    'Очереди, доставка, черновики': 'Colas, entrega y borradores', 'Очереди, доставка и черновики': 'Colas, entrega y borradores',
    'Очереди': 'Colas', 'Пользователи': 'Usuarios', 'Поиск': 'Buscar', 'Операторы': 'Operadores',
    'Управление ботами поддержки': 'Bots de soporte', 'Алерты': 'Alertas', 'Контроль и восстановление': 'Supervisión y recuperación',
    'План и хранилище': 'Plan y almacenamiento', 'Журнал действий': 'Registro de actividad', 'Помощь': 'Ayuda', 'Меню': 'Menú',
    'Выберите язык интерфейса:': 'Elige el idioma de la interfaz:', 'Язык интерфейса': 'Idioma de la interfaz',
    'Язык сохранён.': 'Idioma guardado.', 'Назад': 'Volver', 'К сервису': 'Al servicio', 'К списку': 'A la lista',
    'Все сервисы': 'Todos los servicios', 'Фильтры': 'Filtros', 'Отмена': 'Cancelar', 'Подтвердить': 'Confirmar',
    'Справка Админушки': 'Ayuda de Adminushka', 'История устарела. Откройте карточку пользователя заново.': 'Este historial caducó. Vuelve a abrir la ficha del usuario.',
    'Записей нет.': 'No hay registros.', 'Скрыть коды': 'Ocultar códigos', 'Технические коды': 'Códigos técnicos',
    'Сервис больше не подключён.': 'Este servicio ya no está conectado.', 'Карточка устарела. Откройте список заново.': 'Esta ficha caducó. Vuelve a abrir la lista.',
    'Профиль больше не найден.': 'No se encontró el perfil.', 'Поиск профиля': 'Buscar perfiles',
    'Профиль не найден.': 'No se encontró el perfil.', 'Заблокированы': 'Bloqueados', 'Ограниченные': 'Restringidos',
    'На проверке': 'En revisión', 'Подозрительные': 'Sospechosos', 'Доверенные': 'De confianza', 'Недавние': 'Recientes',
    'обычный': 'normal', 'заблокирован': 'bloqueado', 'доверенный': 'de confianza', 'подозрительный': 'sospechoso',
    'История пользователя': 'Historial del usuario', 'Записей': 'Registros', 'страница': 'página', 'Найдено профилей': 'Perfiles encontrados',
    'Справка': 'Ayuda', 'Команды': 'Comandos', 'Здоровье системы': 'Estado del sistema', 'Черновики': 'Borradores',
    'Выберите язык интерфейса.': 'Elige el idioma de la interfaz.', '← Назад': '← Volver',
    'Ограничены': 'Restringidos', 'Состояние уже изменилось.': 'El estado ha cambiado.',
    'Людей': 'Personas', 'Откройте меню заново.': 'Vuelve a abrir el menú.',
    'Один пользователь может иметь профиль в нескольких сервисах.': 'Un usuario puede tener un perfil en varios servicios.',
    'Пользователей нет.': 'No hay usuarios.', 'обращение:': 'conversación:', 'открыто': 'abierta', 'закрыто': 'cerrada', 'нет темы': 'sin tema',
  },
  zh: {
    'Статистика': '统计', 'Управление поддержкой': '支持管理', 'Выберите действие или раздел.': '请选择操作或栏目。',
    'Выберите сервис. Обращения клиентов остаются в темах его группы.': '请选择服务。客户对话保留在其群组的话题中。',
    'Мои обращения': '我的会话', 'Все обращения': '全部会话', 'Просроченные': '逾期',
    'Просроченные обращения': '逾期会话', 'Все просроченные': '全部逾期', 'Мои просроченные': '我的逾期会话',
    'Очереди, доставка, черновики': '队列、投递和草稿', 'Очереди, доставка и черновики': '队列、投递和草稿',
    'Очереди': '队列', 'Пользователи': '用户', 'Поиск': '搜索', 'Операторы': '客服人员',
    'Управление ботами поддержки': '支持机器人', 'Алерты': '提醒', 'Контроль и восстановление': '监控与恢复',
    'План и хранилище': '套餐与存储', 'Журнал действий': '操作日志', 'Помощь': '帮助', 'Меню': '菜单',
    'Выберите язык интерфейса:': '请选择界面语言：', 'Язык интерфейса': '界面语言',
    'Язык сохранён.': '语言已保存。', 'Назад': '返回', 'К сервису': '返回服务', 'К списку': '返回列表',
    'Все сервисы': '所有服务', 'Фильтры': '筛选', 'Отмена': '取消', 'Подтвердить': '确认',
    'Справка Админушки': 'Adminushka 帮助', 'История устарела. Откройте карточку пользователя заново.': '此历史记录已过期，请重新打开用户卡片。',
    'Записей нет.': '没有记录。', 'Скрыть коды': '隐藏代码', 'Технические коды': '技术代码',
    'Сервис больше не подключён.': '此服务已断开连接。', 'Карточка устарела. Откройте список заново.': '此卡片已过期，请重新打开列表。',
    'Профиль больше не найден.': '未找到用户资料。', 'Поиск профиля': '搜索用户资料',
    'Профиль не найден.': '未找到用户资料。', 'Заблокированы': '已封禁', 'Ограниченные': '受限',
    'На проверке': '待审核', 'Подозрительные': '可疑', 'Доверенные': '可信', 'Недавние': '最近',
    'обычный': '普通', 'заблокирован': '已封禁', 'доверенный': '可信', 'подозрительный': '可疑',
    'История пользователя': '用户历史', 'Записей': '记录数', 'страница': '页', 'Найдено профилей': '找到的资料',
    'Справка': '帮助', 'Команды': '命令', 'Здоровье системы': '系统状态', 'Черновики': '草稿',
    'Выберите язык интерфейса.': '请选择界面语言。', '← Назад': '← 返回',
    'Ограничены': '受限', 'Состояние уже изменилось.': '状态已更改。',
    'Людей': '用户数', 'Откройте меню заново.': '请重新打开菜单。',
    'Один пользователь может иметь профиль в нескольких сервисах.': '同一用户可以在多个服务中拥有资料。',
    'Пользователей нет.': '没有用户。', 'обращение:': '会话：', 'открыто': '开放', 'закрыто': '已关闭', 'нет темы': '没有话题',
  },
};

const managerCatalog = [
  ['📊 Статистика', '📊 Statistics', '📊 Estadísticas', '📊 统计'],
  ['включено', 'enabled', 'activado', '已启用'], ['включена', 'enabled', 'activada', '已启用'], ['включены', 'enabled', 'activadas', '已启用'], ['выключено', 'disabled', 'desactivado', '已停用'], ['выключена', 'disabled', 'desactivada', '已停用'], ['выключены', 'disabled', 'desactivadas', '已停用'],
  ['не настроено', 'not configured', 'sin configurar', '未配置'], ['не задано', 'not set', 'sin definir', '未设置'], ['ещё не проверены', 'not checked yet', 'aún no comprobadas', '尚未检查'], ['по умолчанию', 'default', 'predeterminado', '默认'],
  ['Все', 'All', 'Todos', '全部'], ['По умолчанию', 'Default', 'Predeterminado', '默认'],
  ['команда', 'team', 'equipo', '团队'],
  ['Перейти в тему', 'Open topic', 'Abrir tema', '打开话题'], ['Работа с обращением', 'Conversation actions', 'Acciones de conversación', '会话操作'],
  ['Снять доверие', 'Remove trust', 'Quitar confianza', '取消信任'], ['Доверять', 'Trust', 'Confiar', '信任'],
  ['Снять ограничение', 'Remove restriction', 'Quitar restricción', '解除限制'], ['Ограничить', 'Restrict', 'Restringir', '限制'],
  ['Разблокировать', 'Unblock', 'Desbloquear', '解除封禁'], ['Заблокировать', 'Block', 'Bloquear', '封禁'],
  ['Сбросить риск и CAPTCHA', 'Reset risk and CAPTCHA', 'Restablecer riesgo y CAPTCHA', '重置风险和验证码'],
  ['История', 'History', 'Historial', '历史记录'], ['Обновить', 'Refresh', 'Actualizar', '刷新'], ['Обновить статус', 'Refresh status', 'Actualizar estado', '刷新状态'], ['▶️ Повторить безопасные отправки', '▶️ Retry safe sends', '▶️ Reintentar envíos seguros', '▶️ 重试安全发送'], ['Обновить проверку', 'Refresh check', 'Actualizar comprobación', '刷新检查'],
  ['Тема', 'Topic', 'Tema', '话题'], ['Далее →', 'Next →', 'Siguiente →', '下一页 →'],
  ['Назад к сервисам', 'Back to services', 'Volver a servicios', '返回服务'], ['Нужен ответ', 'Needs reply', 'Necesita respuesta', '待回复'],
  ['Мои', 'Mine', 'Mías', '我的'], ['Ждём клиента', 'Waiting for customer', 'Esperando al cliente', '等待客户'],
  ['Вернуться сегодня', 'Return today', 'Volver hoy', '今天返回'], ['Решено', 'Resolved', 'Resuelto', '已解决'],
  ['Выбрать сервис', 'Choose service', 'Elegir servicio', '选择服务'], ['В этой очереди обращений нет.', 'No conversations in this queue.', 'No hay conversaciones en esta cola.', '此队列中没有会话。'],
  ['Обращение больше не найдено. Обновите список.', 'Conversation not found. Refresh the list.', 'No se encontró la conversación. Actualiza la lista.', '未找到会话。请刷新列表。'],
  ['закрыта', 'closed', 'cerrada', '已关闭'], ['открыта', 'open', 'abierta', '开放'],
  ['Записи в очереди операторов нет.', 'No operator queue entry.', 'No hay una entrada en la cola de operadores.', '客服队列中没有记录。'],
  ['Взять', 'Take', 'Asignar', '接手'], ['Снять назначение', 'Unassign', 'Quitar asignación', '取消指派'],
  ['Вернуть в работу', 'Reopen', 'Reabrir', '重新处理'], ['Отложить на час', 'Snooze for an hour', 'Posponer una hora', '延后一小时'],
  ['Завтра в 09:00', 'Tomorrow at 09:00', 'Mañana a las 09:00', '明天 09:00'], ['Передать с заметкой', 'Transfer with note', 'Transferir con nota', '附备注转交'],
  ['Закрыть тему', 'Close topic', 'Cerrar tema', '关闭话题'], ['Доставка', 'Delivery', 'Entrega', '投递'], ['Доступ и модерация', 'Access and moderation', 'Acceso y moderación', '访问与审核'],
  ['К результатам', 'Back to results', 'Volver a resultados', '返回结果'], ['Следующее →', 'Next →', 'Siguiente →', '下一页 →'],
  ['В этой части очереди больше нет обращений.', 'No more conversations in this part of the queue.', 'No hay más conversaciones en esta parte de la cola.', '此队列部分没有更多会话。'],
  ['К очереди', 'Back to queue', 'Volver a la cola', '返回队列'], ['Сведения и модерация', 'Details and moderation', 'Detalles y moderación', '详情与审核'],
  ['Передать с заметкой в личке', 'Transfer with a private note', 'Transferir con una nota privada', '附私密备注转交'], ['нет записи очереди', 'no queue entry', 'sin entrada en la cola', '无队列记录'],
  ['Неизвестно, появилась ли карточка обращения. Проверьте тему перед повтором /case.', 'It is unclear whether the conversation card appeared. Check the topic before retrying /case.', 'No se sabe si apareció la ficha de la conversación. Comprueba el tema antes de repetir /case.', '无法确认会话卡片是否出现。重试 /case 前请检查话题。'],
  ['Не удалось показать карточку обращения. Повторите /case позже.', 'Could not show the conversation card. Try /case again later.', 'No se pudo mostrar la ficha. Vuelve a intentarlo con /case más tarde.', '无法显示会话卡片。请稍后重试 /case。'],
  ['Не удалось обновить карточку обращения. Откройте её командой /case.', 'Could not refresh the conversation card. Reopen it with /case.', 'No se pudo actualizar la ficha. Ábrela con /case.', '无法刷新会话卡片。请用 /case 重新打开。'],
  ['Незавершённая модерация', 'Pending moderation', 'Moderación pendiente', '待处理审核'], ['Продолжить действие из старого меню', 'Resume action from old menu', 'Continuar la acción del menú anterior', '继续旧菜单中的操作'],
  ['Старое действие: начните заново через Пользователи', 'This action has expired. Start again from Users.', 'La acción caducó. Empieza de nuevo desde Usuarios.', '此操作已过期。请从“用户”重新开始。'],
  ['Черновиков нет.', 'No drafts.', 'No hay borradores.', '没有草稿。'], ['Черновик передачи устарел.', 'Transfer draft expired.', 'El borrador de transferencia caducó.', '转交草稿已过期。'],
  ['Продолжите передачу: отправьте внутреннюю заметку одним сообщением.', 'Continue the transfer by sending the internal note in one message.', 'Continúa la transferencia enviando la nota interna en un solo mensaje.', '请发送一条内部备注以继续转交。'],
  ['Подтвердить передачу', 'Confirm transfer', 'Confirmar transferencia', '确认转交'], ['Этот черновик уже обрабатывается. Откройте карточку обращения.', 'This draft is already being processed. Open the conversation card.', 'Este borrador ya se está procesando. Abre la ficha de la conversación.', '此草稿正在处理中。请打开会话卡片。'],
  ['Черновик заметки больше не найден.', 'Note draft not found.', 'No se encontró el borrador de la nota.', '未找到备注草稿。'], ['Выбор оператора устарел. Откройте обращение заново.', 'Operator selection expired. Reopen the conversation.', 'La selección del operador caducó. Vuelve a abrir la conversación.', '客服选择已过期。请重新打开会话。'],
  ['Этот шаг устарел. Откройте обращение заново.', 'This step expired. Reopen the conversation.', 'Este paso caducó. Vuelve a abrir la conversación.', '此步骤已过期。请重新打开会话。'],
  ['Создать новую группу', 'Create a new group', 'Crear un grupo nuevo', '创建新群组'], ['Группа для сервиса не выбрана.', 'No group selected for this service.', 'No se seleccionó un grupo para este servicio.', '尚未为此服务选择群组。'],
  ['Добавить сервисного бота', 'Add service bot', 'Añadir bot de servicio', '添加服务机器人'], ['Подключить группу', 'Connect group', 'Conectar grupo', '连接群组'],
  ['Контрольный обмен', 'Test exchange', 'Intercambio de prueba', '测试消息往返'], ['Настройки · просмотр', 'Settings · view only', 'Configuración · solo lectura', '设置 · 只读'],
  ['Проблемы доставки', 'Delivery issues', 'Problemas de entrega', '投递问题'], ['Здоровье', 'Health', 'Estado', '健康状态'], ['Реакции · просмотр', 'Reactions · view only', 'Reacciones · solo lectura', '回应 · 只读'],
  ['Защита · просмотр', 'Protection · view only', 'Protección · solo lectura', '防护 · 只读'], ['завершён', 'completed', 'completado', '已完成'],
  ['ожидает входящего', 'waiting for inbound message', 'esperando mensaje entrante', '等待收到消息'], ['создаётся тема', 'topic is being created', 'creando tema', '正在创建话题'], ['ожидает ответа', 'waiting for reply', 'esperando respuesta', '等待回复'], ['отправляется ответ', 'reply is being sent', 'enviando respuesta', '正在发送回复'],
  ['исход не подтверждён', 'outcome unconfirmed', 'resultado sin confirmar', '结果未确认'], ['не проводился', 'not run', 'no se ejecutó', '未运行'], ['не указан', 'not specified', 'no especificado', '未指定'],
  ['не подключена', 'not connected', 'no conectado', '未连接'], ['✅ проверены и включены', '✅ checked and enabled', '✅ comprobadas y activadas', '✅ 已检查并启用'], ['🧪 требуется проверка', '🧪 check required', '🧪 requiere comprobación', '🧪 需要检查'],
  ['Подключить группу', 'Connect group', 'Conectar grupo', '连接群组'], ['🧪 Проверить реакции', '🧪 Check reactions', '🧪 Comprobar reacciones', '🧪 检查回应'], ['🛡 Защита сервиса', '🛡 Service protection', '🛡 Protección del servicio', '🛡 服务防护'],
  ['🔄 Проверка и восстановление доставки', '🔄 Check and recover delivery', '🔄 Comprobar y recuperar entregas', '🔄 检查并恢复投递'], ['🩺 Здоровье сервиса', '🩺 Service health', '🩺 Estado del servicio', '🩺 服务状态'], ['Ответственный', 'Primary operator', 'Operador principal', '主要负责人'], ['Резервный', 'Backup operator', 'Operador suplente', '备用负责人'], ['Интервалы уведомлений', 'Notification intervals', 'Intervalos de notificación', '通知间隔'],
  ['Да, приостановить', 'Yes, pause', 'Sí, pausar', '是，暂停'], ['Да, возобновить', 'Yes, resume', 'Sí, reanudar', '是，恢复'], ['Да, удалить подключение', 'Yes, remove connection', 'Sí, eliminar conexión', '是，移除连接'],
  ['Для контрольного обмена нужен username сервисного бота.', 'The service bot needs a username for the test exchange.', 'El bot de servicio necesita un nombre de usuario para la prueba.', '测试消息往返需要服务机器人用户名。'],
  ['Запустить ещё раз', 'Run again', 'Ejecutar de nuevo', '再次运行'], ['Начать в сервисном боте', 'Start in service bot', 'Iniciar en el bot de servicio', '在服务机器人中开始'], ['Тестовая тема', 'Test topic', 'Tema de prueba', '测试话题'], ['Обновить результат', 'Refresh result', 'Actualizar resultado', '刷新结果'], ['Без резервного', 'No backup', 'Sin suplente', '无备用负责人'],
  ['Сначала подключите группу поддержки.', 'Connect a support group first.', 'Conecta primero un grupo de soporte.', '请先连接支持群组。'], ['Проверить состояние', 'Check status', 'Comprobar estado', '检查状态'], ['Нужна супергруппа с включёнными темами.', 'A supergroup with topics enabled is required.', 'Se necesita un supergrupo con temas activados.', '需要启用话题的超级群组。'],
  ['Открыть меню', 'Open menu', 'Abrir menú', '打开菜单'], ['Меню уже изменилось. Откройте экран ещё раз.', 'The menu has changed. Reopen this screen.', 'El menú ha cambiado. Vuelve a abrir esta pantalla.', '菜单已更改。请重新打开此页面。'],
  ['Не удалось проверить закреплённое меню. Повторите позже.', 'Could not verify the pinned menu. Try again later.', 'No se pudo comprobar el menú fijado. Inténtalo más tarde.', '无法检查置顶菜单。请稍后重试。'],
  ['Меню есть, но закрепление не подтверждено. Проверьте права и повторите.', 'The menu exists, but pinning was not confirmed. Check permissions and retry.', 'El menú existe, pero no se confirmó que estuviera fijado. Comprueba los permisos y vuelve a intentarlo.', '菜单已创建，但未确认置顶。请检查权限后重试。'],
  ['Не удалось создать меню. Повторите проверку.', 'Could not create the menu. Retry the check.', 'No se pudo crear el menú. Repite la comprobación.', '无法创建菜单。请重试检查。'], ['Меню создано, но закрепление не подтверждено. Повторите проверку.', 'The menu was created, but pinning was not confirmed. Check again.', 'Se creó el menú, pero no se confirmó que estuviera fijado. Vuelve a comprobarlo.', '菜单已创建，但未确认置顶。请重新检查。'],
  ['Сервис больше не доступен. Откройте мастер заново.', 'This service is no longer available. Restart the setup wizard.', 'El servicio ya no está disponible. Reinicia el asistente de configuración.', '此服务已不可用。请重新启动设置向导。'],
  [messageDeletionWarning('ru'), messageDeletionWarning('en'), messageDeletionWarning('es'), messageDeletionWarning('zh')],
  ['Удаление сообщения', 'Message deletion', 'Eliminación de mensaje', '删除消息'],
  ['Тема закрыта.', 'Topic closed.', 'Tema cerrado.', '话题已关闭。'], ['Тема открыта.', 'Topic reopened.', 'Tema reabierto.', '话题已重新打开。'], ['Выберите сервис для очереди.', 'Choose a service for the queue.', 'Elige un servicio para la cola.', '请选择队列所属服务。'],
  // Manager diagnostics and help copy.
  ['Как ответить?', 'How do I reply?', '¿Cómo respondo?', '如何回复？'],
  ['Откройте «Очереди» или «Мои обращения», выберите карточку и перейдите в тему клиента. Сообщение или файл отправьте в этой теме. Команды и кнопки управления клиенту не пересылаются.', 'Open Queues or My conversations, select a card, and open the customer topic. Send your message or file there. Commands and management buttons are not forwarded to customers.', 'Abre Colas o Mis conversaciones, elige una ficha y entra en el tema del cliente. Envía allí el mensaje o archivo. Los comandos y botones de gestión no se reenvían al cliente.', '打开“队列”或“我的会话”，选择卡片并进入客户话题。在该话题中发送消息或文件。命令和管理按钮不会转发给客户。'],
  ['Как передать обращение?', 'How do I transfer a conversation?', '¿Cómo transfiero una conversación?', '如何转交会话？'],
  ['В карточке обращения нажмите «Передать», выберите оператора, добавьте внутреннюю заметку и подтвердите. Клиент заметку не получит. «Мои обращения» показывает назначенные вам обращения.', 'In the conversation card, select Transfer, choose an operator, add an internal note, and confirm. The customer will not receive the note. My conversations lists conversations assigned to you.', 'En la ficha de la conversación, pulsa Transferir, elige un operador, añade una nota interna y confirma. El cliente no recibirá la nota. Mis conversaciones muestra las conversaciones que tienes asignadas.', '在会话卡片中选择“转交”，选择客服，添加内部备注并确认。客户不会收到备注。“我的会话”显示分配给你的会话。'],
  ['Как ограничить пользователя?', 'How do I restrict a user?', '¿Cómo restrinjo a un usuario?', '如何限制用户？'],
  ['Откройте «Пользователи» → «Поиск» или карточку обращения. В карточке пользователя выберите блокировку, ограничение или доверие и подтвердите действие.', 'Open Users → Search or a conversation card. On the user card, choose block, restrict, or trust, then confirm.', 'Abre Usuarios → Buscar o una ficha de conversación. En la ficha del usuario, elige bloquear, restringir o marcar como de confianza y confirma.', '打开“用户”→“搜索”或会话卡片。在用户卡片中选择封禁、限制或信任，然后确认。'],
  ['Почему сообщение задержалось?', 'Why is a message delayed?', '¿Por qué se retrasó el mensaje?', '消息为何延迟？'],
  ['Откройте «Проблемы доставки» или диагностику в карточке пользователя. При неясном исходе сначала проверьте переписку: повтор уже доставленного сообщения создаст дубль. Восстановление запускает главный администратор из карточки сервиса.', 'Open Delivery issues or diagnostics on the user card. If delivery is uncertain, check the conversation first; retrying a delivered message creates a duplicate. Only the primary administrator can start recovery from the service card.', 'Abre Problemas de entrega o el diagnóstico de la ficha del usuario. Si no se conoce el resultado, revisa primero la conversación: repetir un mensaje ya entregado lo duplicará. Solo el administrador principal puede iniciar la recuperación desde la ficha del servicio.', '打开“投递问题”或用户卡片中的诊断。如果结果不明确，请先检查对话；重发已送达的消息会造成重复。只有主管理员可以从服务卡片启动恢复。'],
  ['Как продолжить черновик?', 'How do I resume a draft?', '¿Cómo continúo un borrador?', '如何继续草稿？'],
  ['На главном экране откройте «Черновики» и выберите сохранённый ввод. Внутреннюю заметку отправьте следующим обычным сообщением. /cancel отменяет текущий ввод.', 'Open Drafts on the home screen and select the saved input. Send an internal note as your next regular message. /cancel cancels the current input.', 'Abre Borradores en la pantalla principal y selecciona la entrada guardada. Envía la nota interna como tu siguiente mensaje normal. /cancel cancela la entrada actual.', '在主页打开“草稿”并选择已保存的输入。内部备注请作为下一条普通消息发送。/cancel 可取消当前输入。'],
  ['Команды', 'Commands', 'Comandos', '命令'],
  ['В личке Админушки: /start и /menu — меню; /mine и /urgent — свои обращения; /users — пользователи; /operators — команда; /reactions — реакции; /audit — журнал; /available и /unavailable — доступность; /help — помощь; /cancel — отмена ввода.', 'In Adminushka chat: /start and /menu open the menu; /mine and /urgent show your conversations; /users lists users; /operators shows the team; /reactions shows reactions; /audit opens the log; /available and /unavailable set availability; /help opens help; /cancel cancels input.', 'En el chat de Adminushka: /start y /menu abren el menú; /mine y /urgent muestran tus conversaciones; /users lista usuarios; /operators muestra el equipo; /reactions muestra las reacciones; /audit abre el registro; /available y /unavailable cambian tu disponibilidad; /help abre la ayuda; /cancel cancela la entrada.', '在 Adminushka 私聊中：/start 和 /menu 打开菜单；/mine 和 /urgent 查看你的会话；/users 查看用户；/operators 查看团队；/reactions 查看回应；/audit 打开日志；/available 和 /unavailable 设置可用状态；/help 打开帮助；/cancel 取消输入。'],
  ['Справка Админушки', 'Adminushka help', 'Ayuda de Adminushka', 'Adminushka 帮助'],
  ['Сервисы: подключение групп, контрольный обмен, реакции и настройки сообщений.\nОбращения: «Очереди» показывают нуждающиеся в ответе, ожидающие, отложенные и решённые; «Пользователи» показывает профили, историю и модерацию.\nЧерновики: сохранённые тексты ботов, заметки и незавершённые действия.\nДоставка: «Проблемы доставки» показывает незавершённые сообщения; неясную отправку сначала проверьте в Telegram.\nГотовность: в карточке сервиса доступны проверка связи с Telegram и технические детали.\nЗдоровье системы: состояние групп и последние контрольные обмены.\nПлан Cloudflare и хранилище находятся в главном меню.\n\nПоиск: нажмите «Поиск» и отправьте ID, @username или имя без команды.\nКоманды: /start — меню, /users — профили пользователей, /operators — команда, /reactions — реакции, /audit — журнал.', 'Services: connect groups, run test exchanges, configure reactions, and edit messages.\nConversations: Queues show items needing a reply, waiting, snoozed, or resolved; Users shows profiles, history, and moderation.\nDrafts: saved bot messages, notes, and unfinished actions.\nDelivery: Delivery issues lists incomplete messages; check Telegram first when delivery is uncertain.\nReadiness: service cards include Telegram connection checks and technical details.\nSystem health: group status and recent test exchanges.\nCloudflare plan and storage are in the main menu.\n\nSearch: select Search and send an ID, @username, or name without a command.\nCommands: /start opens the menu, /users lists profiles, /operators shows the team, /reactions shows reactions, and /audit opens the log.', 'Servicios: conecta grupos, ejecuta intercambios de prueba, configura reacciones y edita mensajes.\nConversaciones: Colas muestra las que necesitan respuesta, esperan, están pospuestas o resueltas; Usuarios muestra perfiles, historial y moderación.\nBorradores: mensajes guardados, notas y acciones sin terminar.\nEntrega: Problemas de entrega lista los mensajes incompletos; comprueba Telegram primero si el resultado es incierto.\nPreparación: las fichas de servicio incluyen comprobaciones de conexión con Telegram y detalles técnicos.\nEstado del sistema: estado de los grupos e intercambios de prueba recientes.\nEl plan de Cloudflare y el almacenamiento están en el menú principal.\n\nBuscar: pulsa Buscar y envía un ID, @username o nombre sin comando.\nComandos: /start abre el menú, /users lista perfiles, /operators muestra el equipo, /reactions muestra reacciones y /audit abre el registro.', '服务：连接群组、运行测试消息、配置回应和编辑消息。\n会话：“队列”显示待回复、等待、延后或已解决的会话；“用户”显示资料、历史记录和审核信息。\n草稿：已保存的机器人消息、备注和未完成操作。\n投递：“投递问题”列出未完成消息；结果不明时先检查 Telegram。\n就绪状态：服务卡片提供 Telegram 连接检查和技术详情。\n系统状态：群组状态和最近的测试消息。\nCloudflare 套餐和存储位于主菜单。\n\n搜索：选择“搜索”，然后发送 ID、@username 或姓名，无需命令。\n命令：/start 打开菜单，/users 查看资料，/operators 查看团队，/reactions 查看回应，/audit 打开日志。'],
  ['нет данных', 'no data', 'sin datos', '无数据'], ['группа не подключена', 'group not connected', 'grupo sin conectar', '群组未连接'],
  ['База данных: выполняется обслуживание.', 'Database: maintenance in progress.', 'Base de datos: mantenimiento en curso.', '数据库：正在维护。'],
  ['База данных: доступна.', 'Database: available.', 'Base de datos: disponible.', '数据库：可用。'],
  ['Задержанных сообщений в выборке нет.', 'No delayed messages in this sample.', 'No hay mensajes retrasados en esta muestra.', '此样本中没有延迟消息。'],
  ['Сервис выключен.', 'Service is disabled.', 'El servicio está desactivado.', '服务已关闭。'], ['Группа сервиса не подключена.', 'Service group is not connected.', 'El grupo del servicio no está conectado.', '服务群组未连接。'],
  ['Связь с ботом не подтверждена.', 'Bot connection is unverified.', 'No se confirmó la conexión del bot.', '机器人连接尚未确认。'],
  ['Webhook требует проверки.', 'Webhook needs verification.', 'El webhook requiere verificación.', 'Webhook 需要检查。'],
  ['В Telegram есть ожидающие обновления.', 'Telegram has pending updates.', 'Telegram tiene actualizaciones pendientes.', 'Telegram 有待处理更新。'],
  ['Обмен сообщениями в обе стороны ещё не подтверждён.', 'Two-way messaging has not been verified yet.', 'Aún no se verificó el intercambio de mensajes en ambas direcciones.', '尚未确认双向消息往返。'],
  ['Проблемы доставки', 'Delivery issues', 'Problemas de entrega', '投递问题'], ['Сообщения', 'Messages', 'Mensajes', '消息'], ['Реакции', 'Reactions', 'Reacciones', '回应'],
  ['Краткий результат', 'Summary', 'Resumen', '简要结果'], ['Технические детали', 'Technical details', 'Detalles técnicos', '技术详情'], ['Открыть тему', 'Open topic', 'Abrir tema', '打开话题'], ['Назад к сервису', 'Back to service', 'Volver al servicio', '返回服务'],
  // User management forms and profile cards.
  ['Все', 'All', 'Todos', '全部'], ['🚫 Заблокированные', '🚫 Blocked', '🚫 Bloqueados', '🚫 已封禁'], ['⏳ Ограниченные', '⏳ Restricted', '⏳ Restringidos', '⏳ 受限'], ['🧩 На проверке', '🧩 Under review', '🧩 En revisión', '🧩 待审核'], ['⚠️ Подозрительные', '⚠️ Flagged', '⚠️ Sospechosos', '⚠️ 可疑'], ['✅ Доверенные', '✅ Trusted', '✅ De confianza', '✅ 可信'], ['🕘 Недавние', '🕘 Recent', '🕘 Recientes', '🕘 最近'],
  ['Поиск профиля\n\nОтправьте следующим обычным сообщением Telegram ID, @username или часть имени (от 2 символов). Команду перед запросом писать не нужно. Для отмены нажмите кнопку или отправьте /cancel.', 'Search profiles\n\nSend a Telegram ID, @username, or part of a name (at least 2 characters) as your next regular message. Do not add a command. Press Cancel or send /cancel to stop.', 'Buscar perfiles\n\nEnvía un ID de Telegram, @username o parte del nombre (al menos 2 caracteres) en tu siguiente mensaje normal. No escribas un comando. Pulsa Cancelar o envía /cancel para cancelar.', '搜索用户资料\n\n下一条普通消息中发送 Telegram ID、@username 或姓名的一部分（至少 2 个字符）。无需输入命令。点击“取消”或发送 /cancel 停止。'],
  ['Введите от 2 до 100 символов: Telegram ID, @username или часть имени.', 'Enter 2–100 characters: Telegram ID, @username, or part of a name.', 'Introduce entre 2 y 100 caracteres: ID de Telegram, @username o parte del nombre.', '请输入 2–100 个字符：Telegram ID、@username 或姓名的一部分。'],
  ['Незавершённого действия нет.', 'No pending action.', 'No hay ninguna acción pendiente.', '没有待处理操作。'], ['Действие отменено.', 'Action cancelled.', 'Acción cancelada.', '操作已取消。'], ['Действие выполняется. Проверьте карточку пользователя.', 'Action in progress. Check the user card.', 'La acción está en curso. Comprueba la ficha del usuario.', '操作正在进行。请检查用户卡片。'],
  ['Подтвердите действие:', 'Confirm action:', 'Confirma la acción:', '确认操作：'], ['Укажите внутреннюю причину ограничения (3–500 символов).', 'Enter an internal reason for the restriction (3–500 characters).', 'Indica un motivo interno para la restricción (3–500 caracteres).', '请输入限制的内部原因（3–500 个字符）。'],
  ['Укажите внутреннюю причину блокировки (3–500 символов). Клиент её не получит.', 'Enter an internal reason for the block (3–500 characters). The customer will not see it.', 'Indica un motivo interno para el bloqueo (3–500 caracteres). El cliente no lo verá.', '请输入封禁的内部原因（3–500 个字符）。客户不会看到。'],
  ['Укажите срок ограничения от 5 минут до 30 дней: 45m, 6h, 7d.', 'Enter a restriction duration from 5 minutes to 30 days: 45m, 6h, 7d.', 'Indica una duración de 5 minutos a 30 días: 45m, 6h, 7d.', '请输入 5 分钟至 30 天的限制时长：45m、6h、7d。'],
  ['Укажите внутреннюю причину от 3 до 500 символов без токенов.', 'Enter an internal reason of 3–500 characters, without bot tokens.', 'Indica un motivo interno de 3 a 500 caracteres, sin tokens de bots.', '请输入 3–500 个字符的内部原因，不得包含机器人令牌。'],
  ['Действие уже выполняется. Обновите карточку.', 'The action is already in progress. Refresh the card.', 'La acción ya está en curso. Actualiza la ficha.', '操作已在进行。请刷新卡片。'],
  ['На какой срок ограничить доступ к переписке?', 'How long should access to messaging be restricted?', '¿Durante cuánto tiempo se restringe el acceso a la conversación?', '要限制消息访问多长时间？'],
  ['Срок устарел. Откройте карточку заново.', 'The duration expired. Reopen the card.', 'La duración caducó. Vuelve a abrir la ficha.', '时长选择已过期。请重新打开卡片。'],
  ['Сбросить риск и CAPTCHA', 'Reset risk and CAPTCHA', 'Restablecer riesgo y CAPTCHA', '重置风险和验证码'],
  ['История пользователя', 'User history', 'Historial del usuario', '用户历史'], ['Все сервисы', 'All services', 'Todos los servicios', '所有服务'], ['Скрыть коды', 'Hide codes', 'Ocultar códigos', '隐藏代码'], ['Технические коды', 'Technical codes', 'Códigos técnicos', '技术代码'],
  ['История устарела. Откройте карточку пользователя заново.', 'History expired. Reopen the user card.', 'El historial caducó. Vuelve a abrir la ficha del usuario.', '历史记录已过期。请重新打开用户卡片。'],
  ['Журнал действий', 'Activity log', 'Registro de actividad', '操作日志'], ['Записей нет.', 'No records.', 'No hay registros.', '没有记录。'],
  // Service settings are shown through the same manager send path.
  ['Приветствие', 'Welcome message', 'Mensaje de bienvenida', '欢迎语'], ['Автоответ на обращение', 'Automatic reply', 'Respuesta automática', '自动回复'],
  ['🔵 Голубой', '🔵 Blue', '🔵 Azul', '🔵 蓝色'], ['🟡 Жёлтый', '🟡 Yellow', '🟡 Amarillo', '🟡 黄色'], ['🟣 Фиолетовый', '🟣 Purple', '🟣 Morado', '🟣 紫色'], ['🟢 Зелёный', '🟢 Green', '🟢 Verde', '🟢 绿色'], ['🩷 Розовый', '🩷 Pink', '🩷 Rosa', '🩷 粉色'], ['🔴 Красный', '🔴 Red', '🔴 Rojo', '🔴 红色'],
  ['🌐 Сменить язык', '🌐 Change language', '🌐 Cambiar idioma', '🌐 更改语言'], ['Приветствие и автоответ', 'Welcome message and automatic reply', 'Mensaje de bienvenida y respuesta automática', '欢迎语和自动回复'],
  ['Оформление тем', 'Topic style', 'Estilo de temas', '话题样式'], ['Защита сервиса', 'Service protection', 'Protección del servicio', '服务防护'], ['Текст пока не задан.', 'No text has been set.', 'Aún no se ha definido el texto.', '尚未设置文本。'],
  ['Изменить текст', 'Edit text', 'Editar texto', '编辑文本'], ['Продолжить черновик', 'Resume draft', 'Continuar borrador', '继续草稿'], ['Включить', 'Enable', 'Activar', '启用'], ['Выключить', 'Disable', 'Desactivar', '停用'], ['Очистить текст', 'Clear text', 'Borrar texto', '清除文本'],
  ['Приветствие на /start', 'Welcome message on /start', 'Mensaje de bienvenida en /start', '/start 欢迎语'], ['Скопировать с другого бота', 'Copy from another bot', 'Copiar de otro bot', '从其他机器人复制'], ['Настройки сервиса', 'Service settings', 'Configuración del servicio', '服务设置'], ['не задано', 'not set', 'sin definir', '未设置'], ['Назад к сообщениям', 'Back to messages', 'Volver a mensajes', '返回消息'],
  ['Язык сервиса', 'Service language', 'Idioma del servicio', '服务语言'], ['Сейчас', 'Current', 'Actual', '当前'], ['Язык применяется к новым сообщениям и уведомлениям.', 'The language applies to new messages and notifications.', 'El idioma se aplica a mensajes y notificaciones nuevos.', '语言将应用于新消息和通知。'], ['Язык применяется к новым сообщениям, кнопкам и карточкам этого бота.', 'The language applies to new messages, buttons, and cards from this bot.', 'El idioma se aplica a los mensajes, botones y fichas nuevos de este bot.', '此语言将应用于该机器人的新消息、按钮和卡片。'], ['Настройки сервиса устарели. Откройте карточку сервиса заново.', 'Service settings expired. Reopen the service card.', 'La configuración caducó. Vuelve a abrir la ficha del servicio.', '服务设置已过期。请重新打开服务卡片。'],
  ['🌐 Сменить язык сервиса', '🌐 Change service language', '🌐 Cambiar idioma del servicio', '🌐 更改服务语言'], ['Бот-источник больше не доступен. Выберите другого.', 'Source bot is no longer available. Choose another.', 'El bot de origen ya no está disponible. Elige otro.', '源机器人已不可用。请选择其他机器人。'],
  ['Выбрать бота', 'Choose bot', 'Elegir bot', '选择机器人'], ['У выбранного бота сообщения больше не настроены.', 'The selected bot no longer has configured messages.', 'El bot seleccionado ya no tiene mensajes configurados.', '所选机器人已没有配置的消息。'], ['Применить оба сообщения', 'Apply both messages', 'Aplicar ambos mensajes', '应用两条消息'], ['Выбрать другого бота', 'Choose another bot', 'Elegir otro bot', '选择其他机器人'],
  ['Подтверждение устарело. Откройте копирование заново.', 'Confirmation expired. Restart the copy flow.', 'La confirmación caducó. Vuelve a iniciar la copia.', '确认已过期。请重新开始复制。'], ['Настройки одного из ботов изменились. Проверьте тексты ещё раз перед копированием.', 'One bot’s settings changed. Review the text again before copying.', 'Cambió la configuración de uno de los bots. Revisa los textos antes de copiarlos.', '其中一个机器人的设置已更改。复制前请重新检查文本。'], ['Проверить тексты', 'Review text', 'Revisar textos', '检查文本'], ['Настройки изменились до сохранения. Проверьте тексты ещё раз.', 'Settings changed before saving. Review the text again.', 'La configuración cambió antes de guardar. Revisa los textos.', '保存前设置已更改。请重新检查文本。'], ['Открыть сообщения', 'Open messages', 'Abrir mensajes', '打开消息设置'],
  ['Черновик больше не найден.', 'Draft not found.', 'No se encontró el borrador.', '未找到草稿。'], ['Сохранить', 'Save', 'Guardar', '保存'], ['Изменить', 'Edit', 'Editar', '编辑'], ['Да, очистить', 'Yes, clear', 'Sí, borrar', '是，清除'], ['Нужен текст от 1 до 3500 символов без токенов ботов.', 'Enter 1–3,500 characters without bot tokens.', 'Introduce entre 1 y 3500 caracteres, sin tokens de bots.', '请输入 1–3500 个字符，不得包含机器人令牌。'],
  ['Эта форма устарела. Откройте настройки сервиса заново.', 'This form expired. Reopen service settings.', 'Este formulario caducó. Vuelve a abrir la configuración del servicio.', '此表单已过期。请重新打开服务设置。'], ['Бот больше не подключён.', 'Bot is no longer connected.', 'El bot ya no está conectado.', '机器人已断开连接。'], ['Эта форма приостановлена. Откройте её через «Черновики».', 'This form is paused. Reopen it from Drafts.', 'Este formulario está pausado. Vuelve a abrirlo desde Borradores.', '此表单已暂停。请从“草稿”重新打开。'], ['Сначала отправьте текст.', 'Send the text first.', 'Envía primero el texto.', '请先发送文本。'], ['Текст уже менялся. Откройте настройки заново.', 'The text has changed. Reopen settings.', 'El texto cambió. Vuelve a abrir la configuración.', '文本已更改。请重新打开设置。'],
  ['Включить автоматическую защиту', 'Enable automatic protection', 'Activar protección automática', '启用自动防护'],
  ['Пользователи · {value}\n\nЛюдей: {value} · профилей: {value}\nЗаблокированы: {value} · ограничены: {value}\nНа проверке: {value} · подозрительные: {value}\nДоверенные: {value} · недавние: {value}', 'Users · {value}\n\nPeople: {value} · profiles: {value}\nBlocked: {value} · restricted: {value}\nUnder review: {value} · flagged: {value}\nTrusted: {value} · recent: {value}', 'Usuarios · {value}\n\nPersonas: {value} · perfiles: {value}\nBloqueados: {value} · restringidos: {value}\nEn revisión: {value} · sospechosos: {value}\nDe confianza: {value} · recientes: {value}', '用户 · {value}\n\n人数：{value} · 资料：{value}\n已封禁：{value} · 受限：{value}\n待审核：{value} · 可疑：{value}\n可信：{value} · 最近：{value}'],
  ['{value} · страница {value}\n\n', '{value} · page {value}\n\n', '{value} · página {value}\n\n', '{value} · 第 {value} 页\n\n'],
  ['Управление поддержкой\n\nВыберите действие или раздел.', 'Support management\n\nChoose an action or section.', 'Gestión de soporte\n\nElige una acción o sección.', '支持管理\n\n请选择操作或栏目。'],
  ['Управление поддержкой\n\nВыберите сервис. Обращения клиентов остаются в темах его группы.', 'Support management\n\nChoose a service. Customer conversations stay in that service group’s topics.', 'Gestión de soporte\n\nElige un servicio. Las conversaciones permanecen en los temas de su grupo.', '支持管理\n\n请选择服务。客户会话保留在其群组话题中。'],
  ['История пользователя {value} · {value} · страница {value}\n\n', 'User history {value} · {value} · page {value}\n\n', 'Historial del usuario {value} · {value} · página {value}\n\n', '用户历史 {value} · {value} · 第 {value} 页\n\n'],
  ['Журнал действий · страница {value}\n\n', 'Activity log · page {value}\n\n', 'Registro de actividad · página {value}\n\n', '操作日志 · 第 {value} 页\n\n'],
  ['Журнал действий · страница {value}', 'Activity log · page {value}', 'Registro de actividad · página {value}', '操作日志 · 第 {value} 页'],
  ['{value} · команда · {value} — {value} · {value} · success', '{value} · team · {value} — {value} · {value} · success', '{value} · equipo · {value} — {value} · {value} · success', '{value} · 团队 · {value} — {value} · {value} · success'],
  ['Журнал действий · страница {value}', 'Activity log · page {value}', 'Registro de actividad · página {value}', '操作日志 · 第 {value} 页'],
  ['Пользователи · {value}\n\n', 'Users · {value}\n\n', 'Usuarios · {value}\n\n', '用户 · {value}\n\n'],
  ['{value} · страница {value}/{value}', '{value} · page {value}/{value}', '{value} · página {value}/{value}', '{value} · 第 {value}/{value} 页'],
  ['Найдено профилей: {value} · страница {value}/{value}', 'Profiles found: {value} · page {value}/{value}', 'Perfiles encontrados: {value} · página {value}/{value}', '找到资料：{value} · 第 {value}/{value} 页'],
  ['Поиск: {value}\nНайдено профилей: {value}. Выберите пользователя и сервис.', 'Search: {value}\nProfiles found: {value}. Choose a user and service.', 'Buscar: {value}\nPerfiles encontrados: {value}. Elige un usuario y servicio.', '搜索：{value}\n找到资料：{value}。请选择用户和服务。'],
  ['Поиск: {value}\nПрофиль не найден.', 'Search: {value}\nProfile not found.', 'Buscar: {value}\nNo se encontró el perfil.', '搜索：{value}\n未找到资料。'],
  ['Подтвердите действие: {value}\nСервис: {value}\nTelegram ID: {value}', 'Confirm action: {value}\nService: {value}\nTelegram ID: {value}', 'Confirma la acción: {value}\nServicio: {value}\nID de Telegram: {value}', '确认操作：{value}\n服务：{value}\nTelegram ID：{value}'],
  ['Укажите новый срок ограничения от 5 минут до 30 дней: 45m, 6h, 7d.', 'Enter a new restriction duration from 5 minutes to 30 days: 45m, 6h, 7d.', 'Indica una nueva duración de restricción de 5 minutos a 30 días: 45m, 6h, 7d.', '请输入新的限制时长，范围为 5 分钟至 30 天：45m、6h、7d。'],
  ['Срок: {value}. Укажите внутреннюю причину ограничения (3–500 символов).', 'Duration: {value}. Enter an internal reason for the restriction (3–500 characters).', 'Duración: {value}. Indica un motivo interno para la restricción (3–500 caracteres).', '时长：{value}。请输入限制的内部原因（3–500 个字符）。'],
  ['Статус доставки сообщения #{value}\n{value}', 'Delivery status for message #{value}\n{value}', 'Estado de entrega del mensaje #{value}\n{value}', '消息 #{value} 的投递状态\n{value}'],
  ['Готовность · {value}', 'Readiness · {value}', 'Preparación · {value}', '就绪状态 · {value}'],
  ['Здоровье системы · страница {value}/{value}', 'System health · page {value}/{value}', 'Estado del sistema · página {value}/{value}', '系统状态 · 第 {value}/{value} 页'],
  ['Доставка · {value} · {value}', 'Delivery · {value} · {value}', 'Entrega · {value} · {value}', '投递 · {value} · {value}'],
  ['Контроль поддержки\nОбращений старше первого порога без ответа: {value}\nНеясных исходов доставки сообщений: {value}\nНеясных исходов личных уведомлений: {value}\nЛичных уведомлений с ошибкой в открытых обращениях: {value}\nНедоступных операторов: {value}\nКарточек, где новая ссылка ещё не подтверждена: {value}\n\nTelegram не подтверждает прочтение клиентом.', 'Support monitoring\nConversations past the first reply threshold: {value}\nMessages with uncertain delivery: {value}\nPrivate notifications with uncertain delivery: {value}\nFailed private notifications on open conversations: {value}\nUnavailable operators: {value}\nCards with an unconfirmed new link: {value}\n\nTelegram does not confirm that the customer read a message.', 'Supervisión de soporte\nConversaciones que superan el primer límite sin respuesta: {value}\nMensajes con entrega incierta: {value}\nAvisos privados con entrega incierta: {value}\nAvisos privados fallidos en conversaciones abiertas: {value}\nOperadores no disponibles: {value}\nFichas con un enlace nuevo sin confirmar: {value}\n\nTelegram no confirma que el cliente haya leído un mensaje.', '支持监控\n超过首个回复时限的会话：{value}\n投递结果不明的消息：{value}\n投递结果不明的私聊通知：{value}\n开放会话中发送失败的私聊通知：{value}\n不可用客服：{value}\n新链接尚未确认的卡片：{value}\n\nTelegram 不会确认客户是否已读消息。'],
  ['{value} · страница {value}\n{value}', '{value} · page {value}\n{value}', '{value} · página {value}\n{value}', '{value} · 第 {value} 页\n{value}'],
  ['Отправьте новый текст «{value}» для {value} одним сообщением (до 3500 символов).\nПосле этого проверьте текст перед сохранением.', 'Send the new “{value}” text for {value} in one message (up to 3,500 characters).\nReview it before saving.', 'Envía el nuevo texto «{value}» para {value} en un solo mensaje (hasta 3500 caracteres).\nRevísalo antes de guardarlo.', '请在一条消息中发送 {value} 的新文本“{value}”（最多 3500 个字符）。\n保存前请检查文本。'],
  ['Проверьте текст для {value}:\n\n{value}', 'Review the text for {value}:\n\n{value}', 'Revisa el texto de {value}:\n\n{value}', '请检查 {value} 的文本：\n\n{value}'],
  ['Настройки · {value}\n\nЯзык: {value}\nПриветствие: {value}\nАвтоответ: {value}\nРеакции: {value}\nОформление новых тем: {value}\nЗащита сервиса: {value}', 'Settings · {value}\n\nLanguage: {value}\nWelcome message: {value}\nAutomatic reply: {value}\nReactions: {value}\nNew topic style: {value}\nService protection: {value}', 'Configuración · {value}\n\nIdioma: {value}\nBienvenida: {value}\nRespuesta automática: {value}\nReacciones: {value}\nEstilo de temas nuevos: {value}\nProtección del servicio: {value}', '设置 · {value}\n\n语言：{value}\n欢迎语：{value}\n自动回复：{value}\n回应：{value}\n新话题样式：{value}\n服务防护：{value}'],
  ['{value} · сообщения\n\nТексты и переключатели сохранены отдельно для этого бота.', '{value} · messages\n\nText and delivery switches are saved separately for this bot.', '{value} · mensajes\n\nLos textos y los interruptores de envío se guardan por separado para este bot.', '{value} · 消息\n\n此机器人的文本和发送开关分别保存。'],
  ['Отправьте новый текст «{value}» одним сообщением (до 3500 символов).', 'Send the new “{value}” text in one message (up to 3,500 characters).', 'Envía el nuevo texto «{value}» en un solo mensaje (hasta 3500 caracteres).', '请在一条消息中发送新的“{value}”文本（最多 3500 个字符）。'],
  ['Проверьте черновик «{value}» для {value}:\n\n{value}', 'Review the “{value}” draft for {value}:\n\n{value}', 'Revisa el borrador «{value}» para {value}:\n\n{value}', '请检查 {value} 的“{value}”草稿：\n\n{value}'],
  ['Очистить текст «{value}» для {value} и выключить отправку?', 'Clear the “{value}” text for {value} and disable sending?', '¿Borrar el texto «{value}» para {value} y desactivar el envío?', '清除 {value} 的“{value}”文本并停用发送？'],
  ['Скопировать сообщения для {value}\n\nВыберите бота-источник. Скопируются оба текста и состояние их отправки. Текущие настройки {value} будут заменены после подтверждения.', 'Copy messages for {value}\n\nChoose a source bot. Both texts and their delivery settings will be copied. The current settings for {value} will be replaced after confirmation.', 'Copiar mensajes para {value}\n\nElige el bot de origen. Se copiarán ambos textos y sus ajustes de envío. La configuración actual de {value} se sustituirá al confirmar.', '为 {value} 复制消息\n\n请选择源机器人。将复制两条文本及其发送设置。确认后将替换 {value} 的当前设置。'],
  ['Язык сервиса · {value}\n\nСейчас: {value}', 'Service language · {value}\n\nCurrent: {value}', 'Idioma del servicio · {value}\n\nActual: {value}', '服务语言 · {value}\n\n当前：{value}'],
  ['Язык применяется к новым сообщениям и уведомлениям этого сервиса.', 'The language applies to new messages and notifications for this service.', 'El idioma se aplica a los mensajes y avisos nuevos de este servicio.', '此语言将应用于该服务的新消息和通知。'],
  ['🔄 Повторная доставка · {value}\n⏳ Запуск принимается. Обновите проверку, если результат задерживается.', '🔄 Delivery retry · {value}\n⏳ The request was accepted. Refresh the check if the result is delayed.', '🔄 Reintento de entrega · {value}\n⏳ Se aceptó la solicitud. Actualiza la comprobación si el resultado tarda.', '🔄 重试投递 · {value}\n⏳ 请求已接受。若结果延迟，请刷新检查。'],
  ['🔄 Повторная доставка · {value}\nДругой запуск уже выполняется ({value}). Обновите проверку после его завершения.', '🔄 Delivery retry · {value}\nAnother run is already active ({value}). Refresh the check when it finishes.', '🔄 Reintento de entrega · {value}\nYa hay otra ejecución en curso ({value}). Actualiza la comprobación cuando termine.', '🔄 重试投递 · {value}\n另一个任务正在运行（{value}）。完成后请刷新检查。'],
  ['Найдено профилей: {value} · страница {value}/{value}', 'Profiles found: {value} · page {value}/{value}', 'Perfiles encontrados: {value} · página {value}/{value}', '找到资料：{value} · 第 {value}/{value} 页'],
  ['Настройки · {value}\n\nЯзык: {value}', 'Settings · {value}\n\nLanguage: {value}', 'Configuración · {value}\n\nIdioma: {value}', '设置 · {value}\n\n语言：{value}'],
  ['Состояние:', 'State:', 'Estado:', '状态：'], ['Состояние темы:', 'Topic status:', 'Estado del tema:', '话题状态：'], ['Состояние очереди:', 'Queue status:', 'Estado de la cola:', '队列状态：'],
  ['Пользователь:', 'User:', 'Usuario:', '用户：'], ['Тема:', 'Topic:', 'Tema:', '话题：'], ['Последнее сообщение:', 'Last message:', 'Último mensaje:', '最近消息：'],
  ['Тема: {value} · группа {value} · тема #{value}', 'Topic: {value} · group {value} · topic #{value}', 'Tema: {value} · grupo {value} · tema #{value}', '话题：{value} · 群组 {value} · 话题 #{value}'],
  ['Ожидание:', 'Waiting:', 'Espera:', '等待：'], ['Ответственный:', 'Assigned to:', 'Asignado a:', '负责人：'], ['Вернуться:', 'Return:', 'Volver:', '返回：'],
  ['Последнее входящее:', 'Last inbound:', 'Último mensaje entrante:', '最近收到：'], ['Подтверждённый ответ:', 'Confirmed reply:', 'Respuesta confirmada:', '已确认回复：'],
  ['Заметка:', 'Note:', 'Nota:', '备注：'], ['Сервис:', 'Service:', 'Servicio:', '服务：'], ['Группа:', 'Group:', 'Grupo:', '群组：'],
  ['Префикс топиков:', 'Topic prefix:', 'Prefijo de temas:', '话题前缀：'], ['Приветствие и подтверждение:', 'Welcome and confirmation:', 'Bienvenida y confirmación:', '欢迎语和确认：'],
  ['Username:', 'Username:', 'Nombre de usuario:', '用户名：'], ['Последняя активность:', 'Last activity:', 'Última actividad:', '最近活动：'],
  ['Обращение:', 'Conversation:', 'Conversación:', '会话：'], ['Риск сейчас:', 'Current risk:', 'Riesgo actual:', '当前风险：'], ['Доступ к переписке:', 'Messaging access:', 'Acceso a mensajes:', '消息访问：'],
  ['Доверие:', 'Trust:', 'Confianza:', '信任：'], ['Ожидающих сообщений:', 'Pending messages:', 'Mensajes pendientes:', '待处理消息：'],
  ['Ожидающих возобновления:', 'Waiting to reopen:', 'Pendientes de reanudación:', '等待恢复：'],
  ['Сервис больше не подключён. Откройте меню заново.', 'Service is no longer connected. Reopen the menu.', 'El servicio ya no está conectado. Vuelve a abrir el menú.', '服务已断开连接。请重新打开菜单。'],
  ['Отправьте внутреннюю заметку для нового ответственного одним сообщением (до 500 символов).', 'Send an internal note for the new assignee in one message (up to 500 characters).', 'Envía una nota interna para el nuevo responsable en un solo mensaje (hasta 500 caracteres).', '请用一条消息发送给新负责人的内部备注（最多 500 个字符）。'],
  ['Сервис недоступен. Заметка сохранена в мастере; повторите позже.', 'Service unavailable. The note is saved in the wizard; try again later.', 'Servicio no disponible. La nota está guardada en el asistente; inténtalo más tarde.', '服务不可用。备注已保存在向导中，请稍后重试。'],
  ['Выберите нового ответственного. Затем напишите внутреннюю заметку: клиент её не получит.', 'Choose a new assignee, then write an internal note. The customer will not receive it.', 'Elige un nuevo responsable y escribe una nota interna. El cliente no la recibirá.', '请选择新的负责人，然后填写内部备注。客户不会收到。'],
  ['Укажите внутреннюю причину ограничения (3–500 символов).', 'Enter an internal reason for the restriction (3–500 characters).', 'Indica un motivo interno para la restricción (3–500 caracteres).', '请输入限制的内部原因（3–500 个字符）。'],
  ['Состояние уже изменилось. Показаны свежие данные.', 'The state changed. Showing current information.', 'El estado cambió. Se muestra la información actualizada.', '状态已更改。以下为最新信息。'],
  ['В этой части очереди больше нет обращений.', 'No more conversations in this part of the queue.', 'No hay más conversaciones en esta parte de la cola.', '此队列部分没有更多会话。'],
  ['Сейчас нет открытых обращений.', 'There are no open conversations right now.', 'No hay conversaciones abiertas ahora.', '目前没有开放会话。'], ['Сейчас за вами нет открытых обращений.', 'You have no open conversations right now.', 'No tienes conversaciones abiertas ahora.', '你目前没有开放会话。'],
  ['Сейчас нет просроченных обращений во всей команде.', 'The team has no overdue conversations right now.', 'El equipo no tiene conversaciones vencidas ahora.', '团队目前没有逾期会话。'], ['Сейчас за вами нет просроченных обращений.', 'You have no overdue conversations right now.', 'No tienes conversaciones vencidas ahora.', '你目前没有逾期会话。'],
  ['Просроченные обращения команды', 'Team overdue conversations', 'Conversaciones vencidas del equipo', '团队逾期会话'], ['Ваши просроченные обращения', 'Your overdue conversations', 'Tus conversaciones vencidas', '你的逾期会话'], ['Текущие обращения команды', 'Current team conversations', 'Conversaciones actuales del equipo', '团队当前会话'], ['Ваши текущие обращения', 'Your current conversations', 'Tus conversaciones actuales', '你的当前会话'],
  ['Здоровье системы', 'System health', 'Estado del sistema', '系统状态'], ['Здоровье сервиса', 'Service health', 'Estado del servicio', '服务状态'], ['Контроль ожидания', 'Waiting-time monitoring', 'Supervisión de tiempos de espera', '等待时长监控'],
  ['Меню уже создаётся. Обновите экран через несколько секунд.', 'The menu is being created. Refresh in a few seconds.', 'Se está creando el menú. Actualiza la pantalla en unos segundos.', '菜单正在创建。请几秒后刷新页面。'],
  ['Неизвестно, появилось ли меню в General. Проверьте группу вручную.', 'It is unclear whether the menu appeared in General. Check the group manually.', 'No se sabe si apareció el menú en General. Comprueba el grupo manualmente.', '无法确认菜单是否出现在 General。请手动检查群组。'],
  ['Исход прежней отправки меню неизвестен. Проверьте General перед повтором.', 'The previous menu send has an unknown result. Check General before retrying.', 'Se desconoce el resultado del envío anterior del menú. Comprueba General antes de repetir.', '上次菜单发送结果不明。重试前请检查 General。'],
  ['Не удалось обновить список сервисов в закреплённом меню.', 'Could not update the service list in the pinned menu.', 'No se pudo actualizar la lista de servicios del menú fijado.', '无法更新置顶菜单中的服务列表。'],
  ['Telegram создал меню, но сохранить его ID не удалось. Проверьте General перед повтором.', 'Telegram created the menu, but its ID could not be saved. Check General before retrying.', 'Telegram creó el menú, pero no se pudo guardar su ID. Comprueba General antes de repetir.', 'Telegram 已创建菜单，但无法保存其 ID。重试前请检查 General。'],
  ['Не удалось проверить группу. Добавьте бота администратором в группу поддержки и разрешите управление темами.', 'Could not verify the group. Add the bot as an administrator in the support group and allow it to manage topics.', 'No se pudo comprobar el grupo. Añade el bot como administrador del grupo de soporte y permite que gestione temas.', '无法验证群组。请将机器人设为支持群组管理员并允许其管理话题。'],
  ['Не удалось проверить токен. Проверьте его в BotFather и повторите.', 'Could not verify the token. Check it in BotFather and try again.', 'No se pudo verificar el token. Compruébalo en BotFather e inténtalo de nuevo.', '无法验证令牌。请在 BotFather 中检查并重试。'],
  ['Telegram не подтвердил действие. Повторите попытку кнопкой; очередь сообщений сохраняется.', 'Telegram did not confirm the action. Retry with the button; the message queue is preserved.', 'Telegram no confirmó la acción. Vuelve a intentarlo con el botón; la cola de mensajes se conserva.', 'Telegram 未确认此操作。请点击按钮重试；消息队列会保留。'],
  ['Добавление бота поддержки\n\nВыберите способ подключения.', 'Add a support bot\n\nChoose a connection method.', 'Añadir un bot de soporte\n\nElige cómo conectarlo.', '添加支持机器人\n\n请选择连接方式。'],
  ['Подключить существующего', 'Connect existing bot', 'Conectar bot existente', '连接现有机器人'], ['Создать нового', 'Create new bot', 'Crear un bot nuevo', '创建新机器人'], ['Создать бота поддержки', 'Create support bot', 'Crear bot de soporte', '创建支持机器人'],
  ['Отправьте одним сообщением полный токен нового бота из BotFather. Сообщение с токеном будет удалено по возможности, в поддержку оно не пересылается.', 'Send the full token for the new bot from BotFather in one message. The token message will be deleted when possible and will not be forwarded to support.', 'Envía en un solo mensaje el token completo del nuevo bot de BotFather. El mensaje se eliminará si es posible y no se reenviará al soporte.', '请在一条消息中发送来自 BotFather 的新机器人完整令牌。系统会尽可能删除令牌消息，且不会将其转发到支持群组。'],
  ['Как называется сервис, который обслуживает этот бот? Отправьте название (до 64 символов), например «Мой магазин».', 'What service does this bot handle? Send its name (up to 64 characters), for example “My shop”.', '¿Qué servicio gestiona este bot? Envía su nombre (hasta 64 caracteres), por ejemplo «Mi tienda».', '此机器人负责什么服务？请发送名称（最多 64 个字符），例如“我的商店”。'],
  ['Использовать имя бота', 'Use bot name', 'Usar nombre del bot', '使用机器人名称'], ['Использовать название сервиса', 'Use service name', 'Usar nombre del servicio', '使用服务名称'],
  ['Подключить', 'Connect', 'Conectar', '连接'], ['Обновить подключение', 'Update connection', 'Actualizar conexión', '更新连接'], ['Переключить и подключить', 'Switch and connect', 'Cambiar y conectar', '切换并连接'], ['Изменить название', 'Edit name', 'Cambiar nombre', '修改名称'], ['Изменить префикс', 'Edit prefix', 'Cambiar prefijo', '修改前缀'],
  ['Открыть BotFather', 'Open BotFather', 'Abrir BotFather', '打开 BotFather'], ['Добавить в группу', 'Add to group', 'Añadir al grupo', '添加到群组'], ['Проверить подключение', 'Check connection', 'Comprobar conexión', '检查连接'],
  ['Использовать', 'Use', 'Usar', '使用'], ['Добавить ещё бота', 'Add another bot', 'Añadir otro bot', '添加另一个机器人'], ['Открыть General', 'Open General', 'Abrir General', '打开 General'],
  ['Настроить сообщения бота', 'Configure bot messages', 'Configurar mensajes del bot', '配置机器人消息'], ['📋 Скопировать сообщения', '📋 Copy messages', '📋 Copiar mensajes', '📋 复制消息'], ['⚙️ Настройки сервиса', '⚙️ Service settings', '⚙️ Configuración del servicio', '⚙️ 服务设置'],
  ['Пользователь заблокирован', 'User blocked', 'Usuario bloqueado', '用户已封禁'], ['Блокировка снята', 'Block removed', 'Bloqueo retirado', '已解除封禁'],
  ['Ограничение включено', 'Restriction enabled', 'Restricción activada', '限制已启用'], ['Ограничение снято', 'Restriction removed', 'Restricción retirada', '已解除限制'],
  ['Доверие включено', 'Trust enabled', 'Confianza activada', '已设为可信'], ['Доверие снято', 'Trust removed', 'Confianza retirada', '已取消信任'],
  ['Риск сброшен', 'Risk reset', 'Riesgo restablecido', '风险已重置'], ['Тема закрыта', 'Topic closed', 'Tema cerrado', '话题已关闭'], ['Тема открыта', 'Topic opened', 'Tema abierto', '话题已打开'],
  ['Обращение возобновлено пользователем', 'Conversation reopened by user', 'Conversación reabierta por el usuario', '用户已重新打开会话'],
  ['Тема восстановлена после удаления', 'Topic restored after deletion', 'Tema restaurado tras eliminarse', '话题删除后已恢复'], ['Удалённая тема восстановлена', 'Deleted topic restored', 'Tema eliminado restaurado', '已恢复已删除的话题'],
  ['Обращение взято', 'Conversation assigned', 'Conversación asignada', '会话已接手'], ['Назначение снято', 'Assignment removed', 'Asignación retirada', '已取消指派'],
  ['Ожидаем клиента', 'Waiting for customer', 'Esperando al cliente', '等待客户'], ['Обращение решено', 'Conversation resolved', 'Conversación resuelta', '会话已解决'], ['Обращению нужен ответ', 'Conversation needs a reply', 'La conversación necesita respuesta', '会话待回复'],
  ['Возврат через час', 'Return in one hour', 'Volver dentro de una hora', '一小时后返回'], ['Возврат завтра', 'Return tomorrow', 'Volver mañana', '明天返回'], ['Обращение передано', 'Conversation transferred', 'Conversación transferida', '会话已转交'], ['Обращение отложено', 'Conversation snoozed', 'Conversación pospuesta', '会话已延后'],
  ['Автоограничение', 'Automatic restriction', 'Restricción automática', '自动限制'], ['План Cloudflare изменён', 'Cloudflare plan updated', 'Plan de Cloudflare actualizado', 'Cloudflare 套餐已更新'],
  ['Защита возвращена в AUTO', 'Protection returned to AUTO', 'La protección volvió a AUTO', '防护已恢复为 AUTO'], ['Усиленная защита на час', 'Enhanced protection for one hour', 'Protección reforzada durante una hora', '增强防护一小时'], ['Защита выключена на час', 'Protection disabled for one hour', 'Protección desactivada durante una hora', '防护已关闭一小时'],
  ['Усиленная защита включена автоматически', 'Enhanced protection enabled automatically', 'Protección reforzada activada automáticamente', '已自动启用增强防护'], ['Усиленная защита завершена автоматически', 'Enhanced protection ended automatically', 'La protección reforzada terminó automáticamente', '增强防护已自动结束'],
  ['Реакции включены', 'Reactions enabled', 'Reacciones activadas', '回应已启用'], ['Реакции выключены', 'Reactions disabled', 'Reacciones desactivadas', '回应已停用'],
  ['Приветствие изменено', 'Welcome message updated', 'Mensaje de bienvenida actualizado', '欢迎语已更新'], ['Автоответ изменён', 'Automatic reply updated', 'Respuesta automática actualizada', '自动回复已更新'], ['Сообщения скопированы с другого бота', 'Messages copied from another bot', 'Mensajes copiados de otro bot', '已从其他机器人复制消息'],
  ['Приветствие включено', 'Welcome message enabled', 'Mensaje de bienvenida activado', '欢迎语已启用'], ['Приветствие выключено', 'Welcome message disabled', 'Mensaje de bienvenida desactivado', '欢迎语已停用'], ['Автоответ включён', 'Automatic reply enabled', 'Respuesta automática activada', '自动回复已启用'], ['Автоответ выключен', 'Automatic reply disabled', 'Respuesta automática desactivada', '自动回复已停用'],
  ['Цвет новых тем изменён', 'New topic color updated', 'Color de nuevos temas actualizado', '新话题颜色已更新'], ['Иконка новых тем изменена', 'New topic icon updated', 'Icono de nuevos temas actualizado', '新话题图标已更新'], ['Оформление тем сброшено', 'Topic style reset', 'Estilo de temas restablecido', '话题样式已重置'], ['Оператор добавлен', 'Operator added', 'Operador añadido', '已添加客服'], ['Оператор удалён', 'Operator removed', 'Operador eliminado', '已移除客服'],
  ['Заблокированы:', 'Blocked:', 'Bloqueados:', '已封禁：'], ['На проверке:', 'Under review:', 'En revisión:', '待审核：'], ['Доверенные:', 'Trusted:', 'De confianza:', '可信：'], ['Подозрительные:', 'Flagged:', 'Sospechosos:', '可疑：'], ['Ограничены:', 'Restricted:', 'Restringidos:', '受限：'], ['Доверие:', 'Trust:', 'Confianza:', '信任：'],
  ['Риск сейчас:', 'Current risk:', 'Riesgo actual:', '当前风险：'], ['Последняя активность:', 'Last activity:', 'Última actividad:', '最近活动：'], ['Доступ к переписке:', 'Messaging access:', 'Acceso a mensajes:', '消息访问：'], ['Ожидающих сообщений:', 'Pending messages:', 'Mensajes pendientes:', '待处理消息：'], ['Ожидающих возобновления:', 'Waiting to reopen:', 'Pendientes de reanudación:', '等待恢复：'],
  ['✅ Подключение и обмен сообщениями подтверждены.', '✅ Connection and messaging are verified.', '✅ Conexión e intercambio de mensajes verificados.', '✅ 连接和消息往返已确认。'],
  ['Сервис выключен.', 'Service disabled.', 'Servicio desactivado.', '服务已关闭。'], ['Группа сервиса не подключена.', 'Service group is not connected.', 'El grupo del servicio no está conectado.', '服务群组未连接。'], ['Право сервисного бота управлять темами не подтверждено.', 'Service bot topic-management permission is unverified.', 'No se verificó el permiso del bot de servicio para gestionar temas.', '尚未确认服务机器人管理话题的权限。'],
  ['Право Админушки управлять темами не подтверждено.', 'Adminushka topic-management permission is unverified.', 'No se verificó el permiso de Adminushka para gestionar temas.', '尚未确认 Adminushka 管理话题的权限。'], ['Право Админушки закреплять сообщения не подтверждено.', 'Adminushka message-pinning permission is unverified.', 'No se verificó el permiso de Adminushka para fijar mensajes.', '尚未确认 Adminushka 置顶消息的权限。'],
  ['Присутствие главного администратора в группе не подтверждено.', 'Primary administrator membership in the group is unverified.', 'No se verificó la presencia del administrador principal en el grupo.', '尚未确认主管理员在群组中的成员身份。'], ['Связь с ботом не подтверждена.', 'Bot connection is unverified.', 'No se confirmó la conexión del bot.', '机器人连接尚未确认。'], ['Обмен сообщениями в обе стороны ещё не подтверждён.', 'Two-way messaging has not been verified yet.', 'Aún no se verificó el intercambio de mensajes en ambas direcciones.', '尚未确认双向消息往返。'],
  ['не проводилась', 'not run', 'no se ejecutó', '未运行'], ['не проводился', 'not run', 'no se ejecutó', '未运行'], ['не подключена', 'not connected', 'no conectada', '未连接'], ['не подключен', 'not connected', 'no conectado', '未连接'], ['не подтверждено', 'unverified', 'sin confirmar', '未确认'], ['не подтверждён', 'unverified', 'sin confirmar', '未确认'], ['не подтверждена', 'unverified', 'sin confirmar', '未确认'], ['подтверждён', 'verified', 'confirmado', '已确认'], ['подтверждена', 'verified', 'confirmada', '已确认'], ['подтверждено', 'verified', 'confirmado', '已确认'],
  ['ожидает открытия бота', 'waiting for bot to be opened', 'esperando que se abra el bot', '等待打开机器人'], ['создание темы не подтверждено', 'topic creation unverified', 'creación del tema sin confirmar', '话题创建未确认'], ['ожидает контрольного ответа', 'waiting for test reply', 'esperando la respuesta de prueba', '等待测试回复'], ['ответ не подтверждён', 'reply unverified', 'respuesta sin confirmar', '回复未确认'], ['не проводился', 'not run', 'no se ejecutó', '未运行'], ['не проводилось', 'not run', 'no se ejecutó', '未运行'],
  ['исход неясен — сначала проверьте переписку', 'uncertain outcome — check the conversation first', 'resultado incierto: comprueba primero la conversación', '结果不明——请先检查对话'], ['ожидает CAPTCHA', 'waiting for CAPTCHA', 'esperando CAPTCHA', '等待 CAPTCHA'], ['пользователь заблокирован', 'user is blocked', 'usuario bloqueado', '用户已封禁'], ['ручное ограничение', 'manual restriction', 'restricción manual', '手动限制'], ['автоограничение', 'automatic restriction', 'restricción automática', '自动限制'], ['бот выключен', 'bot disabled', 'bot desactivado', '机器人已关闭'], ['нужна проверка исходного сообщения', 'source message needs checking', 'hay que comprobar el mensaje original', '需要检查原始消息'], ['готово к безопасному повтору', 'ready for a safe retry', 'listo para reintentar de forma segura', '可安全重试'],
  ['оператор → клиент', 'operator → customer', 'operador → cliente', '客服 → 客户'], ['клиент → поддержка', 'customer → support', 'cliente → soporte', '客户 → 支持'], ['нет записи очереди', 'no queue entry', 'sin entrada en la cola', '无队列记录'], ['Активная карточка обращения не найдена.', 'No active conversation card was found.', 'No se encontró una ficha de conversación activa.', '未找到有效会话卡片。'], ['Записей о незавершённой доставке для пользователя нет.', 'No incomplete delivery records for this user.', 'No hay registros de entregas incompletas para este usuario.', '此用户没有未完成投递记录。'],
  ['Язык сохранён.', 'Language saved.', 'Idioma guardado.', '语言已保存。'], ['Выберите язык интерфейса.', 'Choose the interface language.', 'Elige el idioma de la interfaz.', '请选择界面语言。'], ['Язык интерфейса', 'Interface language', 'Idioma de la interfaz', '界面语言'],
  ['🌐 Язык интерфейса', '🌐 Interface language', '🌐 Idioma de la interfaz', '🌐 界面语言'],
  ['Язык сервиса нельзя изменить через меню.', 'The service language cannot be changed from this menu.', 'No se puede cambiar el idioma del servicio desde este menú.', '无法通过此菜单更改服务语言。'], ['Язык применяется к новым сообщениям и уведомлениям.', 'The language applies to new messages and notifications.', 'El idioma se aplica a mensajes y avisos nuevos.', '语言将应用于新消息和通知。'],
  ['Заблокированные', 'Blocked', 'Bloqueados', '已封禁'], ['⏳ Ограниченные', '⏳ Restricted', '⏳ Restringidos', '⏳ 受限'], ['🧩 На проверке', '🧩 Under review', '🧩 En revisión', '🧩 待审核'], ['⚠️ Подозрительные', '⚠️ Flagged', '⚠️ Sospechosos', '⚠️ 可疑'], ['✅ Доверенные', '✅ Trusted', '✅ De confianza', '✅ 可信'], ['🕘 Недавние', '🕘 Recent', '🕘 Recientes', '🕘 最近'],
  ['без username · ', 'no username · ', 'sin username · ', '无 username · '], ['закрыто', 'closed', 'cerrada', '已关闭'], ['открыто', 'open', 'abierta', '开放'], ['нет темы', 'no topic', 'sin tema', '没有话题'], ['тема ещё не создана', 'topic not created yet', 'tema aún no creada', '话题尚未创建'],
  ['Сервис приостановлен (только просмотр)', 'Service paused (read-only)', 'Servicio pausado (solo lectura)', '服务已暂停（只读）'], ['сервис приостановлен (только просмотр)', 'service paused (read-only)', 'servicio pausado (solo lectura)', '服务已暂停（只读）'],
  ['Username:', 'Username:', 'Nombre de usuario:', '用户名：'], ['Telegram ID:', 'Telegram ID:', 'ID de Telegram:', 'Telegram ID：'], ['Состояние:', 'State:', 'Estado:', '状态：'], ['Последняя активность:', 'Last activity:', 'Última actividad:', '最近活动：'], ['Обращение:', 'Conversation:', 'Conversación:', '会话：'], ['Доступ к переписке:', 'Messaging access:', 'Acceso a mensajes:', '消息访问：'], ['Доверие:', 'Trust:', 'Confianza:', '信任：'], ['Ожидающих сообщений:', 'Pending messages:', 'Mensajes pendientes:', '待处理消息：'], ['ожидающих возобновления:', 'waiting to reopen:', 'pendientes de reanudación:', '等待恢复：'], ['• Блокировка оператором', '• Blocked by an operator', '• Bloqueado por un operador', '• 已被客服封禁'], ['• Ручное ограничение до ', '• Manual restriction until ', '• Restricción manual hasta ', '• 手动限制至 '], ['• Автоограничение до ', '• Automatic restriction until ', '• Restricción automática hasta ', '• 自动限制至 '], ['• Требуется CAPTCHA', '• CAPTCHA required', '• CAPTCHA requerida', '• 需要 CAPTCHA'], ['Действующих блокировок и CAPTCHA нет.', 'No active blocks or CAPTCHA checks.', 'No hay bloqueos activos ni CAPTCHA.', '没有有效封禁或 CAPTCHA 检查。'],
  ['Пользователь заблокирован', 'User blocked', 'Usuario bloqueado', '用户已封禁'], ['Пользователь ограничен', 'User restricted', 'Usuario restringido', '用户已受限'], ['Ручное ограничение', 'Manual restriction', 'Restricción manual', '手动限制'], ['Автоограничение', 'Automatic restriction', 'Restricción automática', '自动限制'], ['ожидает капчу', 'waiting for CAPTCHA', 'esperando CAPTCHA', '等待 CAPTCHA'], ['нужен повтор от Telegram', 'Telegram retry required', 'se requiere reintento de Telegram', '需要 Telegram 重试'], ['можно повторить', 'can be retried', 'se puede reintentar', '可以重试'], ['Последние действия:', 'Recent actions:', 'Acciones recientes:', '最近操作：'], ['Очередь операторов:', 'Operator queue:', 'Cola de operadores:', '客服队列：'], ['ответственный', 'assigned to', 'asignado a', '负责人'], ['Входящее:', 'Inbound:', 'Entrante:', '收到：'], ['ответ:', 'reply:', 'respuesta:', '回复：'], ['Страница {value}/{value}', 'Page {value}/{value}', 'Página {value}/{value}', '第 {value}/{value} 页'],
  ['Здоровье системы · страница {value}/{value}', 'System health · page {value}/{value}', 'Estado del sistema · página {value}/{value}', '系统状态 · 第 {value}/{value} 页'],
  ['включён', 'enabled', 'activado', '已启用'], ['выключен', 'disabled', 'desactivado', '已停用'], ['включено осознанно', 'intentionally enabled', 'activado deliberadamente', '已主动启用'], ['не проводилась', 'not run', 'no realizada', '未运行'], ['группа не подключена', 'group not connected', 'grupo no conectado', '群组未连接'], ['группа ', 'group ', 'grupo ', '群组 '], ['меню готово', 'menu ready', 'menú listo', '菜单已就绪'], ['меню ', 'menu ', 'menú ', '菜单 '], ['не подтверждено', 'unverified', 'sin confirmar', '未确认'], ['истекает ', 'expires ', 'vence ', '到期 '], ['Незавершённые доставки:', 'Incomplete deliveries:', 'Entregas incompletas:', '未完成投递：'], ['Неясный исход:', 'Uncertain outcome:', 'Resultado incierto:', '结果不明：'], ['заблокировано или ждёт действия:', 'blocked or awaiting action:', 'bloqueado o pendiente de acción:', '已阻止或等待操作：'], ['База данных:', 'Database:', 'Base de datos:', '数据库：'], ['выполняется обслуживание.', 'maintenance in progress.', 'mantenimiento en curso.', '正在维护。'], ['доступна.', 'available.', 'disponible.', '可用。'], ['Задержанных сообщений в выборке нет.', 'No delayed messages in this sample.', 'No hay mensajes retrasados en esta muestra.', '此样本中没有延迟消息。'],
  ['Записей:', 'Records:', 'Registros:', '记录：'], ['Проблемы доставки', 'Delivery problems', 'Problemas de entrega', '投递问题'], ['Открыть', 'Open', 'Abrir', '打开'], ['Открыть · {value} · {value}', 'Open · {value} · {value}', 'Abrir · {value} · {value}', '打开 · {value} · {value}'], ['Проверка: ', 'Check: ', 'Comprobación: ', '检查：'], ['Контрольный обмен:', 'Test exchange:', 'Intercambio de prueba:', '测试消息往返：'], ['последний успех ', 'last successful ', 'último éxito ', '最近成功 '], ['Требует проверки:', 'Needs review:', 'Requiere revisión:', '需要检查：'], ['Краткий результат', 'Summary', 'Resumen', '摘要'], ['Технические детали', 'Technical details', 'Detalles técnicos', '技术详情'], ['К сервису', 'Service', 'Al servicio', '返回服务'], ['Назад к сервису', 'Back to service', 'Volver al servicio', '返回服务'],
  ['Сообщения', 'Messages', 'Mensajes', '消息'], ['Автоответ', 'Automatic reply', 'Respuesta automática', '自动回复'], ['включено осознанно', 'intentionally enabled', 'activado deliberadamente', '已主动启用'], ['не настроено', 'not configured', 'sin configurar', '未配置'], ['Право сервисного бота управлять темами не подтверждено.', 'The service bot’s permission to manage topics is unverified.', 'No se verificó el permiso del bot de servicio para gestionar temas.', '尚未确认服务机器人管理话题的权限。'], ['Право Админушки управлять темами не подтверждено.', 'Adminushka’s permission to manage topics is unverified.', 'No se verificó el permiso de Adminushka para gestionar temas.', '尚未确认 Adminushka 管理话题的权限。'], ['Право Админушки закреплять сообщения не подтверждено.', 'Adminushka’s permission to pin messages is unverified.', 'No se verificó el permiso de Adminushka para fijar mensajes.', '尚未确认 Adminushka 置顶消息的权限。'], ['Webhook требует проверки.', 'Webhook needs review.', 'El webhook requiere revisión.', 'Webhook 需要检查。'], ['В Telegram есть ожидающие обновления.', 'Telegram has pending updates.', 'Telegram tiene actualizaciones pendientes.', 'Telegram 有待处理更新。'], ['Контрольный обмен: {value}.', 'Test exchange: {value}.', 'Intercambio de prueba: {value}.', '测试消息往返：{value}。'], ['Сервис выключен аварийным выключателем D1. Сначала включите сервис.', 'The service is disabled by the D1 kill switch. Enable it first.', 'El servicio está desactivado por el interruptor D1. Actívalo primero.', '服务已被 D1 紧急开关关闭。请先启用服务。'], ['Сначала подключите сервисного бота к группе поддержки.', 'Connect the service bot to the support group first.', 'Primero conecta el bot del servicio al grupo de soporte.', '请先将服务机器人连接到支持群组。'],
  ['Назначение:', 'Assignment:', 'Asignación:', '指派：'], ['Откройте BotFather', 'Open BotFather', 'Abrir BotFather', '打开 BotFather'], ['Создайте бота кнопкой ниже. После создания вернитесь в этот чат.', 'Create a bot with the button below. Return to this chat when it is ready.', 'Crea un bot con el botón de abajo. Vuelve a este chat cuando esté listo.', '点击下方按钮创建机器人。完成后返回此聊天。'], ['1. Подготовьте бота в @BotFather.', '1. Prepare the bot in @BotFather.', '1. Prepara el bot en @BotFather.', '1. 在 @BotFather 中准备机器人。'], ['Allow Groups — включить (Enable).', 'Allow Groups — enable.', 'Allow Groups — activar.', 'Allow Groups — 启用。'], ['Group Privacy — выключить (Disable, рекомендуется).', 'Group Privacy — disable (recommended).', 'Group Privacy — desactivar (recomendado).', 'Group Privacy — 关闭（建议）。'], ['Group Admin Rights → Manage Group — включить.', 'Group Admin Rights → Manage Group — enable.', 'Group Admin Rights → Manage Group — activar.', 'Group Admin Rights → Manage Group — 启用。'], ['Allow Groups также доступен через /setjoingroups, Group Privacy — через /setprivacy.', 'Allow Groups is also available through /setjoingroups; Group Privacy through /setprivacy.', 'Allow Groups también está disponible en /setjoingroups; Group Privacy, en /setprivacy.', '也可通过 /setjoingroups 设置 Allow Groups，通过 /setprivacy 设置 Group Privacy。'], ['Бот-администратор получает сообщения группы и при включённом Group Privacy. Group Admin Rights задаёт предлагаемые права при добавлении, а не выдаёт их в существующей группе.', 'A bot administrator receives group messages even with Group Privacy enabled. Group Admin Rights sets suggested permissions when adding the bot; it does not grant permissions in an existing group.', 'Un bot administrador recibe mensajes del grupo incluso con Group Privacy activado. Group Admin Rights define los permisos sugeridos al añadirlo, pero no los concede en un grupo existente.', '即使启用了 Group Privacy，机器人管理员也会收到群组消息。Group Admin Rights 只设置添加时建议的权限，不会授予现有群组中的权限。'], ['2. Добавьте сервисного бота в выбранную группу администратором с правом Manage Topics (управление темами). Закреплением меню занимается управляющий бот.', '2. Add the service bot to the selected group as an administrator with Manage Topics permission. The manager bot pins the menu.', '2. Añade el bot del servicio al grupo seleccionado como administrador con permiso Manage Topics. El bot de gestión fija el menú.', '2. 将服务机器人作为管理员添加到所选群组，并授予 Manage Topics 权限。管理机器人负责置顶菜单。'], ['2. Нажмите «Добавить в группу», выберите «Поддержка» и назначьте бота администратором с правами Manage Topics (управление темами) и Pin Messages (закрепление сообщений). Если бот уже в группе, проверьте эти права в её настройках.', '2. Tap “Add to group”, choose “Support”, and make the bot an administrator with Manage Topics and Pin Messages permissions. If it is already in the group, check these permissions in group settings.', '2. Pulsa «Añadir al grupo», elige «Soporte» y haz administrador al bot con permisos Manage Topics y Pin Messages. Si ya está en el grupo, comprueba esos permisos en la configuración.', '2. 点击“添加到群组”，选择“支持”，并将机器人设为管理员，授予 Manage Topics 和 Pin Messages 权限。如果机器人已在群组中，请检查群组设置中的权限。'], ['3. Вернитесь сюда и нажмите «Проверить подключение». Мастер проверит фактические права бота в группе.', '3. Return here and tap “Check connection”. The wizard will verify the bot’s actual group permissions.', '3. Vuelve aquí y pulsa «Comprobar conexión». El asistente verificará los permisos reales del bot en el grupo.', '3. 返回此处并点击“检查连接”。向导将验证机器人在群组中的实际权限。'], ['Группа Adminushka', 'Adminushka group', 'Grupo de Adminushka', 'Adminushka 群组'], ['Действие: {value}', 'Action: {value}', 'Acción: {value}', '操作：{value}'], ['Истёк срок', 'Expired', 'Caducado', '已过期'], ['Срок', 'Duration', 'Duración', '时长'], ['Причина', 'Reason', 'Motivo', '原因'], ['Сбросить риск и CAPTCHA', 'Reset risk and CAPTCHA', 'Restablecer riesgo y CAPTCHA', '重置风险和 CAPTCHA'],
  ['ограничен', 'restricted', 'restringido', '受限'], ['автоограничение', 'automatic restriction', 'restricción automática', '自动限制'],
  ['ручное', 'manual', 'manual', '手动'], ['CAPTCHA:', 'CAPTCHA:', 'CAPTCHA:', 'CAPTCHA：'], ['ожидающих возобновления:', 'waiting to reopen:', 'pendientes de reanudación:', '等待恢复：'],
  ['Подтвердите действие: {value}\nСервис: {value}\nTelegram ID: {value}\nСрок: {value}\nПричина: {value}', 'Confirm action: {value}\nService: {value}\nTelegram ID: {value}\nDuration: {value}\nReason: {value}', 'Confirma la acción: {value}\nServicio: {value}\nID de Telegram: {value}\nDuración: {value}\nMotivo: {value}', '确认操作：{value}\n服务：{value}\nTelegram ID：{value}\n时长：{value}\n原因：{value}'],
  ['Пользователь заблокирован', 'User blocked', 'Usuario bloqueado', '用户已封禁'], ['Блокировка снята', 'Block removed', 'Bloqueo eliminado', '封禁已解除'], ['Ограничение включено', 'Restriction enabled', 'Restricción activada', '限制已启用'], ['Ограничение снято', 'Restriction removed', 'Restricción eliminada', '限制已解除'], ['Доверие включено', 'Trust enabled', 'Confianza activada', '信任已启用'], ['Доверие снято', 'Trust removed', 'Confianza eliminada', '信任已取消'], ['Риск сброшен', 'Risk reset', 'Riesgo restablecido', '风险已重置'],
  ['исход неясен — сначала проверьте переписку', 'uncertain outcome — check the conversation first', 'resultado incierto: comprueba primero la conversación', '结果不明——请先检查对话'], ['ожидает CAPTCHA', 'waiting for CAPTCHA', 'esperando CAPTCHA', '等待 CAPTCHA'], ['пользователь заблокирован', 'user is blocked', 'usuario bloqueado', '用户已封禁'], ['ручное ограничение', 'manual restriction', 'restricción manual', '手动限制'], ['бот выключен', 'bot disabled', 'bot desactivado', '机器人已关闭'], ['нужна проверка исходного сообщения', 'source message needs checking', 'hay que comprobar el mensaje original', '需要检查原始消息'], ['готово к безопасному повтору', 'ready for a safe retry', 'listo para reintentar de forma segura', '可安全重试'],
  ['Ручное доверие снимет автомьют и CAPTCHA; ожидающие сообщения могут быть доставлены.', 'Manual trust will clear the automatic mute and CAPTCHA; pending messages may be delivered.', 'La confianza manual quitará el silencio automático y CAPTCHA; se podrán entregar los mensajes pendientes.', '手动信任将解除自动禁言和 CAPTCHA；待处理消息可能会送达。'], ['Риск станет 0, автомьют и CAPTCHA будут сняты; ожидающие сообщения могут быть доставлены.', 'Risk will become 0, and the automatic mute and CAPTCHA will be cleared; pending messages may be delivered.', 'El riesgo pasará a 0 y se quitarán el silencio automático y CAPTCHA; se podrán entregar los mensajes pendientes.', '风险将归零，并解除自动禁言和 CAPTCHA；待处理消息可能会送达。'], ['Недоставленные сообщения будут удалены из очереди и их потребуется отправить заново.', 'Undelivered messages will be removed from the queue and must be sent again.', 'Los mensajes no entregados se quitarán de la cola y habrá que enviarlos de nuevo.', '未送达的消息将从队列中移除，需要重新发送。'],
  ['К карточке', 'Back to card', 'Volver a la ficha', '返回卡片'], ['Сервис:', 'Service:', 'Servicio:', '服务：'], ['Срок:', 'Duration:', 'Duración:', '时长：'], ['Причина:', 'Reason:', 'Motivo:', '原因：'], ['Риск сейчас:', 'Current risk:', 'Riesgo actual:', '当前风险：'], ['Последняя активность:', 'Last activity:', 'Última actividad:', '最近活动：'], ['Обращение:', 'Conversation:', 'Conversación:', '会话：'], ['Доступ к переписке:', 'Messaging access:', 'Acceso a mensajes:', '消息访问：'], ['Доверие:', 'Trust:', 'Confianza:', '信任：'], ['Ожидающих сообщений:', 'Pending messages:', 'Mensajes pendientes:', '待处理消息：'],
  ['Тема ещё не создана', 'Topic not created yet', 'El tema aún no se ha creado', '话题尚未创建'], ['Блокировка оператором', 'Blocked by an operator', 'Bloqueado por un operador', '已被客服封禁'], ['Ручное ограничение до ', 'Manual restriction until ', 'Restricción manual hasta ', '手动限制至 '], ['Автоограничение до ', 'Automatic restriction until ', 'Restricción automática hasta ', '自动限制至 '], ['Требуется CAPTCHA', 'CAPTCHA required', 'Se requiere CAPTCHA', '需要 CAPTCHA'], ['Действующих блокировок и CAPTCHA нет.', 'No active blocks or CAPTCHA checks.', 'No hay bloqueos activos ni CAPTCHA.', '没有有效封禁或 CAPTCHA 检查。'], ['нет', 'none', 'ninguno', '无'], ['• Ручное ограничение до {value}', '• Manual restriction until {value}', '• Restricción manual hasta {value}', '• 手动限制至 {value}'], ['• Автоограничение до {value}', '• Automatic restriction until {value}', '• Restricción automática hasta {value}', '• 自动限制至 {value}'],
  ['страница {value}/{value}', 'page {value}/{value}', 'página {value}/{value}', '第 {value}/{value} 页'], ['ожидает', 'waiting', 'en espera', '等待中'], ['мин', 'min', 'min', '分钟'], ['Сообщение {value}', 'Message {value}', 'Mensaje {value}', '消息 {value}'],
  ['Записей: {value} · страница {value}/{value}', 'Records: {value} · page {value}/{value}', 'Registros: {value} · página {value}/{value}', '记录：{value} · 第 {value}/{value} 页'], ['Статус доставки сообщения #{value}', 'Message delivery status #{value}', 'Estado de entrega del mensaje #{value}', '消息投递状态 #{value}'],
];

const managerCatalogSupplement = [
  ['📥 Мои обращения', '📥 My conversations', '📥 Mis conversaciones', '📥 我的会话'], ['📋 Все обращения', '📋 All conversations', '📋 Todas las conversaciones', '📋 全部会话'], ['🔥 Просроченные', '🔥 Overdue', '🔥 Vencidas', '🔥 逾期'], ['📂 Очереди, доставка, черновики', '📂 Queues, delivery, drafts', '📂 Colas, entrega y borradores', '📂 队列、投递和草稿'], ['👥 Пользователи', '👥 Users', '👥 Usuarios', '👥 用户'], ['🔎 Поиск', '🔎 Search', '🔎 Buscar', '🔎 搜索'], ['👥 Операторы', '👥 Operators', '👥 Operadores', '👥 客服人员'], ['🤖 Управление ботами поддержки', '🤖 Support bots', '🤖 Bots de soporte', '🤖 支持机器人'], ['🚨 Алерты', '🚨 Alerts', '🚨 Alertas', '🚨 提醒'], ['📊 Контроль и восстановление', '📊 Monitoring and recovery', '📊 Supervisión y recuperación', '📊 监控与恢复'], ['☁️ План и хранилище', '☁️ Plan and storage', '☁️ Plan y almacenamiento', '☁️ 套餐与存储'], ['📜 Журнал действий', '📜 Activity log', '📜 Registro de actividad', '📜 操作日志'], ['❓ Помощь', '❓ Help', '❓ Ayuda', '❓ 帮助'], ['🔥 Мои просроченные', '🔥 My overdue', '🔥 Mis vencidas', '🔥 我的逾期会话'], ['🧪 Реакции всех сервисов', '🧪 All-service reactions', '🧪 Reacciones de todos los servicios', '🧪 所有服务的回应'], ['📥 Очереди', '📥 Queues', '📥 Colas', '📥 队列'], ['📨 Проблемы доставки', '📨 Delivery problems', '📨 Problemas de entrega', '📨 投递问题'], ['📝 Черновики', '📝 Drafts', '📝 Borradores', '📝 草稿'], ['🔥 Все просроченные', '🔥 All overdue', '🔥 Todas las vencidas', '🔥 全部逾期'], ['📊 Контроль ожидания', '📊 Waiting overview', '📊 Resumen de espera', '📊 等待概览'], ['🩺 Здоровье системы', '🩺 System health', '🩺 Estado del sistema', '🩺 系统状态'], ['☁️ План Cloudflare', '☁️ Cloudflare plan', '☁️ Plan de Cloudflare', '☁️ Cloudflare 套餐'], ['🗄️ Хранилище', '🗄️ Storage', '🗄️ Almacenamiento', '🗄️ 存储'], ['← Главное меню', '← Main menu', '← Menú principal', '← 主菜单'],
  ['🔎 Новый поиск', '🔎 New search', '🔎 Nueva búsqueda', '🔎 新搜索'], ['15 минут', '15 minutes', '15 minutos', '15 分钟'], ['1 час', '1 hour', '1 hora', '1 小时'], ['24 часа', '24 hours', '24 horas', '24 小时'], ['Другой срок', 'Custom duration', 'Otra duración', '自定义时长'],
  ['🧪 Проверить в Telegram', '🧪 Check in Telegram', '🧪 Comprobar en Telegram', '🧪 在 Telegram 中检查'], ['Проверка ещё не запускалась.', 'The check has not started yet.', 'La comprobación aún no se ha iniciado.', '尚未开始检查。'], ['Начать проверку', 'Start check', 'Iniciar comprobación', '开始检查'], ['Открыть бота для проверки', 'Open bot for check', 'Abrir el bot para comprobarlo', '打开机器人进行检查'], ['Тест в личном чате', 'Private chat test', 'Prueba en chat privado', '私聊测试'], ['Тест в General', 'General test', 'Prueba en General', 'General 测试'], ['Закрыть проверку', 'Close check', 'Cerrar comprobación', '关闭检查'], ['Начать новую проверку', 'Start a new check', 'Iniciar una nueva comprobación', '开始新检查'], ['Цвет стандартной иконки', 'Standard icon color', 'Color del icono estándar', '标准图标颜色'], ['Эмодзи-иконка', 'Emoji icon', 'Icono emoji', '表情图标'], ['Сбросить оформление', 'Reset style', 'Restablecer estilo', '重置样式'], ['Не удалось загрузить иконки Telegram. Повторите позже.', 'Could not load Telegram icons. Try again later.', 'No se pudieron cargar los iconos de Telegram. Inténtalo más tarde.', '无法加载 Telegram 图标，请稍后重试。'], ['Повторить загрузку', 'Retry loading', 'Reintentar carga', '重新加载'], ['Стандартная иконка', 'Standard icon', 'Icono estándar', '标准图标'],
  ['Укажите срок от 5 минут до 30 дней: например 45m, 6h, 7d.', 'Enter a duration from 5 minutes to 30 days, for example 45m, 6h, 7d.', 'Indica una duración de 5 minutos a 30 días, por ejemplo 45m, 6h, 7d.', '请输入 5 分钟至 30 天的时长，例如 45m、6h、7d。'], ['Продолжите ограничение: укажите срок от 5 минут до 30 дней, например 45m, 6h, 7d.', 'Continue the restriction: enter a duration from 5 minutes to 30 days, for example 45m, 6h, 7d.', 'Continúa la restricción: indica una duración de 5 minutos a 30 días, por ejemplo 45m, 6h, 7d.', '继续限制：请输入 5 分钟至 30 天的时长，例如 45m、6h、7d。'], ['Продолжите действие: укажите внутреннюю причину от 3 до 500 символов.', 'Continue the action: enter an internal reason of 3 to 500 characters.', 'Continúa la acción: indica un motivo interno de 3 a 500 caracteres.', '继续操作：请输入 3 至 500 个字符的内部原因。'], ['Форма устарела. Откройте карточку заново.', 'This form has expired. Reopen the card.', 'Este formulario caducó. Vuelve a abrir la ficha.', '此表单已过期，请重新打开卡片。'], ['Укажите новую внутреннюю причину от 3 до 500 символов.', 'Enter a new internal reason of 3 to 500 characters.', 'Indica un nuevo motivo interno de 3 a 500 caracteres.', '请输入新的 3 至 500 个字符的内部原因。'], ['Укажите новый срок от 5 минут до 30 дней: 45m, 6h или 7d.', 'Enter a new duration from 5 minutes to 30 days: 45m, 6h, or 7d.', 'Indica una nueva duración de 5 minutos a 30 días: 45m, 6h o 7d.', '请输入新的时长，范围为 5 分钟至 30 天：45m、6h 或 7d。'], ['Подтверждение устарело. Откройте карточку заново.', 'This confirmation has expired. Reopen the card.', 'Esta confirmación caducó. Vuelve a abrir la ficha.', '此确认已过期，请重新打开卡片。'], ['Карточка изменилась.', 'The card changed.', 'La ficha cambió.', '卡片已更改。'], ['ожидает проверку', 'awaiting review', 'pendiente de revisión', '待审核'],
  ['🧪 Контрольный обмен', '🧪 Test exchange', '🧪 Intercambio de prueba', '🧪 测试消息往返'], ['исход неясен', 'outcome unclear', 'resultado incierto', '结果不明'], ['пользователь ограничен', 'user is restricted', 'usuario restringido', '用户已受限'], ['временное ограничение', 'temporary restriction', 'restricción temporal', '临时限制'],
  ['Выключить автоматическую защиту {value} на один час?', 'Disable automatic protection for {value} for one hour?', '¿Desactivar la protección automática de {value} durante una hora?', '关闭 {value} 的自动防护一小时？'], ['Сначала подтвердите отключение защиты.', 'Confirm disabling protection first.', 'Confirma primero la desactivación de la protección.', '请先确认关闭防护。'], ['Да, выключить', 'Yes, disable', 'Sí, desactivar', '是，关闭'],
  ['Проблемы доставки · {value}', 'Delivery problems · {value}', 'Problemas de entrega · {value}', '投递问题 · {value}'], ['🌐 Сменить язык', '🌐 Change language', '🌐 Cambiar idioma', '🌐 更改语言'], ['⚙️ Настройки сервиса', '⚙️ Service settings', '⚙️ Ajustes del servicio', '⚙️ 服务设置'], ['🛡 Защита сервиса', '🛡 Service protection', '🛡 Protección del servicio', '🛡 服务防护'], ['🔄 Проверка и восстановление доставки', '🔄 Delivery checks and recovery', '🔄 Comprobación y recuperación de entregas', '🔄 投递检查与恢复'], ['🩺 Здоровье сервиса', '🩺 Service health', '🩺 Estado del servicio', '🩺 服务状态'],
  ['Реакции всех сервисов · страница {value}/{value}', 'All-service reactions · page {value}/{value}', 'Reacciones de todos los servicios · página {value}/{value}', '所有服务回应 · 第 {value}/{value} 页'], ['Здоровье системы · {value}', 'System health · {value}', 'Estado del sistema · {value}', '系统状态 · {value}'], ['История пользователя {value} · {value} · страница {value}', 'User history {value} · {value} · page {value}', 'Historial del usuario {value} · {value} · página {value}', '用户历史 {value} · {value} · 第 {value} 页'],
  ['Поддержка → пользователь: {value}', 'Support → user: {value}', 'Soporte → usuario: {value}', '支持人员 → 用户：{value}'], ['Пользователь → поддержка: {value}', 'User → support: {value}', 'Usuario → soporte: {value}', '用户 → 支持人员：{value}'], ['🟢 включено, проверено', '🟢 enabled, verified', '🟢 activado y verificado', '🟢 已启用并验证'], ['🟢 включено, не проверено', '🟢 enabled, not verified', '🟢 activado, sin verificar', '🟢 已启用，未验证'], ['проверено, выключено', 'verified, disabled', 'verificado, desactivado', '已验证，未启用'], ['выключено, не проверено', 'disabled, not verified', 'desactivado, sin verificar', '未启用，未验证'], ['🔴 Выключить поддержка → пользователь', '🔴 Disable Support → user', '🔴 Desactivar soporte → usuario', '🔴 关闭支持人员 → 用户'], ['🟢 Включить поддержка → пользователь', '🟢 Enable Support → user', '🟢 Activar soporte → usuario', '🟢 启用支持人员 → 用户'], ['🔴 Выключить пользователь → поддержка', '🔴 Disable user → support', '🔴 Desactivar usuario → soporte', '🔴 关闭用户 → 支持人员'], ['🟢 Включить пользователь → поддержка', '🟢 Enable user → support', '🟢 Activar usuario → soporte', '🟢 启用用户 → 支持人员'],
  ['готово', 'ready', 'listo', '就绪'], ['done', 'complete', 'completado', '完成'], ['ожидание', 'waiting', 'en espera', '等待中'], ['ответ', 'reply', 'respuesta', '回复'], ['создание', 'creating', 'creando', '正在创建'], ['отправка', 'sending', 'enviando', '正在发送'], ['не подтверждено', 'unconfirmed', 'sin confirmar', '未确认'], ['🔴 Выключить Поддержка → пользователь', '🔴 Disable Support → user', '🔴 Desactivar soporte → usuario', '🔴 关闭支持人员 → 用户'], ['🟢 Включить Поддержка → пользователь', '🟢 Enable Support → user', '🟢 Activar soporte → usuario', '🟢 启用支持人员 → 用户'], ['🔴 Выключить Пользователь → поддержка', '🔴 Disable user → support', '🔴 Desactivar usuario → soporte', '🔴 关闭用户 → 支持人员'], ['🟢 Включить Пользователь → поддержка', '🟢 Enable user → support', '🟢 Activar usuario → soporte', '🟢 启用用户 → 支持人员'],
  ['Людей: {value} · профилей: {value}', 'People: {value} · profiles: {value}', 'Personas: {value} · perfiles: {value}', '用户数：{value} · 资料数：{value}'],
  ['  группа {value}, меню готово; проверка: {value}, истекает {value}', '  group {value}, menu ready; check: {value}, expires {value}', '  grupo {value}, menú listo; comprobación: {value}, vence {value}', '  群组 {value}，菜单已就绪；检查：{value}，到期时间 {value}'], ['  группа не подключена; проверка: {value}, истекает {value}', '  group not connected; check: {value}, expires {value}', '  grupo no conectado; comprobación: {value}, vence {value}', '  群组未连接；检查：{value}，到期时间 {value}'], ['  группа {value}, меню {value}; проверка: {value}, истекает {value}', '  group {value}, menu {value}; check: {value}, expires {value}', '  grupo {value}, menú {value}; comprobación: {value}, vence {value}', '  群组 {value}，菜单 {value}；检查：{value}，到期时间 {value}'],
  ['Сервис выключен аварийным выключателем D1.', 'The service is disabled by the D1 kill switch.', 'El servicio está desactivado por el interruptor D1.', '服务已被 D1 紧急开关关闭。'], ['План', 'Plan', 'Plan', '套餐'], ['Применить', 'Apply', 'Aplicar', '应用'], ['Проверить реакции', 'Check reactions', 'Comprobar reacciones', '检查回应'], ['выключено осознанно', 'intentionally disabled', 'desactivado deliberadamente', '已主动关闭'], [' · можно повторить', ' · can be retried', ' · se puede reintentar', ' · 可以重试'], ['К разделам помощи', 'Help topics', 'Temas de ayuda', '帮助主题'],
  ['После создания черновика текст бота изменился. Откройте текущий текст и создайте новый черновик.', 'The bot text changed after this draft was created. Open the current text and create a new draft.', 'El texto del bot cambió después de crear este borrador. Abre el texto actual y crea otro borrador.', '创建草稿后机器人文本已更改。请打开当前文本并创建新草稿。'], ['После этого проверьте текст перед сохранением.', 'Review the text before saving.', 'Revisa el texto antes de guardarlo.', '保存前请检查文本。'], ['Настройка реакций занята. Повторите позже.', 'Reaction settings are busy. Try again later.', 'La configuración de reacciones está ocupada. Inténtalo más tarde.', '回应设置正忙，请稍后重试。'], ['Сначала завершите проверку реакций в обоих направлениях.', 'Complete the reaction check in both directions first.', 'Primero completa la comprobación de reacciones en ambas direcciones.', '请先完成两个方向的回应检查。'], ['При подключении проверьте оба направления в Telegram. После успешной проверки они включатся автоматически.', 'When connecting, check both directions in Telegram. They will turn on automatically after a successful check.', 'Al conectar, comprueba ambas direcciones en Telegram. Se activarán automáticamente cuando la comprobación finalice.', '连接时请在 Telegram 中检查两个方向。检查成功后将自动启用。'], ['Сервисный бот больше не подключён.', 'The service bot is no longer connected.', 'El bot del servicio ya no está conectado.', '服务机器人已断开连接。'], ['Изменения действуют на новые темы. Эмодзи заменяет цветную стандартную иконку.', 'Changes apply to new topics. The emoji replaces the standard colored icon.', 'Los cambios se aplican a temas nuevos. El emoji sustituye al icono de color estándar.', '更改适用于新话题。表情符号将替换标准彩色图标。'], ['\n\nON и OFF действуют один час, затем возвращается AUTO.', '\n\nON and OFF last one hour, then AUTO resumes.', '\n\nON y OFF duran una hora; después vuelve AUTO.', '\n\nON 和 OFF 持续一小时，然后恢复 AUTO。'], ['D1: до 50 запросов за запуск. Монитор: суточные квоты Free.', 'D1: up to 50 queries per run. Monitor: Free daily quotas.', 'D1: hasta 50 consultas por ejecución. Monitor: cuotas diarias de Free.', 'D1：每次运行最多 50 次查询。监控器：Free 每日配额。'], ['\n\nНастройка относится ко всем ботам и монитору. Тариф в Cloudflare меняется отдельно.', '\n\nThis setting applies to all bots and the monitor. Change the Cloudflare plan separately.', '\n\nEste ajuste se aplica a todos los bots y al monitor. El plan de Cloudflare se cambia por separado.', '\n\n此设置适用于所有机器人和监控器。Cloudflare 套餐需单独更改。'], ['Изменить день продления', 'Change renewal day', 'Cambiar día de renovación', '更改续订日期'], ['Использовать конфиг', 'Use config', 'Usar configuración', '使用配置'], ['Этот экран устарел. Откройте план заново.', 'This screen has expired. Reopen the plan.', 'Esta pantalla caducó. Vuelve a abrir el plan.', '此页面已过期，请重新打开套餐页面。'], ['Укажите день ежемесячного продления Workers Paid из Cloudflare Billing (UTC).', 'Enter the monthly Workers Paid renewal day from Cloudflare Billing (UTC).', 'Indica el día de renovación mensual de Workers Paid en Cloudflare Billing (UTC).', '请输入 Cloudflare Billing 中 Workers Paid 的每月续订日期（UTC）。'], ['\n\nЭта кнопка меняет настройки приложения, а не подписку Cloudflare.', '\n\nThis button changes app settings, not your Cloudflare subscription.', '\n\nEste botón cambia los ajustes de la aplicación, no la suscripción de Cloudflare.', '\n\n此按钮更改应用设置，不会更改 Cloudflare 订阅。'], ['План уже изменился. Откройте экран заново.', 'The plan changed. Reopen this screen.', 'El plan cambió. Vuelve a abrir esta pantalla.', '套餐已更改，请重新打开此页面。'], ['Настройки устарели. Откройте карточку сервиса заново.', 'These settings have expired. Reopen the service card.', 'Estos ajustes caducaron. Vuelve a abrir la ficha del servicio.', '设置已过期，请重新打开服务卡片。'], ['Сервис приостановлен. Настройки доступны только для просмотра.', 'The service is paused. Settings are read-only.', 'El servicio está pausado. Los ajustes son de solo lectura.', '服务已暂停，设置仅供查看。'], ['К настройкам', 'Back to settings', 'Volver a los ajustes', '返回设置'], ['Язык этого бота нельзя изменить через меню. Проверьте подключение сервиса.', 'This bot’s language cannot be changed from the menu. Check the service connection.', 'No se puede cambiar el idioma de este bot desde el menú. Comprueba la conexión del servicio.', '无法通过菜单更改此机器人的语言，请检查服务连接。'], ['Настройки уже изменились. Откройте экран заново.', 'The settings changed. Reopen this screen.', 'Los ajustes cambiaron. Vuelve a abrir esta pantalla.', '设置已更改，请重新打开页面。'], ['Сначала сохраните текст.', 'Save the text first.', 'Guarda primero el texto.', '请先保存文本。'], ['Сначала завершите проверку этого направления в Telegram.', 'Complete the check for this direction in Telegram first.', 'Completa primero la comprobación de esta dirección en Telegram.', '请先在 Telegram 中完成此方向的检查。'], ['Иконка уже недоступна. Откройте список заново.', 'This icon is no longer available. Reopen the list.', 'Este icono ya no está disponible. Vuelve a abrir la lista.', '此图标已不可用，请重新打开列表。'],
  ['Показаны первые 20. Уточните поиск по ID или username.', 'Showing the first 20. Refine the search by ID or username.', 'Se muestran los primeros 20. Concreta la búsqueda por ID o nombre de usuario.', '仅显示前 20 条。请使用 ID 或用户名缩小搜索范围。'], ['Карточка устарела.', 'This card has expired.', 'Esta ficha caducó.', '此卡片已过期。'], ['Тема ещё не создана', 'Topic not created yet', 'El tema aún no se ha creado', '话题尚未创建'],
  ['Приветствие', 'Welcome message', 'Mensaje de bienvenida', '欢迎语'], ['Автоответ на обращение', 'Conversation auto-reply', 'Respuesta automática de la conversación', '会话自动回复'], ['{value} · Приветствие', '{value} · Welcome message', '{value} · Mensaje de bienvenida', '{value} · 欢迎语'], ['{value} · Автоответ на обращение', '{value} · Conversation auto-reply', '{value} · Respuesta automática de la conversación', '{value} · 会话自动回复'], ['Отправка:', 'Delivery:', 'Envío:', '发送状态：'], ['Отправка: {value}', 'Delivery: {value}', 'Envío: {value}', '发送状态：{value}'],
  ['Цвет:', 'Color:', 'Color:', '颜色：'], ['Иконка:', 'Icon:', 'Icono:', '图标：'], ['стандартная', 'standard', 'estándar', '标准'], ['Пример: {value} {value} · Анна (42)', 'Example: {value} {value} · Anna (42)', 'Ejemplo: {value} {value} · Ana (42)', '示例：{value} {value} · Anna (42)'],
  ['Оформление новых тем · {value}', 'New topic style · {value}', 'Estilo de temas nuevos · {value}', '新话题样式 · {value}'], ['Оформление новых тем · {value} · только просмотр', 'New topic style · {value} · read-only', 'Estilo de temas nuevos · {value} · solo lectura', '新话题样式 · {value} · 只读'], ['Цвет новых тем · {value}', 'New topic color · {value}', 'Color de temas nuevos · {value}', '新话题颜色 · {value}'], ['Telegram разрешает ботам шесть цветов. Эмодзи-иконка отображается вместо цветной стандартной.', 'Telegram allows bots to use six colors. The emoji icon appears instead of the standard colored icon.', 'Telegram permite que los bots usen seis colores. El icono emoji aparece en lugar del icono de color estándar.', 'Telegram 允许机器人使用六种颜色。表情图标会替代标准彩色图标。'], ['Иконка новых тем · {value}', 'New topic icon · {value}', 'Icono de temas nuevos · {value}', '新话题图标 · {value}'], ['Выберите эмодзи из каталога Telegram.', 'Choose an emoji from the Telegram catalog.', 'Elige un emoji del catálogo de Telegram.', '从 Telegram 目录中选择表情符号。'],
  ['Антиспам: {value} · CAPTCHA: {value}', 'Anti-spam: {value} · CAPTCHA: {value}', 'Antispam: {value} · CAPTCHA: {value}', '反垃圾信息：{value} · CAPTCHA：{value}'], ['Пороги сообщений: {value}/10 с · {value}/мин · {value}/мин', 'Message thresholds: {value}/10 sec · {value}/min · {value}/min', 'Umbrales de mensajes: {value}/10 s · {value}/min · {value}/min', '消息阈值：{value}/10 秒 · {value}/分钟 · {value}/分钟'], ['Порог CAPTCHA: {value} · автомьюта: {value}', 'CAPTCHA threshold: {value} · auto-mute: {value}', 'Umbral de CAPTCHA: {value} · silencio automático: {value}', 'CAPTCHA 阈值：{value} · 自动禁言：{value}'], ['За последнюю минуту: новых пользователей {value}, ограничений частоты {value}, CAPTCHA {value}, автомьютов {value}', 'In the last minute: {value} new users, {value} rate limits, {value} CAPTCHA checks, {value} auto-mutes', 'En el último minuto: {value} usuarios nuevos, {value} límites de frecuencia, {value} verificaciones CAPTCHA, {value} silencios automáticos', '过去一分钟：{value} 位新用户，{value} 次频率限制，{value} 次 CAPTCHA，{value} 次自动禁言'],
  ['Антиспам:', 'Anti-spam:', 'Antispam:', '反垃圾信息：'], ['Режим:', 'Mode:', 'Modo:', '模式：'], ['Пороги сообщений:', 'Message thresholds:', 'Umbrales de mensajes:', '消息阈值：'], ['Порог CAPTCHA:', 'CAPTCHA threshold:', 'Umbral de CAPTCHA:', 'CAPTCHA 阈值：'], ['За последнюю минуту:', 'In the last minute:', 'En el último minuto:', '过去一分钟：'], ['новых пользователей', 'new users', 'usuarios nuevos', '新用户'], ['ограничений частоты', 'rate limits', 'límites de frecuencia', '频率限制'], ['автомьютов', 'auto-mutes', 'silencios automáticos', '自动禁言'], ['managed', 'managed', 'gestionado', '托管'], ['adaptive', 'adaptive', 'adaptativo', '自适应'], ['off', 'off', 'desactivado', '关闭'], ['on', 'on', 'activado', '开启'],
  ['ON и OFF действуют один час, затем возвращается AUTO.', 'ON and OFF last one hour, then AUTO resumes.', 'ON y OFF duran una hora; después vuelve AUTO.', 'ON 和 OFF 持续一小时，然后恢复 AUTO。'],
  ['Поиск: {value}', 'Search: {value}', 'Buscar: {value}', '搜索：{value}'], ['Найдено профилей: {value}. Выберите пользователя и сервис.', 'Profiles found: {value}. Choose a user and service.', 'Perfiles encontrados: {value}. Elige un usuario y servicio.', '找到资料：{value}。请选择用户和服务。'], ['все сервисы', 'all services', 'todos los servicios', '所有服务'], ['сервис приостановлен (только просмотр)', 'service paused (read-only)', 'servicio pausado (solo lectura)', '服务已暂停（只读）'],
  ['Реакции · {value} · только просмотр', 'Reactions · {value} · read-only', 'Reacciones · {value} · solo lectura', '回应 · {value} · 只读'], ['Реакции · {value}', 'Reactions · {value}', 'Reacciones · {value}', '回应 · {value}'], ['Защита сервиса · {value} · только просмотр', 'Service protection · {value} · read-only', 'Protección del servicio · {value} · solo lectura', '服务防护 · {value} · 只读'], ['Защита сервиса · {value}', 'Service protection · {value}', 'Protección del servicio · {value}', '服务防护 · {value}'],
  ['Настройки · {value} · только просмотр\n\nЯзык: {value}\nПриветствие: {value}\nАвтоответ: {value}\nРеакции: {value}\nОформление новых тем: {value}\nЗащита сервиса: {value}', 'Settings · {value} · read-only\n\nLanguage: {value}\nWelcome message: {value}\nAutomatic reply: {value}\nReactions: {value}\nNew topic style: {value}\nService protection: {value}', 'Configuración · {value} · solo lectura\n\nIdioma: {value}\nMensaje de bienvenida: {value}\nRespuesta automática: {value}\nReacciones: {value}\nEstilo de temas nuevos: {value}\nProtección del servicio: {value}', '设置 · {value} · 只读\n\n语言：{value}\n欢迎语：{value}\n自动回复：{value}\n回应：{value}\n新话题样式：{value}\n服务防护：{value}'],
  ['{value} · сообщения · только просмотр', '{value} · messages · read-only', '{value} · mensajes · solo lectura', '{value} · 消息 · 只读'], ['{value} · сообщения\n\nТексты и переключатели сохранены отдельно для этого бота.', '{value} · messages\n\nTexts and toggles are stored separately for this bot.', '{value} · mensajes\n\nLos textos y ajustes se guardan por separado para este bot.', '{value} · 消息\n\n文本和开关分别保存在此机器人中。'], ['Тексты и переключатели сохранены отдельно для этого бота.', 'Texts and toggles are stored separately for this bot.', 'Los textos y ajustes se guardan por separado para este bot.', '文本和开关分别保存在此机器人中。'],
  ['Приветствие: {value}', 'Welcome message: {value}', 'Mensaje de bienvenida: {value}', '欢迎语：{value}'], ['Автоответ: {value}', 'Auto-reply: {value}', 'Respuesta automática: {value}', '自动回复：{value}'], ['Реакции: {value}', 'Reactions: {value}', 'Reacciones: {value}', '回应：{value}'], ['Оформление новых тем: {value}', 'New topic style: {value}', 'Estilo de temas nuevos: {value}', '新话题样式：{value}'],
  ['☁️ Cloudflare · {value}', '☁️ Cloudflare · {value}', '☁️ Cloudflare · {value}', '☁️ Cloudflare · {value}'], ['Источник: RECOVERY_D1_PLAN', 'Source: RECOVERY_D1_PLAN', 'Origen: RECOVERY_D1_PLAN', '来源：RECOVERY_D1_PLAN'], ['Источник: настройка приложения', 'Source: app setting', 'Origen: ajuste de la aplicación', '来源：应用设置'], ['D1: до 1000 запросов за запуск. Монитор: месяц от дня продления ({value}).', 'D1: up to 1,000 queries per run. Monitor: monthly from the renewal day ({value}).', 'D1: hasta 1.000 consultas por ejecución. Monitor: mensual desde el día de renovación ({value}).', 'D1：每次运行最多 1,000 次查询。监控器：从续订日起按月计算（{value}）。'], ['не задан', 'not set', 'sin definir', '未设置'], ['Настройка относится ко всем ботам и монитору. Тариф в Cloudflare меняется отдельно.', 'This setting applies to all bots and the monitor. Change the Cloudflare plan separately.', 'Este ajuste se aplica a todos los bots y al monitor. El plan de Cloudflare se cambia por separado.', '此设置适用于所有机器人和监控器。Cloudflare 套餐需单独更改。'], ['Настройка относится ко всем ботам и монитору. Тариф в Cloudflare меняется отдельно.', 'This setting applies to all bots and the monitor. Change the Cloudflare plan separately.', 'Este ajuste se aplica a todos los bots y al monitor. El plan de Cloudflare se cambia por separado.', '此设置适用于所有机器人和监控器。Cloudflare 套餐需单独更改。'],
];

for (const [source, en, es, zh] of [...managerCatalog, ...managerCatalogSupplement, ...MANAGER_USER_COPY, ...MANAGER_DIAGNOSTICS_COPY, ...MANAGER_LIFECYCLE_COPY]) {
  translations.en[source] = en;
  translations.es[source] = es;
  translations.zh[source] = zh;
}
translations.en['Язык сервиса изменён: English'] = 'Service language changed: English';
translations.en['Язык сервиса изменён: Русский'] = 'Service language changed: Russian';
translations.en['Язык сервиса изменён: Español'] = 'Service language changed: Spanish';
translations.en['Язык сервиса изменён: 简体中文'] = 'Service language changed: Chinese (Simplified)';
translations.es['Язык сервиса изменён: English'] = 'Idioma del servicio cambiado: inglés';
translations.es['Язык сервиса изменён: Русский'] = 'Idioma del servicio cambiado: ruso';
translations.es['Язык сервиса изменён: Español'] = 'Idioma del servicio cambiado: español';
translations.es['Язык сервиса изменён: 简体中文'] = 'Idioma del servicio cambiado: chino simplificado';
translations.zh['Язык сервиса изменён: English'] = '服务语言已更改：英语';
translations.zh['Язык сервиса изменён: Русский'] = '服务语言已更改：俄语';
translations.zh['Язык сервиса изменён: Español'] = '服务语言已更改：西班牙语';
translations.zh['Язык сервиса изменён: 简体中文'] = '服务语言已更改：简体中文';
translations.en['… [показаны первые 1200 из {value} символов]'] = '… [first 1200 of {value} characters shown]';
translations.es['… [показаны первые 1200 из {value} символов]'] = '… [se muestran los primeros 1200 de {value} caracteres]';
translations.zh['… [показаны первые 1200 из {value} символов]'] = '… [仅显示前 1200 个字符，共 {value} 个]';
export const MANAGER_TRANSLATIONS = translations;
const templatesByLocale = Object.fromEntries(Object.entries(translations).map(([locale, dictionary]) => [locale,
  Object.entries(dictionary).filter(([source]) => source.includes('{value}'))
    // A longer placeholder is not more specific than a fixed status label.
    .sort((a, b) => b[0].replaceAll('{value}', '').length - a[0].replaceAll('{value}', '').length)]));

export function translateManager(locale, text, { preserve = [] } = {}) {
  if (typeof text !== 'string') return text;
  const saved = [];
  text = text.replace(/\uE100("(?:\\.|[^"\\])*")\uE101/gu, (_match, encoded) => {
    const token = `\uE000opaque${saved.length}\uE001`;
    saved.push([token, JSON.parse(encoded)]);
    return token;
  });
  for (const [index, value] of preserve.entries()) {
    if (typeof value !== 'string' || !value) continue;
    const token = `\uE000${index}\uE001`;
    if (text.includes(value)) {
      text = text.replaceAll(value, token);
      saved.push([token, value]);
    }
  }
  if (locale === 'ru') return restore(text, saved);
  const dictionary = translations[locale] || translations.en;
  const exact = dictionary[text];
  if (exact) return restore(exact, saved);

  // Catalog templates translate UI scaffolding while preserving captured values
  // such as names, notes, service text, usernames, and IDs verbatim.
  const templates = templatesByLocale[locale] || templatesByLocale.en;
  const structured = matchTemplate(locale, text, templates);
  const structuralPrefixes = ['Настройки · ', 'Статус доставки сообщения #', 'Копирование:', 'Скопировать сообщения',
    'Язык сервиса · ', 'Проверьте текст для ', 'Отправьте новый текст ', 'Поиск: '];
  const safeDynamicStructures = new Set([
    '{value} · сообщения\n\nТексты и переключатели сохранены отдельно для этого бота.',
    'Реакции всех сервисов · страница {value}/{value}',
    'Здоровье системы · {value}',
    'История пользователя {value} · {value} · страница {value}',
    'Поиск: {value}\nНайдено профилей: {value}. Выберите пользователя и сервис.',
  ]);
  if (structured && (structuralPrefixes.some(prefix => text.startsWith(prefix)) || safeDynamicStructures.has(structured.source)))
    return restore(structured.text, saved);
  if (text.includes(' · команда · ')) {
    const localized = text.split('\n').map(line => {
      if (!line.includes(' · команда · ')) return translateLine(locale, line, dictionary, templates);
      const parts = line.split(' · ');
      const actorAction = parts[2] || '';
      const separator = actorAction.lastIndexOf(' — ');
      if (parts.length < 4 || separator < 0) return line;
      const action = actorAction.slice(separator + 3);
      parts[1] = dictionary['команда'] || 'команда';
      parts[2] = `${actorAction.slice(0, separator)} — ${dictionary[action] || action}`;
      return parts.join(' · ');
    }).join('\n');
    return restore(localized, saved);
  }
  // Line-level translation keeps operator-entered text intact. A line is
  // translated only when the full line is catalogued or is a catalogued label
  // followed by its dynamic value.
  return restore(text.split('\n').map(line => translateLine(locale, line, dictionary, templates)).join('\n'), saved);
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function restore(text, saved) {
  const values = new Map(saved);
  return text.replace(/\uE000(?:opaque)?\d+\uE001/gu, token => values.get(token) ?? token);
}
function applyTemplate(locale, text, templates) {
  return matchTemplate(locale, text, templates)?.text ?? null;
}
function matchTemplate(locale, text, templates) {
  for (const [source, target] of templates) {
    const pieces = source.split('{value}');
    const capture = source.includes('\n') ? '([\\s\\S]*?)' : '([^\\n]*?)';
    const match = new RegExp(`^${pieces.map(escapeRegExp).join(capture)}$`).exec(text);
    if (!match) continue;
    let index = 1;
    const result = target.replaceAll('{value}', () => templateCapture(locale, source, index, match[index++]));
    return { source, text: result };
  }
  return null;
}
function translateLine(locale, line, dictionary, templates) {
  if (dictionary[line]) return dictionary[line];
  const structured = applyTemplate(locale, line, templates);
  if (structured !== null) return structured;
  // Audit rows contain operator names and IDs, but the event action is a
  // system label. Translate only that known field and the synthetic team label.
  if (line.includes(' · команда · ')) {
    const parts = line.split(' · ');
    const actorAction = parts[2] || '';
    const separator = actorAction.lastIndexOf(' — ');
    if (parts.length >= 4 && separator >= 0) {
      const action = actorAction.slice(separator + 3);
      parts[1] = dictionary['команда'] || 'команда';
      parts[2] = `${actorAction.slice(0, separator)} — ${dictionary[action] || action}`;
      return parts.join(' · ');
    }
  }
  // Service-scoped audit rows have the same action field but a bot ID where
  // the synthetic all-services row says "команда". Translate only known event
  // actions; actor names, reasons, IDs, and result values remain untouched.
  const emDash = line.indexOf(' — ');
  if (emDash >= 0) {
    const suffix = line.slice(emDash + 3);
    const end = suffix.indexOf(' · ');
    const action = end < 0 ? suffix : suffix.slice(0, end);
    if (dictionary[action]) {
      let localized = line.slice(0, emDash + 3) + dictionary[action] + suffix.slice(action.length);
      localized = localized.replace(/ · (\d+) мин(?= ·|$)/u, (_, minutes) => ` · ${minutes} ${locale === 'zh' ? '分钟' : 'min'}`);
      return localized;
    }
  }
  // These populated diagnostic and profile rows have fixed UI labels on both
  // sides of the separator. Keep all other dot-separated values opaque.
  const directionAt = line.indexOf(' · ');
  if (directionAt > 0) {
    const direction = line.slice(0, directionAt), reason = line.slice(directionAt + 3);
    if (dictionary[direction] && dictionary[reason]) return `${dictionary[direction]} · ${dictionary[reason]}`;
  }
  const riskRow = /^Риск сейчас: (\d+) · CAPTCHA: (.+)$/u.exec(line);
  if (riskRow && dictionary[riskRow[2]]) return `${dictionary['Риск сейчас:'] || 'Риск сейчас:'} ${riskRow[1]} · ${dictionary['CAPTCHA:'] || 'CAPTCHA:'} ${dictionary[riskRow[2]]}`;
  const pendingRow = /^Ожидающих сообщений: (\d+) · ожидающих возобновления: (\d+)$/u.exec(line);
  if (pendingRow) return `${dictionary['Ожидающих сообщений:'] || 'Ожидающих сообщений:'} ${pendingRow[1]} · ${dictionary['ожидающих возобновления:'] || 'ожидающих возобновления:'} ${pendingRow[2]}`;
  for (const [source, target] of Object.entries(dictionary))
    if (source.endsWith(':') && line.startsWith(source)) {
      const suffix = line.slice(source.length);
      const statusFields = new Set(['Состояние:', 'Обращение:', 'Доступ к переписке:', 'Доверие:', 'Реакции:', 'Приветствие:', 'Автоответ:', 'Защита сервиса:', 'Режим:', 'Тема:', 'CAPTCHA:', 'Подтвердите действие:', 'Цвет:', 'Иконка:', 'Отправка:']);
      if (statusFields.has(source)) {
        const trimmed = suffix.trim();
        if (dictionary[trimmed]) return target + suffix.replace(trimmed, dictionary[trimmed]);
        const until = /^(ограничен|автоограничение) до (.+)$/u.exec(trimmed);
        if (until && dictionary[until[1]]) return `${target} ${dictionary[until[1]]} ${locale === 'zh' ? '至' : locale === 'es' ? 'hasta' : 'until'} ${until[2]}`;
      }
      if (source === 'Срок:') {
        const minutes = /^(\s*)(\d+) мин$/u.exec(suffix);
        if (minutes) return `${target}${minutes[1]}${minutes[2]} ${locale === 'zh' ? '分钟' : 'min'}`;
      }
      return target + suffix;
    }
  const template = applyTemplate(locale, line, templates);
  if (template !== null) return template;
  return line;
}
const scalarLabels = new Set(['готово','done','включено','включена','включены','включён','выключено','выключена','выключены','выключен','не настроено','не задано','ещё не проверены','по умолчанию','открыто','закрыто','открыта','закрыта','не подключена','не подключен','не подтверждено','не подтверждён','не подтверждена','подтверждён','подтверждена','подтверждено','не проводилась','не проводился','не проводилось','включено осознанно','ожидает','нет темы','тема ещё не создана','ожидает проверку','обычный','заблокирован','ограничен','доверенный','подозрительный','ручное','нет','пользователь заблокирован','ручное ограничение','автоограничение','бот выключен','не назначен','ожидает CAPTCHA','проверено','не проверено','право подтверждено','нет подтверждения','завершён','не подключена']);
function templateCapture(locale, source, index, value) {
  // These headers use a synthetic scope when no service is selected. Authored
  // service names are opaque tokens and must never be translated here.
  if (['Пользователи · {value}', '🚫 Заблокированные · {value}', '⏳ Ограниченные · {value}',
    '🧩 На проверке · {value}', '⚠️ Подозрительные · {value}', '✅ Доверенные · {value}',
    '🕘 Недавние · {value}'].includes(source) && value === 'все сервисы')
    return translations[locale]?.[value] || value;
  if (source === 'Поиск: {value}\nНайдено профилей: {value}. Выберите пользователя и сервис.' && index === 1) return value;
  if (source === '  без username · {value} · обращение: {value}' && index >= 1)
    return translateKnownStatus(locale, value);
  if (source === '  {value} · {value} · обращение: {value}' && index >= 2)
    return translateKnownStatus(locale, value);
  if (source === '  {value} · {value} · обращение: {value}' && index === 1) return value;
  if (source === 'Отправка: {value}' && index === 1) return translateKnownStatus(locale, value);
  if (source === 'Антиспам: {value} · CAPTCHA: {value}') {
    if (index === 1) return translateKnownStatus(locale, value);
    if (index === 2) return translations[locale]?.[value] || value;
  }
  if (source === 'Пример: {value} {value} · Анна (42)' && index <= 2) return value;
  // Captures are operator or service data by default. Only translate known
  // status slots in the fixed service-summary template.
  if (source.startsWith('Настройки · {value}') && source.includes('\n\nЯзык:') && index >= 2 && index <= 7
    && scalarLabels.has(value)) return translations[locale]?.[value] || value;
  if (source === 'Статус доставки сообщения #{value}\n{value}' && index === 2)
    return value.split('\n').map(line => translations[locale]?.[line] || line).join('\n');
  if (source.startsWith('Тема: {value} · группа') && index === 1)
    return translateKnownStatus(locale, value);
  if ((source.startsWith('Поддержка → пользователь: {value}') || source.startsWith('Пользователь → поддержка: {value}'))
    && translations[locale]?.[value]) return translations[locale][value];
  if (source.trimStart().startsWith('группа ') && source.includes('проверка: {value}')) {
    const menuIndex = source.includes('меню {value}') ? 2 : -1;
    const checkIndex = source.includes('не подключена') ? 1 : source.includes('меню {value}') ? 3 : 2;
    if (index === menuIndex || index === checkIndex) return translateKnownStatus(locale, value);
  }
  return value;
}
function translateKnownStatus(locale, value) {
  const limited = /^(автоограничение|ограничен) до (.+)$/u.exec(value);
  if (limited && translations[locale]?.[`${limited[1]} до`]) {
    const prefix = translations[locale][`${limited[1]} до`];
    return `${prefix} ${limited[2]}`;
  }
  const limitPrefix = /^(автоограничение|ограничен) до/u.exec(value);
  if (limitPrefix) {
    const date = value.slice(limitPrefix[0].length).trim();
    const prefix = translations[locale]?.[`${limitPrefix[1]} до`] || limitPrefix[1];
    return `${prefix} ${date}`;
  }
  if (!scalarLabels.has(value)) return value;
  return translations[locale]?.[value] || value;
}

export function translateManagerScreen(locale, text, markup) {
  const localize = value => translateManager(locale, value);
  const localizedMarkup = Array.isArray(markup)
    ? markup.map(row => row.map(item => ({ ...item, text: localize(item.text) })))
    : markup?.inline_keyboard ? { ...markup, inline_keyboard: markup.inline_keyboard.map(row => row.map(item => ({
      ...item, text: localize(item.text),
    })))} : markup;
  return { text: localize(text), markup: localizedMarkup };
}
