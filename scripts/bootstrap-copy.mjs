// Russian source phrases are stable UI keys. Numbered values remain opaque.
export const BOOTSTRAP_COPY = [
  ['Не найден npm/bin/npx-cli.js. Установите Node.js вместе с npm.', 'npm/bin/npx-cli.js was not found. Install Node.js with npm.'],
  ['Не удалось запустить {0}. Проверьте установку программы.', 'Could not start {0}. Check that the program is installed.'],
  ['Команда завершилась с кодом {0}. Текущий шаг сохранён; проверьте доступ к сервису и повторите показанную команду установки.', 'The command exited with code {0}. Progress has been saved; check service access and retry the installation command shown below.'],
  ['Значение не подходит. Исправьте ввод или нажмите Ctrl+C, чтобы выйти.', 'Invalid value. Correct your input or press Ctrl+C to exit.'],
  ['Номер варианта', 'Option number'], ['Выберите номер из списка.', 'Choose a number from the list.'],
  ['{0}: Wrangler вернул некорректный JSON.', '{0}: Wrangler returned invalid JSON.'],
  ['Telegram не вернул корректный username управляющего бота.', 'Telegram did not return a valid manager bot username.'],
  ['У управляющего бота уже есть webhook. Используйте нового бота для новой установки.', 'The manager bot already has a webhook. Use a new bot for a new installation.'],
  ['Управляющий бот: @{0}. Добавьте его администратором группы с темами, затем отправьте от своего аккаунта /setup@{1} в General.', 'Manager bot: @{0}. Add it as an administrator to a group with topics, then send /setup@{1} in General from your own account.'],
  ['После отправки нажмите Enter', 'Press Enter after sending the command'],
  ['Telegram не вернул список обновлений.', 'Telegram did not return a list of updates.'],
  ['Сообщение пока не найдено. Отправьте указанную команду в General от своего аккаунта (без анонимного режима администратора).', 'The message was not found yet. Send the command in General from your own account, with anonymous administrator mode disabled.'],
  ['Очередь нового бота заполнена. Обновления сохранены; для установки используйте нового свободного бота.', 'The new bot’s update queue is full. Updates have been preserved; use another unused bot for this installation.'],
  ['Выдайте Админушке права администратора на управление темами и закрепление сообщений.', 'Give the manager bot administrator permissions to manage topics and pin messages.'],
  ['Группа: {0} ({1}); администратор: {2}.', 'Group: {0} ({1}); administrator: {2}.'],
  ['Это верная группа и ваш аккаунт?', 'Are this group and your account correct?'],
  ['Да, продолжить', 'Yes, continue'], ['Нет, отправлю команду заново', 'No, I will send the command again'],
  ['Список D1', 'D1 database list'], ['Список deploy {0}', 'Deployments for {0}'],
  ['Неожиданный ответ о Worker {0}.', 'Unexpected response for Worker {0}.'],
  ['D1 {0} с UUID из состояния отсутствует. Не создаём замену автоматически.', 'D1 {0} with the saved UUID is missing. A replacement will not be created automatically.'],
  ['D1 {0} уже существует. Мастер не присоединяет чужую базу.', 'D1 {0} already exists. The wizard will not adopt a database from another installation.'],
  ['Создаю пустую D1 {0}…', 'Creating empty D1 database {0}…'],
  ['Не удалось создать D1 {0}. Проверьте Cloudflare и повторите запуск.', 'Could not create D1 {0}. Check Cloudflare and retry.'],
  ['D1 {0} не появилась с корректным UUID.', 'D1 {0} did not appear with a valid UUID.'],
  ['Конфигурация {0} изменена вручную или создана старым мастером. Автоматическая перезапись остановлена; сохраните файл для сверки.', 'Configuration {0} was edited manually or created by an older wizard. Automatic overwrite has stopped; preserve the file for comparison.'],
  ['Список секретов', 'Secret list'], ['Wrangler вернул неожиданный список секретов.', 'Wrangler returned an unexpected secret list.'],
  ['Нужно значение для секрета {0}.', 'A value is required for secret {0}.'],
  ['Секрет {0} не появился после записи.', 'Secret {0} did not appear after it was written.'],
  ['{0} уже есть в Cloudflare, но его зашифрованная копия отсутствует. Восстановите резервную копию; ключ не заменён.', '{0} already exists in Cloudflare, but its encrypted backup is missing. Restore the backup; the key has not been replaced.'],
  ['Мастер первого запуска работает в обычном окне PowerShell на Windows.', 'Run the first-run wizard in a regular PowerShell window on Windows.'],
  ['Обновите Node.js до 22.13 или новее и повторите npm run setup.', 'Update Node.js to 22.13 or later, then run npm run setup again.'],
  ['Freeflare Desk — установка\nПонадобятся новая Админушка, группа с темами и ключи Cloudflare.\nCtrl+C прерывает работу; созданные ресурсы сохраняются для продолжения.', 'Freeflare Desk — setup\nYou will need a new manager bot, a group with topics, and Cloudflare credentials.\nCtrl+C stops the wizard; created resources are preserved so you can resume.'],
  ['Нашёл сохранённые установки:', 'Saved installations:'], ['Открыть {0}', 'Open {0}'],
  ['Создать новую установку', 'Create a new installation'],
  ['Для --status-bot выберите существующую установку.', 'Select an existing installation for --status-bot.'],
  ['Имя новой установки (латиница, цифры, дефис)', 'New installation name (lowercase Latin letters, digits, hyphens)'],
  ['Состояние установки', 'Installation state'],
  ['Сначала завершите основную установку без --status-bot.', 'Complete the main installation without --status-bot first.'],
  ['Установка: {0}. Для повторного запуска: {1}', 'Installation: {0}. To resume: {1}'],
  ['Этот мастер создаёт отдельные Worker и D1. Работающую установку он не обновляет.', 'This wizard creates separate Workers and D1 databases. It does not update an existing live installation.'],
  ['Проверка Cloudflare', 'Cloudflare access check'], ['Войдите в Cloudflare в открывшемся браузере.', 'Sign in to Cloudflare in the browser window that opens.'],
  ['Проверка входа', 'Sign-in check'], ['Вход не завершён. Повторите npm run setup.', 'Sign-in was not completed. Run npm run setup again.'],
  ['Wrangler не показал доступных Cloudflare аккаунтов. Проверьте права входа.', 'Wrangler did not list any accessible Cloudflare accounts. Check your account permissions.'],
  ['Выберите аккаунт Cloudflare:', 'Choose a Cloudflare account:'], ['Без названия', 'Unnamed'],
  ['Аккаунт Cloudflare: {0}', 'Cloudflare account: {0}'],
  ['Токен новой Админушки из BotFather (ввод скрыт): ', 'New manager bot token from BotFather (input hidden): '],
  ['Проверка авторизации', 'Authorization check'],
  ['Не удалось определить workers.dev. Найдите или создайте его: https://dash.cloudflare.com/{0}/workers-and-pages', 'Could not discover your workers.dev subdomain. Find or create it here: https://dash.cloudflare.com/{0}/workers-and-pages'],
  ['Полный будущий адрес https://{0}.ВАШ_СУБДОМЕН.workers.dev', 'Full planned address https://{0}.YOUR_SUBDOMAIN.workers.dev'],
  ['Адрес вашей установки: {0}', 'Your installation URL: {0}'],
  ['Создайте Turnstile → Managed для hostname {0}: https://dash.cloudflare.com/{1}/turnstile', 'Create a Managed Turnstile widget for hostname {0}: https://dash.cloudflare.com/{1}/turnstile'],
  ['Публичный Turnstile site key для этого hostname', 'Public Turnstile site key for this hostname'],
  ['Часовой пояс для алертов', 'Time zone for alerts'], ['Язык алертов:', 'Language for alerts:'],
  ['D1 {0} уже есть. Выберите новое имя установки.', 'D1 {0} already exists. Choose a new installation name.'],
  ['Worker {0} уже существует. Выберите другое имя установки.', 'Worker {0} already exists. Choose a different installation name.'],
  ['Будут созданы две БД: {0}, {1}; два Worker: {2}, {3}.\nГруппа: {4}; Админушка: @{5}; время: {6}.', 'Two databases will be created: {0}, {1}; two Workers: {2}, {3}.\nGroup: {4}; manager bot: @{5}; time zone: {6}.'],
  ['Для создания ресурсов напишите СОЗДАТЬ', 'Type CREATE to create these resources'], ['СОЗДАТЬ', 'CREATE'],
  ['Установка отменена до изменений в Cloudflare.', 'Installation cancelled before any changes to Cloudflare.'],
  ['Текущий Wrangler вошёл в другой Cloudflare аккаунт.', 'Wrangler is signed in to a different Cloudflare account.'],
  ['Продолжаю ранее начатую установку по локальному файлу состояния.', 'Resuming the installation from its local state file.'],
  ['Подключить статус /status в алерт-боте на Telegram Serverless?', 'Connect /status in the alert bot using Telegram Serverless?'],
  ['Позже — завершить установку', 'Later — finish setup'], ['Подключить сейчас', 'Connect now'],
  ['Позже: node scripts/bootstrap.mjs {0} --status-bot', 'Connect later: node scripts/bootstrap.mjs {0} --status-bot'],
  ['Основная установка уже завершена: {0}. Сервисы добавляются через Админушку.', 'The main installation is already complete: {0}. Add services through the manager bot.'],
  ['Токен @{0} для продолжения (ввод скрыт): ', 'Token for @{0} to resume setup (input hidden): '],
  ['Токен принадлежит другой Админушке.', 'The token belongs to a different manager bot.'],
  ['Админушка уже подключена к другому адресу. Её настройки сохранены.', 'The manager bot is already connected to a different URL. Its settings have been preserved.'],
  ['Worker {0} уже существует в аккаунте. Мастер не перезапишет его.', 'Worker {0} already exists in this account. The wizard will not overwrite it.'],
  ['Токен Админушки не появился в Cloudflare.', 'The manager bot token did not appear in Cloudflare.'],
  ['Turnstile secret key (ввод скрыт): ', 'Turnstile secret key (input hidden): '],
  ['Создайте API token с правами аналитики по инструкции monitor/README.md: https://dash.cloudflare.com/profile/api-tokens', 'Create an API token with analytics permissions as described in monitor/README.md: https://dash.cloudflare.com/profile/api-tokens'],
  ['Cloudflare API token для аналитики монитора (ввод скрыт): ', 'Cloudflare API token for monitor analytics (input hidden): '],
  ['✓ Основной Worker, монитор и чтение обеих БД проверены.', '✓ The main Worker, monitor, and reads from both databases have been checked.'],
  ['Токен Админушки для webhook (ввод скрыт): ', 'Manager bot token for the webhook (input hidden): '],
  ['Токен Админушки для финальной проверки webhook (ввод скрыт): ', 'Manager bot token for the final webhook check (input hidden): '],
  ['Финальная проверка токена Админушки не прошла.', 'The final manager bot token check failed.'],
  ['Финальная проверка webhook Админушки не прошла.', 'The final manager bot webhook check failed.'],
  ['Один из Worker не найден после публикации. Проверьте Cloudflare и повторите запуск.', 'A Worker was not found after deployment. Check Cloudflare and retry setup.'],
  ['\nГотово: две D1, оба Worker, секреты и webhook Админушки @{0}.', '\nSetup complete: two D1 databases, both Workers, secrets, and the manager bot webhook for @{0}.'],
  ['Публичный адрес: {0}.', 'Public URL: {0}.'],
  ['Откройте личку Админушки и отправьте /start. Ответ подтвердит живую доставку webhook.', 'Open the manager bot in a private chat and send /start. Its response will confirm live webhook delivery.'],
  ['Затем через «Управление ботами поддержки → Добавить сервисного бота» подключите первый сервис.', 'Then connect your first service through Support bots → Add service bot.'],
  ['Алерт-бот подключается отдельно через меню «Алерты». Контрольный обмен с клиентом остаётся на проверке в меню Админушки.', 'Connect the alert bot separately through Alerts. Complete the test exchange with a customer using the checks in the manager bot menu.'],
  ['Файлы этой установки: {0}, {1}; зашифрованные резервные копии: {2}.', 'Installation files: {0}, {1}; encrypted backups: {2}.'],
  ['Установка остановлена. Повторите запуск после устранения проблемы.', 'Setup stopped. Fix the problem and run the wizard again.'],
  ['Продолжить: {0}', 'Resume: {0}'],
  ['Telegram не подтвердил идентификатор алерт-бота. Публикация остановлена.', 'Telegram did not confirm the alert bot’s identity. Deployment has stopped.'],
  ['Telegram CLI не подтвердил webhook. Подключение остановлено.', 'Telegram CLI did not confirm the webhook. Setup has stopped.'],
  ['У бота другой webhook или webhook не подключён. Текущий адрес сохранён; проверьте выбранного бота.', 'The bot has a different webhook or no active webhook. The current URL has been preserved; check the selected bot.'],
  ['Не удалось подготовить права доступа новой установки.', 'Could not prepare access permissions for the new installation.'],
  ['Файл статуса {0} изменён вручную. Сохраните изменения перед повторной настройкой.', 'Status file {0} was edited manually. Preserve your changes before configuring it again.'],
  ['Это Админушка. Войдите через CLI Access отдельного алерт-бота.', 'This is the manager bot. Sign in using CLI Access for a separate alert bot.'],
  ['CLI вошёл в другого алерт-бота. Верните доступ к боту этой установки.', 'The CLI is signed in to a different alert bot. Restore access to this installation’s bot.'],
  ['Не удалось проверить модули Telegram. Публикация остановлена.', 'Could not inspect Telegram modules. Deployment has stopped.'],
  ['В Serverless этого бота уже есть программа. Мастер подключает пустое приложение либо продолжает собственную установку.', 'This bot’s Serverless app already contains a program. The wizard supports empty apps or resumes its own installation.'],
  ['\nСтатус алерт-бота — Telegram Serverless\nВ @{0} откройте «Алерты» и подключите отдельного алерт-бота.\nВ BotFather включите Serverless для этого же алерт-бота и откройте CLI Access.\nИсходящие алерты идут из Cloudflare; /status работает в личке и выбранной группе. Проверки по расписанию здесь нет.', '\nAlert bot status — Telegram Serverless\nOpen Alerts in @{0} and connect a separate alert bot.\nIn BotFather, enable Serverless for that same alert bot and open CLI Access.\nCloudflare sends outgoing alerts; /status works in private chats and the selected group. This part has no scheduled checks.'],
  ['Когда алерт-бот подключён и CLI Access готов, нажмите Enter', 'Press Enter when the alert bot is connected and CLI Access is ready'],
  ['Файл bootstrapIdentity.js уже существует и отличается от проверки мастера. Сохраните его перед продолжением.', 'bootstrapIdentity.js already exists and differs from the wizard’s identity check. Preserve it before continuing.'],
  ['Вставьте CLI Access token алерт-бота в запрос Telegram CLI.', 'Paste the alert bot’s CLI Access token into the Telegram CLI prompt.'],
  ['Подключить статус @{0} к {1}? Доступ: пользователь {2}, группа {3}.', 'Connect status for @{0} to {1}? Access: user {2}, group {3}.'],
  ['Да, это мой алерт-бот', 'Yes, this is my alert bot'], ['Отмена', 'Cancel'],
  ['Telegram не подтвердил настройку. Сохранённые ключи оставлены для повторной попытки.', 'Telegram did not confirm the configuration. Saved keys have been preserved for a retry.'],
  ['Статус пока не получил ответ Cloudflare. Проверьте монитор и повторите --status-bot; ключи сохраняются.', 'Status has not received a response from Cloudflare yet. Check the monitor and retry --status-bot; keys are preserved.'],
  ['Статус подключён. В личке @{0} или группе отправьте /status@{1}.\nПроект Telegram этой установки: {2}', 'Status connected. Send /status@{1} in a private chat with @{0} or in the group.\nTelegram project for this installation: {2}'],
  ['Монитор отвечает, но пока сообщает неполные проверки или проблемы. Подробности — в /status; первая проверка Cron новой установки ещё могла не пройти.', 'The monitor responds, but reports incomplete checks or problems. See /status for details; the new installation’s first Cron check may not have run yet.'],
  ['Адрес должен иметь вид https://{0}.ВАШ_СУБДОМЕН.workers.dev', 'Use an address in the form https://{0}.YOUR_SUBDOMAIN.workers.dev'],
  ['Укажите часовой пояс, например Europe/Budapest или UTC.', 'Enter a time zone such as Europe/Budapest or UTC.'],
  ['Файл состояния установки повреждён или относится к другой папке. Восстановите его из резервной копии.', 'The installation state file is damaged or belongs to a different folder. Restore it from a backup.'],
  ['Использование: node scripts/bootstrap.mjs [имя] [--status-bot]. Справка: --help.', 'Usage: node scripts/bootstrap.mjs [name] [--status-bot]. Help: --help.'],
  ['Имя установки: 6–40 строчных латинских букв, цифр и дефисов; начните с буквы.', 'Installation name: 6–40 lowercase Latin letters, digits, and hyphens; start with a letter.'],
  ['Нет параметра {0} в шаблоне конфигурации.', 'Configuration template is missing parameter {0}.'],
  ['Не найдена D1 binding {0} в шаблоне.', 'D1 binding {0} was not found in the template.'],
  ['Не найдены имена Worker в шаблонах.', 'Worker names were not found in the templates.'],
  ['Не найдены все пять rate limit namespaces.', 'Not all five rate limit namespaces were found.'],
  ['Не найдены три monitor service bindings.', 'The three monitor service bindings were not found.'],
  ['Wrangler вернул неожиданный список D1.', 'Wrangler returned an unexpected D1 database list.'],
  ['D1 {0}: найден конфликт имени или UUID; установка остановлена.', 'D1 {0}: name or UUID conflict; setup has stopped.'],
  ['D1 {0} уже существует без записи UUID в состоянии установки; ручная проверка обязательна.', 'D1 {0} already exists without a UUID in the saved installation state; manual inspection is required.'],
  ['Worker не ответил по PUBLIC_BASE_URL. Сверьте адрес с URL, показанным Wrangler после deploy.', 'The Worker did not respond at PUBLIC_BASE_URL. Compare it with the URL shown by Wrangler after deployment.'],
  ['Webhook-адрес или секрет Worker не совпадают с установкой. Telegram пока не подключён.', 'The Worker webhook URL or secret does not match this installation. Telegram has not been connected yet.'],
  ['Монитор не подтвердил защищённый статус. Проверьте его адрес, STATUS_READ_TOKEN и версию кода, затем продолжите установку.', 'The monitor did not confirm its protected status. Check its URL, STATUS_READ_TOKEN, and code version, then resume setup.'],
  ['Проверка монитора не подтвердила чтение обеих БД и связь с основным Worker. Повторите установку после восстановления доступа.', 'The monitor check did not confirm reads from both databases and the connection to the main Worker. Retry setup after access is restored.'],
  ['Запусти команду в обычном окне PowerShell, без перенаправления ввода или вывода.', 'Run the command in a regular PowerShell window without redirecting input or output.'],
  ['Проверка отменена.', 'Check cancelled.'],
  ['{0}: Telegram не ответил за 15 секунд. Проверь доступ к api.telegram.org с этого компьютера.', '{0}: Telegram did not respond within 15 seconds. Check access to api.telegram.org from this computer.'],
  ['{0}: не удалось найти api.telegram.org через DNS. Проверь подключение к интернету и настройки DNS.', '{0}: DNS could not resolve api.telegram.org. Check your internet connection and DNS settings.'],
  ['{0}: ошибка проверки HTTPS-сертификата. Проверь дату компьютера и настройки антивируса или прокси; не отключай проверку сертификатов.', '{0}: HTTPS certificate validation failed. Check the computer’s date and antivirus or proxy settings; keep certificate validation enabled.'],
  ['{0}: не удалось подключиться к Telegram. Проверь интернет, ограничения сети, VPN или прокси. Работа приложения Telegram сама по себе не проверяет доступ терминала к Bot API.', '{0}: could not connect to Telegram. Check your internet connection, network restrictions, VPN, or proxy. A working Telegram app does not confirm terminal access to the Bot API.'],
  ['Нужен полный токен выбранного бота из BotFather, содержащий двоеточие.', 'Enter the full token for the selected bot from BotFather, including the colon.'],
  ['Нужен тот же webhook secret, который сохранён в Wrangler, без пробелов и кавычек.', 'Enter the same webhook secret saved in Wrangler, without spaces or quotes.'],
  ['Введён токен другого бота. Нужен токен @{0}, указанного в настройках.', 'This token belongs to a different bot. Enter the token for @{0}, as specified in the settings.'],
  ['У этого бота уже настроен другой webhook. Подключение сохранено; сообщи об этом перед его заменой.', 'This bot already has a different webhook. The existing connection has been preserved; review it before replacing it.'],
  ['Подключаю передачу сообщений Telegram к Worker…', 'Connecting Telegram message delivery to the Worker…'],
  ['Telegram не подтвердил регистрацию webhook.', 'Telegram did not confirm webhook registration.'],
  ['Адрес webhook после записи отличается от настроенного. Проверь, не перенастраивает ли бота другая программа.', 'The webhook URL differs from the configured URL after registration. Check whether another program is reconfiguring this bot.'],
  ['Webhook зарегистрирован: {0}', 'Webhook registered: {0}'],
  ['Сообщений в очереди Telegram: {0}', 'Updates waiting in Telegram: {0}'],
  ['Telegram хранит последнюю ошибку доставки. Проверь, приходят ли новые сообщения; при сбое сообщи об этом.', 'Telegram reports a previous delivery error. Check whether new messages arrive and investigate if delivery fails.'],
  ['Теперь откройте личный чат управляющего бота и отправьте /start. Ответ подтвердит webhook и secret.', 'Open the manager bot in a private chat and send /start. Its response will confirm the webhook and secret.'],
];

