# Архив: первоначальная установка со статическим сервисным ботом

> Этот документ сохраняет подробности прежнего пути с `BOT_REGISTRY`, командами General и ручным маршрутом алертов. Для новой установки используйте [актуальное руководство](DEPLOY_FIRST_TIME_RU.md). Отдельные команды и версии миграций ниже могут не соответствовать текущему коду.

Это руководство подготавливает обе базы и оба Worker. До начала работы с обращениями обязательно подключите отдельного управляющего бота по [инструкции установки Админушки](MANAGER_BOT_SETUP_RU.md). Все рабочие экраны и подключение следующих сервисов находятся в её личном чате.

Инструкция для текущего проекта и Windows PowerShell. Пути, ID, версии инструментов и настройки своего аккаунта сверяйте перед запуском.

Перед публикацией выполните `npm.cmd test`, `node scripts/validate-d1-migrations.mjs` и `node scripts/validate-wrangler.mjs`. Число тестов меняется вместе с кодом; локальные проверки не подтверждают права Telegram и доставку на живом аккаунте.

После публикации бот работает на Cloudflare автоматически. Компьютер и терминал можно выключать. Команда `deploy` отправляет файлы из текущей локальной папки, включая последние исправления. Публикация на GitHub для этого не требуется. [Развёртывание Workers](https://developers.cloudflare.com/workers/get-started/guide/).

Порядок рассчитан на первый запуск с **новыми пустыми базами**. Если база с таким именем уже существует и содержит данные, переходи к [инструкции обновления существующей БД](DATABASE_SETUP.md). Не удаляй её и не запускай начальную схему поверх существующих таблиц.

## 1. Открой PowerShell и войди в Cloudflare

Открой меню «Пуск», найди PowerShell и запусти его. Права администратора не нужны. Все команды ниже выполняй из одной папки:

```powershell
Set-Location -LiteralPath 'C:\path\to\SupportDeskTg'
node --version
npm.cmd --version
```

На твоём компьютере уже обнаружены Node.js 22.22.0 и npm 11.13.0. Для тестов проекта нужен Node.js 22.13 или новее с поддержкой `node:sqlite`.

```powershell
npx.cmd --yes wrangler@4.128.0 login
```

Откроется браузер. Войди в нужный [аккаунт Cloudflare](https://dash.cloudflare.com/) и подтверди доступ. Затем:

```powershell
npx.cmd --yes wrangler@4.128.0 whoami
```

Сохрани **Account ID** нужного аккаунта. Это идентификатор аккаунта, не секретный токен и не ID базы.

В командах закреплена версия Wrangler, которой уже проверена сборка проекта. Суффикс `.cmd` позволяет запускать npm/npx в Windows без изменения политики PowerShell.

Команды запускай по очереди, дожидаясь завершения каждой. При ошибке сначала разбери её, затем продолжай. Секреты вводи только у себя; мне присылай сообщение об ошибке без токенов и ключей.

## 2. Подготовь Telegram

Для начала достаточно одного бота поддержки. Дополнительно рекомендую отдельного бота уведомлений: он сможет отправлять предупреждения, когда у основного бота возникло ограничение Telegram.

1. Открой официального [@BotFather](https://t.me/BotFather).
2. Командой `/newbot` создай бота поддержки. Если нужный бот уже создан, используй его.
3. Сохрани его **token** и **username**. Username нужен без `@`.
4. В BotFather открой **/mybots → нужный бот → Bot Settings**: включи **Allow Groups** (или `/setjoingroups` → **Enable**), выключи **Group Privacy** (или `/setprivacy` → **Disable**, рекомендуемая настройка) и включи **Group Admin Rights → Manage Group**.
5. Создай Telegram-группу для поддержки, включи в её настройках **Темы / Topics**. В ней появится общая тема **General / Общее**.
6. Добавь бота поддержки администратором. Включи права **Управление темами / Manage Topics** и **Закрепление сообщений / Pin Messages**; разреши отправку сообщений и медиа. Разрешение удаления сообщений пригодится для служебной очистки.
7. При желании создай второго бота через `/newbot` для предупреждений и сохрани токен. После установки Админушки его можно подключить через **Алерты** и выбрать доставку в топик группы либо в личку администратора и операторов. Для личного режима добавлять его в группу не нужно; в список сервисов поддержки его не добавляй.
8. В General пиши от своего личного аккаунта. Отключи у себя «Анонимность администратора», чтобы бот мог распознать главного оператора.

Group Admin Rights в BotFather задаёт предлагаемые права при добавлении, но не меняет права в существующей группе: проверь их в самой группе на шаге 6. Бот-администратор получает сообщения и при включённом Group Privacy; выключение здесь — рекомендуемый профиль настройки, а не дополнительное обязательное условие для администратора.

Если отдельный бот уведомлений пока не нужен, на соответствующих шагах можно использовать токен основного. Тогда ограничение этого бота затронет и предупреждения. Доступ бота к сообщениям группы описан в [Telegram FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get).

## 3. Узнай свой Telegram ID и ID группы

Этот шаг выполняется **до подключения webhook**. В General отправь от себя команду `/setup` — ответа пока не будет. Затем выполни в PowerShell из папки проекта:

```powershell
node scripts/telegram-setup.mjs
```

Вставь **токен бота поддержки** и нажми Enter. Символы при вводе не отображаются — это нормально. Скрипт по очереди проверит токен, существующий webhook и сообщение `/setup`. При ошибке он покажет код и понятную причину, скрывая токен. Токен не сохраняется в файл и не передаётся Cloudflare. Для отмены нажми `Ctrl+C`.

Найди строку своего сообщения в нужной группе:

| Результат | Куда понадобится |
| --- | --- |
| `UserId` — положительное число | `ADMIN_IDS` |
| `GroupId` — отрицательное число, обычно начинается с `-100` | `SUPPORT_GROUP_ID`; также `ALERT_CHAT_ID`, если используешь начальную настройку алертов через файл |
| `IsForum = True` | Подтверждает, что темы включены |
| `SentAsChat` пустое | Сообщение отправлено от личного аккаунта |

Если сообщение не найдено, заново отправь `/setup` в General и повтори команду. Если найден существующий webhook, сначала выясни, где уже работает бот: скрипт его не отключает. Команда не подтверждает и не удаляет накопленные обновления. Получение обновлений через `getUpdates` и webhook взаимоисключающие. [Telegram Bot API](https://core.telegram.org/bots/api#getupdates).

## 4. Определи будущий адрес Worker и создай Turnstile

В Cloudflare открой **Workers & Pages**. Найди **Your subdomain** и настрой поддомен `workers.dev`, если его ещё нет. Например, если поддомен аккаунта `example`, адрес нашего Worker будет:

```text
https://telegram-private-chatbot.example.workers.dev
```

`example` здесь только пример: используй свой поддомен. Имя Worker `telegram-private-chatbot` уже задано в проекте. На первом запуске можно использовать этот адрес без покупки домена. [Настройка workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

Теперь в Cloudflare открой **Turnstile → Add widget**:

1. Имя — любое понятное, например `Telegram Support`.
2. В Hostname management добавь полный hostname Worker, например `telegram-private-chatbot.example.workers.dev`, **без `https://` и без пути**.
3. Режим — **Managed**.
4. Pre-clearance оставь выключенным.
5. Нажми Create и сохрани **Site Key** и **Secret Key**. [Создание Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/).

Site Key — публичная настройка для файла. Secret Key — секрет для отдельной команды ниже. Значение `support_verify` уже настроено в коде и конфигурации; отдельное поле action в панели Turnstile искать не нужно.

## 5. Создай две базы данных

Команды создают облачные базы. Если Wrangler предложит автоматически дописать binding в конфигурацию, откажись от автоматического добавления: блоки уже есть, ниже заменяем только их ID.

```powershell
npx.cmd --yes wrangler@4.128.0 d1 create telegram-support --config wrangler.toml
```

Сохрани выданный `database_id` как **ID базы поддержки**.

```powershell
npx.cmd --yes wrangler@4.128.0 d1 create support-monitor --config monitor/wrangler.toml
```

Сохрани второй `database_id` как **ID базы мониторинга**. Это разные значения. Если имя занято, сначала выясни, что это за база. [Создание D1](https://developers.cloudflare.com/d1/get-started/).

## 6. Заполни основной wrangler.toml

Открой файл в редакторе, например:

```powershell
notepad.exe .\wrangler.toml
```

Заменяй значения **в существующих строках**, сохраняя кавычки. Не добавляй второй блок `[vars]` или вторую базу.

| Поле | Твоё значение |
| --- | --- |
| `SUPPORT_GROUP_ID` | ID группы из шага 3 |
| `ADMIN_IDS` | Только твой личный числовой ID из шага 3 |
| `PUBLIC_BASE_URL` | Полный `https://…workers.dev` из шага 4, без завершающего `/` |
| `TURNSTILE_SITE_KEY` | Site Key из шага 4 |
| `database_id` в `[[d1_databases]]` | ID базы `telegram-support` |
| `username` внутри `BOT_REGISTRY` | Username бота поддержки без `@` |
| `displayName` и `topicPrefix` | Название сервиса, которое хочешь видеть в Telegram |

Для первого запуска оставь технический `id` сервиса **`folder-links`**, `tokenBinding = BOT_FOLDER_LINKS_TOKEN` и `webhookSecretBinding = BOT_FOLDER_LINKS_WEBHOOK_SECRET` внутри JSON как есть. Так команды ниже совпадут с конфигурацией. Это внутренние имена, они не обязаны совпадать с названием твоего сервиса.

Оставь `RECOVERY_D1_PLAN = "free"`, если аккаунт на Free. Смена этого значения не покупает платный тариф. Остальные ограничения и флаги оставь как в проекте, включая `STORAGE_GUARD_ENABLED = "true"`. Если другие проекты аккаунта уже используют Rate Limiting namespace ID `1001`–`1005`, выбери пять свободных разных чисел; иначе оставь текущие.

**Для первого deploy временно отключи связь с ещё не созданным монитором.** В самом конце этого файла поставь `#` перед всеми строками обоих блоков:

```toml
# [[services]]
# binding = "STORAGE_MONITOR"
# service = "telegram-support-usage-monitor"
# entrypoint = "StorageHealth"

# [[services]]
# binding = "USER_ACCESS_ALERTS"
# service = "telegram-support-usage-monitor"
# entrypoint = "UserAccessAlerts"

# [[services]]
# binding = "ALERT_SETTINGS"
# service = "telegram-support-usage-monitor"
# entrypoint = "AlertSettings"
```

Сохрани файл. На шаге 10 включим все три блока обратно.

## 7. Заполни monitor/wrangler.toml и создай токен Cloudflare

```powershell
notepad.exe .\monitor\wrangler.toml
```

| Поле | Твоё значение |
| --- | --- |
| `CF_ACCOUNT_ID` | Account ID из шага 1 |
| `ALERT_CHAT_ID` | ID группы из шага 3, только для начального маршрута алертов через файл |
| `database_id` | ID базы `support-monitor` |

Поля `ALERT_CHAT_ID` и `ALERT_THREAD_ID` нужны только для начального маршрута через конфигурацию. После подключения алерт-бота в интерфейсе маршрут выбирается через **Админушка → Алерты** без ручной правки TOML. Если сначала используешь файл, для отдельного топика возьми его `ThreadId` командой `/setup alerts` и `node scripts/telegram-setup.mjs`; `ALERT_CHAT_ID` должен быть ID всей группы. Для General `ALERT_THREAD_ID` не задают.

Оставь `MONITOR_HEALTH_ENABLED = "true"` и `MONITOR_RUNTIME_ENABLED = "false"`. Основные проверки доставки, webhook и размеров баз работают независимо от дополнительной проверки CPU.

Имена `SUPPORT_PLAN`, `SUPPORT_HEALTH` и их `service` оставь как есть. Сохрани файл.

Для чтения аналитики и размеров баз создай **один** API token:

1. Cloudflare → профиль → **My Profile → API Tokens → Create Token → Custom token**.
2. Название, например `Telegram Support Monitor`.
3. Два разрешения: **Account → Account Analytics → Read** и **Account → D1 → Read**.
4. Account Resources: **Include → Specific account → твой аккаунт**.
5. Создай токен и сохрани его. Для этого сценария не задавай ограничение IP своим домашним адресом: запросы делает Cloudflare Worker.

Токен с обоими правами сохранится как `CF_ANALYTICS_TOKEN`; код использует его и для D1. Отдельный `CF_D1_READ_TOKEN` при таком варианте не нужен. Global API Key не требуется. [Создание API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [права аналитики](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/), [чтение списка D1](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/).

## 8. Создай структуру баз и добавь секреты

Сначала проверь миграции на временных локальных базах командой `node scripts/validate-d1-migrations.mjs`. Затем команды создадут таблицы в новых облачных базах. Перед подтверждением Wrangler проверь имя и ID каждой базы:

```powershell
npx.cmd --yes wrangler@4.128.0 d1 migrations apply telegram-support --remote --config wrangler.toml
```

```powershell
npx.cmd --yes wrangler@4.128.0 d1 migrations apply support-monitor --remote --config monitor/wrangler.toml
```

В новой основной базе применяются миграции `0023`–`0052`, в мониторинге — `0005_initial_schema.sql` и `0006_alert_delivery_config.sql`. Уже выполненные файлы пропускаются. Не импортируй SQL вручную: `migrations apply` также записывает факт применения схемы. [Миграции D1](https://developers.cloudflare.com/d1/reference/migrations/).

Теперь придумай случайный webhook secret. Можно создать его локально:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
```

Скопируй полученную строку из 64 символов в менеджер паролей: она понадобится дважды. Это отдельный секрет, не токен BotFather. Значение выведется на экран — не прикладывай его к скриншотам.

Добавь секреты основного Worker. Каждую команду запускай отдельно, затем вставляй запрошенное значение:

```powershell
npx.cmd --yes wrangler@4.128.0 secret put BOT_FOLDER_LINKS_TOKEN --config wrangler.toml
```

Вставь токен **бота поддержки**.

```powershell
npx.cmd --yes wrangler@4.128.0 secret put BOT_FOLDER_LINKS_WEBHOOK_SECRET --config wrangler.toml
```

Вставь сгенерированную строку webhook secret.

```powershell
npx.cmd --yes wrangler@4.128.0 secret put TURNSTILE_SECRET_KEY --config wrangler.toml
```

Вставь **Secret Key** Turnstile, не Site Key.

Создай ключ для добавления следующих ботов через Telegram:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\initialize-bot-registry-key.ps1
if ($LASTEXITCODE -ne 0) { throw 'Ключ подключения ботов не настроен.' }
```

Скрипт сам создаст и сохранит `BOT_REGISTRY_KEY`, не выводя значение. Это отдельный ключ шифрования, не токен бота. Существующий ключ не заменяется. [Подробности и резервная копия ключа](BOT_REGISTRATION_RU.md#13-ключ-для-хранения-токенов).

Теперь секреты монитора:

```powershell
npx.cmd --yes wrangler@4.128.0 secret put CF_ANALYTICS_TOKEN --config monitor/wrangler.toml
```

Вставь API token Cloudflare с двумя правами чтения из шага 7.

Только если создал бота уведомлений и начинаешь с маршрута через файл, выполни команду и введи его токен:

```powershell
npx.cmd --yes wrangler@4.128.0 secret put ALERT_BOT_TOKEN --config monitor/wrangler.toml
```

Если подключишь алерт-бота только через **Админушка → Алерты**, этот старый секрет не нужен. В обоих случаях до публикации монитора создай ключ для хранения токена из интерфейса:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\initialize-alert-config-key.ps1
```

Скрипт не заменяет существующий ключ; сохрани его локальную резервную копию по [инструкции Админушки](MANAGER_BOT_SETUP_RU.md#алерт-бот).

При первом добавлении секрета Wrangler может предложить создать Worker с указанным именем. Подтверждай только ожидаемое имя: `telegram-private-chatbot` или `telegram-support-usage-monitor`. Добавление секрета сохраняет его в облаке; полная публикация кода ниже всё равно нужна. Для уже существующего Worker `secret put` сразу создаёт и развёртывает новую версию с изменённым секретом. [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## 9. Проверь настройки и опубликуй основного бота

Выполни поиск незаполненных значений:

```powershell
Select-String -Path .\wrangler.toml, .\monitor\wrangler.toml -Pattern 'REPLACE_WITH_', '-1000000000000'
```

Совпадений в строках настроек быть не должно. Комментарий с общим пояснением сам по себе ошибкой не является.

Проверка сборки с заполненными конфигурациями:

```powershell
node scripts/validate-wrangler.mjs
```

Ожидаются два сообщения `dry-run OK`. Это проверка сборки; она не проверяет реальные права Telegram, наличие облачных секретов или доступ к аналитике.

Теперь команда **публикует основного бота на Cloudflare**:

```powershell
npx.cmd --yes wrangler@4.128.0 deploy --config wrangler.toml
```

В конце появится адрес Worker. Он должен в точности совпадать с `PUBLIC_BASE_URL`. Если отличается, исправь `PUBLIC_BASE_URL` и hostname в Turnstile, сохрани и повтори deploy. Webhook подключай уже к окончательному адресу.

## 10. Опубликуй монитор и включи связь между Worker

Команда публикует монитор:

```powershell
npx.cmd --yes wrangler@4.128.0 deploy --config monitor/wrangler.toml
```

После успешной публикации верни в конец основного `wrangler.toml` все три блока из шага 6, убрав `#`:

```toml
[[services]]
binding = "STORAGE_MONITOR"
service = "telegram-support-usage-monitor"
entrypoint = "StorageHealth"

[[services]]
binding = "USER_ACCESS_ALERTS"
service = "telegram-support-usage-monitor"
entrypoint = "UserAccessAlerts"

[[services]]
binding = "ALERT_SETTINGS"
service = "telegram-support-usage-monitor"
entrypoint = "AlertSettings"
```

Сохрани файл и опубликуй основного Worker повторно:

```powershell
npx.cmd --yes wrangler@4.128.0 deploy --config wrangler.toml
```

Порядок **основной без связей → монитор → основной со связями** нужен только при первой установке этих связей. Он позволяет каждому Worker найти уже опубликованный сервис другого.

Фоновые задачи уже включены конфигурацией: у основного бота каждые 5 минут, у монитора каждые 15 минут. Отдельно создавать расписание в панели не нужно. Распространение нового Cron Trigger может занять до 15 минут. [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

До следующего шага монитор может сообщить, что webhook пока отсутствует: подключаем его сейчас.

## 11. Подключи Telegram к опубликованному боту

Webhook — адрес, на который Telegram будет передавать входящие сообщения. Следующая команда **включает доставку на новый Worker**. Адрес и имя бота она берёт из заполненного `wrangler.toml`:

```powershell
node scripts/telegram-webhook.mjs
```

Команда попросит два значения, ввод скрыт: сначала токен бота поддержки из BotFather, затем **тот же** webhook secret, который ты сохранил в Cloudflare на шаге 8. Новую случайную строку на этом шаге генерировать не нужно. Если сохранённый секрет потерян, сначала обнови секрет Worker отдельной командой из шага 8 и используй это же новое значение здесь.

Ожидается сообщение `Webhook зарегистрирован` и адрес, заканчивающийся на `/tg/folder-links`. Сохранённые Telegram сообщения не отбрасываются. При токене другого бота или существующем другом webhook команда остановится до изменения подключения. Успех `setWebhook` подтверждает регистрацию адреса; реальную доставку проверяет следующий шаг. [Настройка webhook](https://core.telegram.org/bots/api#setwebhook).

Боту уведомлений webhook не нужен: он только отправляет сообщения. После настройки Админушки следующие сервисы подключаются через **Управление ботами поддержки → Добавить сервисного бота**; вручную править `BOT_REGISTRY` и публиковать Worker для каждого нового бота не требуется.

## 12. Подключи Админушку и проверь работу в Telegram

Выполни [установку управляющего бота](MANAGER_BOT_SETUP_RU.md): создай его в BotFather, добавь администратором группы, задай `MANAGER_BOT_USERNAME`, `MANAGER_BOT_TOKEN` и `MANAGER_WEBHOOK_SECRET`, опубликуй основной Worker и зарегистрируй webhook `/tg/manager`. Если на шаге 10 при первом deploy пришлось временно отключить связи с монитором, восстанови также `ALERT_SETTINGS` вместе с `STORAGE_MONITOR` и `USER_ACCESS_ALERTS`, затем опубликуй основной Worker повторно.

Отправь `/start` в личку Админушки. Открой **Управление ботами поддержки → сервис** и проверь его готовность. В **План и хранилище → План Cloudflare** проверь тариф, а в **Хранилище** выбери группу и дождись измерений монитора. Доступ к работе с пользователями и операторами — в том же личном меню. `/storage` в General при подключённой Админушке не работает.

Затем с другого личного Telegram-аккаунта, например с помощью знакомого, проверь обращение:

1. Напиши боту поддержки обычный текст.
2. В группе должна появиться отдельная тема с сообщением.
3. Ответь из этой темы — ответ должен прийти в личный чат отправителя.
4. Проверь фото, файл, альбом из нескольких фото и ответ на конкретное сообщение.
5. Закрой тему командой `/close@имя_управляющего_бота` внутри неё или кнопкой карточки Админушки. Новое сообщение пользователя должно снова открыть обращение.
6. Добавь второго оператора через **Админушка → Операторы**, если он нужен. Права администратора Telegram сами по себе не делают человека оператором программы.

Двусторонние реакции включаются автоматически после успешной проверки обоих направлений в карточке сервиса. Одного `message_reaction` в webhook недостаточно. [Порядок проверки](MANAGER_BOT_SETUP_RU.md#подключение-сервиса-и-группы).

Проверка Turnstile перед приглашением пользователей: временно поменяй у сервиса `verification_mode` с `adaptive` на `always`, сохрани и выполни deploy основного Worker. Напиши боту с новым аккаунтом, у которого ещё нет обращения. Открой предложенную проверку, пройди её и убедись, что сообщение дошло. Затем верни `adaptive` и снова выполни deploy. Уже существующее обращение не подходит для этого теста.

## 13. Проверь канал уведомлений и реальные измерения

Следующий блок отправит одно тестовое сообщение от бота уведомлений в выбранный топик. Он проверяет токен и доступ к группе и топику:

```powershell
$alertToken = [System.Net.NetworkCredential]::new('', (Read-Host 'Токен бота уведомлений' -AsSecureString)).Password
$alertChat = (Read-Host 'ID группы, тот же ALERT_CHAT_ID').Trim()
$alertThread = (Read-Host 'ID топика, тот же ALERT_THREAD_ID; для General оставь пустым').Trim()
try {
    $alertPayload = @{ chat_id = $alertChat; text = 'Support monitor: notification test OK' }
    if ($alertThread) {
        if ($alertThread -notmatch '^[1-9][0-9]*$') { throw 'Topic ID must be a positive integer' }
        $alertPayload.message_thread_id = [long]$alertThread
    }
    $alertBody = $alertPayload | ConvertTo-Json
    $alertResult = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$alertToken/sendMessage" -ContentType 'application/json' -Body $alertBody
    $alertResult | Select-Object ok, description | Format-List
} catch {
    Write-Warning 'Тест уведомления не отправлен. Проверь токен, ID группы и право бота отправлять сообщения.'
} finally {
    Remove-Variable alertToken, alertBody -ErrorAction SilentlyContinue
}
```

Сам по себе этот тест не доказывает, что монитор прочитал Cloudflare. Для этого открой его логи:

```powershell
npx.cmd --yes wrangler@4.128.0 tail --config monitor/wrangler.toml
```

Оставь окно на несколько циклов фоновой проверки, ориентировочно 30–60 минут после первого deploy. Проверки чередуются, поэтому один цикл может не успеть собрать всё. В Cloudflare также можно открыть Worker и посмотреть сохранённые логи в Observability.

Проверь, что:

- периодически появляется `monitor_check_complete` с подходящим планом и правдоподобными счётчиками; на новом аккаунте нулевой расход возможен;
- нет повторяющихся `monitor_check_failed`, ошибок доступа `401`/`403` и сообщений о несовместимых полях аналитики;
- **Хранилище** в личке управляющего бота → «Использование места» показывает обе базы и свежие измерения;
- счётчики согласуются с Cloudflare Dashboard за тот же период с учётом задержки аналитики.

Набор доступных полей аналитики зависит от аккаунта. Эту проверку нельзя заменить локальными тестами. Подробности: [документация монитора](monitor/README.md#обязательная-live-проверка-graphql).

`Ctrl+C` завершает просмотр логов, **бот продолжает работать**. Основного бота можно смотреть отдельной командой:

```powershell
npx.cmd --yes wrangler@4.128.0 tail --config wrangler.toml
```

Монитор сообщает о выявленных проблемах, а не обрабатывает каждое сообщение мгновенно. При полном отказе всего Cloudflare-аккаунта он тоже может перестать работать. Настройки и границы мониторинга описаны в [инструкции эксплуатации](OPERATIONS_RETENTION.md).

## Если что-то не получилось

| Симптом | Что проверить |
| --- | --- |
| Ошибка service / entrypoint not found при deploy | Соблюдён ли шаг 10; для первого основного deploy временно отключены все три связи с монитором |
| `table already exists` при начальной схеме | База не пустая. Используй инструкцию перехода БД, не удаляй таблицы |
| `no such table` в работающем боте | Применена ли схема с `--remote`, совпадает ли `database_id` |
| В webhook последняя ошибка 403 | Совпадают ли секрет в Cloudflare и `secret_token`, выбран ли правильный `/tg/folder-links` |
| Сообщения не приходят | Правильный ли URL webhook, уменьшается ли `pending_update_count`, доступны ли секреты и база; посмотри логи |
| `/selfcheck` сообщает проблему тем | Бот должен быть администратором именно нужной группы с правом Manage Topics |
| Команды владельца не работают | Правильный ли `ADMIN_IDS`, открыт ли личный чат Админушки через `/start`, совпадают ли её токен и webhook |
| Turnstile не открывается / отклоняет проверку | Совпадают ли URL Worker, разрешённый hostname, Site Key и Secret Key |
| Монитор не видит размер баз | Есть ли право D1 Read у его токена, правильный ли Account ID, прошли ли циклы измерения |
| В браузере основной Worker показывает `Not found` | Для корневой страницы это ожидаемо: управление находится в Telegram, а проверка человека открывается по выданной ботом ссылке |

При разборе ошибок сохраняй действующие настройки. Повторное создание баз и удаление очереди Telegram не являются обычными шагами диагностики.

## Как запускать и обновлять дальше

После шагов 1–13 запуск завершён. Worker принимает сообщения по webhook, а фоновые задачи выполняются по расписанию. Открытый терминал, `npm start` или `wrangler dev` для этого не нужны.

Если бот уже запущен, используй [инструкцию обновления БД](DATABASE_SETUP.md) и [инструкцию Админушки](MANAGER_BOT_SETUP_RU.md): резервная копия → недостающие миграции → проверка конфигурации → публикация нужного Worker. Не заменяй существующие ключи шифрования.

При следующем обновлении кода сначала выполни локальные проверки. Если появилась новая миграция, перед её применением сделай экспорт существующей базы и следуй инструкции обновления. Для обновления только кода без изменений схемы или связей сервисов достаточно соответствующего deploy:

```powershell
npx.cmd --yes wrangler@4.128.0 deploy --config wrangler.toml
```

```powershell
npx.cmd --yes wrangler@4.128.0 deploy --config monitor/wrangler.toml
```

Выполняй вторую команду, когда менялся монитор. Повторно создавать базы и секреты не нужно; webhook переустанавливается при изменении адреса, секрета или подписки на обновления. Изменённые обычные значения в TOML начинают действовать после deploy. Сохрани настроенные файлы и секреты, чтобы следующие обновления использовали тот же аккаунт и те же базы.