const telegramErrors = [
  ['Telegram отклонил токен. Скопируй действующий токен выбранного бота у @BotFather.', 'Telegram rejected the token. Copy the selected bot’s current token from @BotFather.'],
  ['Telegram не нашёл бота по этому токену. Проверь, что скопирован весь токен из @BotFather.', 'Telegram did not find a bot for this token. Check that you copied the entire token from @BotFather.'],
  ['Конфликт подключения: бот уже получает обновления через webhook или другой запущенный процесс. Не отключай его вслепую.', 'Connection conflict: this bot already receives updates through a webhook or another running process. Inspect the existing connection before changing it.'],
  ['Telegram временно ограничил запросы. Подожди и повтори проверку позже.', 'Telegram temporarily limited requests. Wait and retry the check later.'],
  ['Telegram вернул ошибку или некорректный ответ. Пришли эту строку для диагностики.', 'Telegram returned an error or invalid response. Use this line for diagnostics.'],
];
for (const [ru, en] of telegramErrors) BOOTSTRAP_COPY.push([ru, en], [`{0}: код {1}. ${ru}`, `{0}: code {1}. ${en}`]);

export const BOOTSTRAP_STAGES = [
  ['Миграции основной D1', 'Main D1 migrations'], ['Миграции D1 монитора', 'Monitor D1 migrations'],
  ['Первый deploy основного Worker', 'Initial main Worker deployment'], ['Deploy Worker монитора', 'Monitor Worker deployment'],
  ['Основной Worker с monitor bindings', 'Main Worker with monitor bindings'], ['Webhook Админушки', 'Manager bot webhook'],
];
for (const [ru, en] of BOOTSTRAP_STAGES) BOOTSTRAP_COPY.push(
  [ru, en], [`→ ${ru}`, `→ ${en}`], [`✓ ${ru}`, `✓ ${en}`], [`✓ ${ru}: уже выполнено`, `✓ ${en}: already completed`]);

export const BOOTSTRAP_HELP = 'Мастер первого запуска Freeflare Desk\n\n  npm run setup\n  node scripts/bootstrap.mjs ИМЯ\n  node scripts/bootstrap.mjs ИМЯ --status-bot\n\nПервый шаг — выбор языка: Русский или English.\nНужны Windows, Node.js 22.13+, новая Админушка и группа с темами.\nМастер поможет войти в Cloudflare, продолжить прерванную установку и подключить статус алерт-бота.\n--status-bot подключает только Telegram Serverless к установке, уже созданной этим мастером.';
BOOTSTRAP_COPY.push([BOOTSTRAP_HELP, 'Freeflare Desk first-run wizard\n\n  npm run setup\n  node scripts/bootstrap.mjs NAME\n  node scripts/bootstrap.mjs NAME --status-bot\n\nThe first step is language selection: English or Russian.\nRequires Windows, Node.js 22.13+, a new manager bot, and a group with topics.\nThe wizard helps you sign in to Cloudflare, resume an interrupted installation, and connect alert bot status.\n--status-bot connects only Telegram Serverless to an installation already created by this wizard.']);

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = BOOTSTRAP_COPY.map(([ru, en]) => {
  const slots = [...ru.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1]));
  const pattern = new RegExp(`^${ru.split(/\{\d+\}/).map(escape).join('([\\s\\S]*?)')}$`);
  return { ru, en, slots, pattern };
}).sort((left, right) => right.ru.replace(/\{\d+\}/g, '').length - left.ru.replace(/\{\d+\}/g, '').length);

export function createBootstrapText(locale) {
  if (!['ru', 'en'].includes(locale)) throw new Error('Unsupported setup language');
  return value => {
    if (typeof value !== 'string' || locale === 'ru') return value;
    for (const { en, slots, pattern } of templates) {
      const match = pattern.exec(value);
      if (!match) continue;
      const values = Object.fromEntries(slots.map((slot, index) => [slot, match[index + 1]]));
      return en.replace(/\{(\d+)\}/g, (_match, slot) => values[slot]);
    }
    return value;
  };
}

export async function selectBootstrapLanguage({ ask, log }) {
  log('Язык / Language\n  1. Русский\n  2. English');
  while (true) {
    const answer = await ask('Выберите / Choose', '1');
    if (answer === '1' || answer === 'ru') return 'ru';
    if (answer === '2' || answer.toLowerCase() === 'en') return 'en';
    log('Введите 1 или 2 / Enter 1 or 2.');
  }
}
